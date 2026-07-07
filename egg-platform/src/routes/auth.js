const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sign, authRequired, roleRequired } = require('../middleware/auth');
const otpStore = require('../services/otp');
const sms = require('../services/sms');
const wechat = require('../services/wechat');

const router = express.Router();

// ========= 审核员测试账号（提审期间用）=========
// 形态：固定手机号 + 固定验证码，伪装成正常 SMS 登录流程，前端不需展示特殊入口。
// 审核员在提审说明里看到「测试账号 13800000001 / 验证码 888888」，
// 直接在普通手机号登录框输入即可。审核通过后删整段。
const TEST_PHONES = {
  '13800000001': { otp: '888888', role: 'buyer', name: '审核员·采购方', license_status: 'none' },
  '13800000002': { otp: '888888', role: 'farm',  name: '审核员·养殖场', license_status: 'approved' },
};

function ensureTestUser(phone) {
  const cfg = TEST_PHONES[phone];
  if (!cfg) return null;
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    const info = db.prepare(`
      INSERT INTO users (phone, role, name, license_status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(phone, cfg.role, cfg.name, cfg.license_status, Date.now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  return user;
}

router.post('/admin-login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '缺少账号或密码' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.password) return res.status(401).json({ error: '账号不存在或未设置密码' });
  if (user.role !== 'admin') return res.status(403).json({ error: '该账号非管理员' });
  if (user.banned) return res.status(403).json({ error: '账户已被冻结' });
  if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: '密码错误' });
  const { password: _p, ...safeUser } = user;
  res.json({ token: sign(user), user: safeUser });
});

router.post('/change-password', authRequired, roleRequired('admin'), (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: '请填写当前密码和新密码' });
  if (String(new_password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!me.password || !bcrypt.compareSync(current_password, me.password)) {
    return res.status(401).json({ error: '当前密码错误' });
  }
  const hashed = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.user.id);
  res.json({ ok: true, message: '密码已修改' });
});

router.get('/login-modes', (req, res) => {
  res.json({
    sms: { live: sms.isLive, provider: sms.provider || 'demo' },
    wechat: { live: wechat.isLive, hint: wechat.isLive ? '' : '未配置 WECHAT_APP_SECRET，演示模式使用沙箱账号' },
  });
});

// 暴露微信订阅消息模板 ID 给小程序，前端用它调用 wx.requestSubscribeMessage
router.get('/notice-templates', (req, res) => {
  const wechatNotify = require('../services/wechat-notify');
  res.json({
    sms: { notice_live: sms.noticeLive },
    wechat: { templates: wechatNotify.templatesPublic(), live: wechatNotify.isLive },
  });
});

// 公开的小程序运行时配置（前端 onLaunch 拉一次）
router.get('/app-config', (req, res) => {
  const settings = require('../services/settings');
  res.json({
    review_mode: !!settings.get('review_mode'),
  });
});

router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
  // 审核员测试号：不调外部 SMS，直接告知验证码格式（号码本身已知）
  if (TEST_PHONES[phone]) {
    return res.json({ ok: true, message: '验证码已发送至 ' + maskPhone(phone) });
  }
  try {
    const r = await sms.send(phone);
    res.json({
      ok: true,
      message: '验证码已发送至 ' + maskPhone(phone),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', (req, res) => {
  const { phone, otp, role, name } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: '缺少手机号或验证码' });
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' });

  // 审核员测试号：匹配固定手机号 + 固定验证码即可登录（无须经过 SMS / otpStore）
  if (TEST_PHONES[phone]) {
    if (otp !== TEST_PHONES[phone].otp) return res.status(400).json({ error: '验证码错误' });
    const user = ensureTestUser(phone);
    if (!user) return res.status(500).json({ error: '测试用户创建失败' });
    if (user.banned) return res.status(403).json({ error: '账户已被冻结' });
    return res.json({ token: sign(user), user });
  }

  // 普通流程
  if (!(otp === '123456' && !sms.isLive)) {
    const check = otpStore.verify(phone, otp);
    if (!check.ok) return res.status(400).json({ error: check.reason });
  }

  const user = upsertUser({ phone, role, name });
  if (user.banned) return res.status(403).json({ error: '账户已被冻结' });

  res.json({ token: sign(user), user });
});

router.post('/wechat-login', async (req, res) => {
  const { code, role, name } = req.body;
  if (!code) return res.status(400).json({ error: '缺少微信登录 code' });
  try {
    const session = await wechat.code2session(code);
    if (!session.openid) return res.status(400).json({ error: '微信换取 openid 失败' });

    let user = db.prepare('SELECT * FROM users WHERE wechat_openid = ?').get(session.openid);
    const requestedRole = ['farm', 'buyer'].includes(role) ? role : null;
    if (!user) {
      const createRole = requestedRole || 'buyer';
      const placeholderPhone = 'wx_' + session.openid.slice(0, 16);
      const info = db.prepare(`
        INSERT INTO users (phone, role, name, license_status, wechat_openid, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        placeholderPhone, createRole, name || (createRole === 'farm' ? '微信养殖场' : '微信采购商'),
        'none', session.openid, Date.now(),
      );
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else if (requestedRole && requestedRole !== user.role && user.role !== 'admin') {
      // 仅切换角色，资质状态保持不变（资质与角色解耦）
      db.prepare('UPDATE users SET role=? WHERE id=?').run(requestedRole, user.id);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    }
    if (user.banned) return res.status(403).json({ error: '账户已被冻结' });

    res.json({
      token: sign(user),
      user,
      demo: !!session.demo,
      needs_phone: !user.phone || user.phone.startsWith('wx_'),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/switch-role', authRequired, (req, res) => {
  const { role } = req.body;
  if (!['farm', 'buyer'].includes(role)) return res.status(400).json({ error: '只能切换为 farm 或 buyer' });
  if (req.user.role === 'admin') return res.status(403).json({ error: '管理员账号不可切换' });
  if (req.user.role === role) {
    return res.json({ ok: true, user: req.user });
  }
  // 资质状态与角色解耦：切换 buy/sell 模式只改 role，不再改动 license_status，
  // 避免切到采购商时把已提交/已通过的资质冲掉（用户既可能是采购商也可能是养殖场）。
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ ok: true, user });
});

router.post('/bind-phone', authRequired, (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: '缺少手机号或验证码' });
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
  if (!(otp === '123456' && !sms.isLive)) {
    const check = otpStore.verify(phone, otp);
    if (!check.ok) return res.status(400).json({ error: check.reason });
  }
  const existing = db.prepare('SELECT id FROM users WHERE phone=? AND id != ?').get(phone, req.user.id);
  if (existing) return res.status(400).json({ error: '该手机号已被其他账号绑定' });
  db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone, req.user.id);
  res.json({ ok: true, user: db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id) });
});

function upsertUser({ phone, role, name }) {
  const requestedRole = ['farm', 'buyer'].includes(role) ? role : null;
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (user) {
    if (requestedRole && requestedRole !== user.role && user.role !== 'admin') {
      // 仅切换角色，资质状态保持不变（资质与角色解耦）
      db.prepare('UPDATE users SET role=? WHERE id=?').run(requestedRole, user.id);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    }
    return user;
  }
  const createRole = requestedRole || 'buyer';
  const info = db.prepare(`
    INSERT INTO users (phone, role, name, license_status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(phone, createRole, name || `用户${phone.slice(-4)}`, 'none', Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function maskPhone(p) { return p.slice(0, 3) + '****' + p.slice(-4); }

router.get('/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

router.post('/location', authRequired, (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: '经纬度无效' });
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ error: '经纬度范围越界' });
  // 主页选择位置带来的名称/详细地址（含省份），用于求购"允许参与地区"匹配。
  // 仅在本次带了文本时更新，避免 GPS 自动上报（无地址）把已选地址覆盖成空。
  const name = req.body.name != null ? String(req.body.name) : null;
  const address = req.body.address != null ? String(req.body.address) : null;
  db.prepare(`
    UPDATE users SET lat=?, lng=?, location_updated_at=?,
      loc_name=COALESCE(?, loc_name), loc_address=COALESCE(?, loc_address)
    WHERE id=?
  `).run(lat, lng, Date.now(), name, address, req.user.id);
  res.json({ ok: true });
});

router.patch('/me', authRequired, (req, res) => {
  const { name, avatar, region, address } = req.body;
  db.prepare(`
    UPDATE users SET
      name = COALESCE(?, name),
      avatar = COALESCE(?, avatar),
      region = COALESCE(?, region),
      address = COALESCE(?, address)
    WHERE id = ?
  `).run(name, avatar, region, address, req.user.id);
  res.json({ user: db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id) });
});

router.post('/qualify', authRequired, (req, res) => {
  // 同一个用户既可能是采购商也可能是养殖场（首页切换 buy/sell 会改 role）。
  // 资质认证是对经营主体的认证，与当前 UI 角色无关 —— 任何登录用户都可提交，
  // 不再用 role 拦截，避免切到采购商时无法提交审核。
  const {
    name, region, address, business_license, contact_name,
    daily_output, main_products, farm_size_int,
    license_photos, farm_photos, quarantine_photos,
  } = req.body;

  if (!name || !contact_name || !address) {
    return res.status(400).json({ error: '请填写鸡场名称/联系人/地址' });
  }
  if (!Array.isArray(license_photos) || !license_photos.length) {
    return res.status(400).json({ error: '请上传营业执照照片' });
  }
  if (!Array.isArray(farm_photos) || farm_photos.length < 1) {
    return res.status(400).json({ error: '请至少上传 1 张鸡场实景照' });
  }

  const fields = {
    name, region, address, business_license, contact_name,
    daily_output: Number(daily_output) || null,
    main_products: main_products || null,
    farm_size_int: Number(farm_size_int) || null,
    license_photos: JSON.stringify(license_photos),
    farm_photos: JSON.stringify(farm_photos),
    quarantine_photos: JSON.stringify(quarantine_photos || []),
  };

  // 已通过的用户重新提交：把新资料存进 license_pending 快照，正式字段不动，
  // 状态改 pending；审核通过时再由 admin 覆盖。其它状态（none/rejected/pending）
  // 没有"在生效的正式资质"需要保护，直接写正式字段。
  if (req.user.license_status === 'approved') {
    db.prepare(`UPDATE users SET license_pending=?, license_status='pending' WHERE id=?`)
      .run(JSON.stringify(fields), req.user.id);
    return res.json({ ok: true, message: '修改已提交，审核通过前仍按现有资质生效' });
  }

  db.prepare(`
    UPDATE users SET
      name=COALESCE(?,name), region=COALESCE(?,region), address=COALESCE(?,address),
      business_license=?, contact_name=?, daily_output=?, main_products=?, farm_size_int=?,
      license_photos=?, farm_photos=?, quarantine_photos=?, license_pending=NULL,
      license_status='pending'
    WHERE id=?
  `).run(
    fields.name, fields.region, fields.address, fields.business_license, fields.contact_name,
    fields.daily_output, fields.main_products, fields.farm_size_int,
    fields.license_photos, fields.farm_photos, fields.quarantine_photos,
    req.user.id,
  );
  res.json({ ok: true, message: '资质已提交，平台 1-3 个工作日内审核' });
});

module.exports = router;
