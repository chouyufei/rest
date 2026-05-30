const express = require('express');
const db = require('../db');
const { sign, authRequired } = require('../middleware/auth');
const otpStore = require('../services/otp');
const sms = require('../services/sms');
const wechat = require('../services/wechat');

const router = express.Router();

router.get('/login-modes', (req, res) => {
  res.json({
    sms: { live: sms.isLive, provider: sms.provider || 'demo' },
    wechat: { live: wechat.isLive, hint: wechat.isLive ? '' : '未配置 WECHAT_APP_SECRET，演示模式使用沙箱账号' },
  });
});

router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
  try {
    const r = await sms.send(phone);
    res.json({
      ok: true,
      demo: !!r.demo,
      message: r.demo ? '演示模式：验证码固定为 123456' : '验证码已发送至 ' + maskPhone(phone),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', (req, res) => {
  const { phone, otp, role, name } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: '缺少手机号或验证码' });
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
  const check = otpStore.verify(phone, otp);
  if (!check.ok) return res.status(400).json({ error: check.reason });

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
    const safeRole = ['farm', 'buyer', 'admin'].includes(role) ? role : 'buyer';
    if (!user) {
      const placeholderPhone = 'wx_' + session.openid.slice(0, 16);
      const info = db.prepare(`
        INSERT INTO users (phone, role, name, license_status, wechat_openid, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        placeholderPhone, safeRole, name || (safeRole === 'farm' ? '微信养殖场' : '微信采购商'),
        safeRole === 'farm' ? 'pending' : 'none', session.openid, Date.now(),
      );
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else if (user.role !== safeRole && user.role !== 'admin' && safeRole !== 'admin') {
      let newLicStatus = user.license_status;
      if (safeRole === 'farm' && (!newLicStatus || newLicStatus === 'none')) newLicStatus = 'pending';
      if (safeRole === 'buyer' && newLicStatus === 'pending') newLicStatus = 'none';
      db.prepare('UPDATE users SET role=?, license_status=? WHERE id=?')
        .run(safeRole, newLicStatus, user.id);
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
  let newLicStatus = req.user.license_status;
  if (role === 'farm' && (!newLicStatus || newLicStatus === 'none')) newLicStatus = 'pending';
  if (role === 'buyer' && newLicStatus === 'pending') newLicStatus = 'none';
  db.prepare('UPDATE users SET role=?, license_status=? WHERE id=?')
    .run(role, newLicStatus, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ ok: true, user });
});

router.post('/bind-phone', authRequired, (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: '缺少手机号或验证码' });
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
  const check = otpStore.verify(phone, otp);
  if (!check.ok) return res.status(400).json({ error: check.reason });
  const existing = db.prepare('SELECT id FROM users WHERE phone=? AND id != ?').get(phone, req.user.id);
  if (existing) return res.status(400).json({ error: '该手机号已被其他账号绑定' });
  db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone, req.user.id);
  res.json({ ok: true, user: db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id) });
});

function upsertUser({ phone, role, name }) {
  const safeRole = ['farm', 'buyer', 'admin'].includes(role) ? role : 'buyer';
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (user) {
    if (user.role !== safeRole && user.role !== 'admin' && safeRole !== 'admin') {
      let newLicStatus = user.license_status;
      if (safeRole === 'farm' && (!newLicStatus || newLicStatus === 'none')) newLicStatus = 'pending';
      if (safeRole === 'buyer' && newLicStatus === 'pending') newLicStatus = 'none';
      db.prepare('UPDATE users SET role=?, license_status=? WHERE id=?')
        .run(safeRole, newLicStatus, user.id);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    }
    return user;
  }
  const info = db.prepare(`
    INSERT INTO users (phone, role, name, license_status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(phone, safeRole, name || `用户${phone.slice(-4)}`, safeRole === 'farm' ? 'pending' : 'none', Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function maskPhone(p) { return p.slice(0, 3) + '****' + p.slice(-4); }

router.get('/me', authRequired, (req, res) => {
  res.json({ user: req.user });
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
  if (req.user.role !== 'farm') return res.status(403).json({ error: '只有养殖场需要资质认证' });
  const {
    name, region, address, business_license, contact_name,
    daily_output, main_products, farm_size_int,
    license_photos, farm_photos, quarantine_photos,
  } = req.body;

  if (!name || !contact_name || !address || !business_license) {
    return res.status(400).json({ error: '请填写鸡场名称/联系人/地址/营业执照编号' });
  }
  if (!Array.isArray(license_photos) || !license_photos.length) {
    return res.status(400).json({ error: '请上传营业执照照片' });
  }
  if (!Array.isArray(farm_photos) || farm_photos.length < 1) {
    return res.status(400).json({ error: '请至少上传 1 张鸡场实景照' });
  }

  db.prepare(`
    UPDATE users SET
      name=COALESCE(?,name),
      region=COALESCE(?,region),
      address=COALESCE(?,address),
      business_license=?,
      contact_name=?,
      daily_output=?,
      main_products=?,
      farm_size_int=?,
      license_photos=?,
      farm_photos=?,
      quarantine_photos=?,
      license_status='pending'
    WHERE id=?
  `).run(
    name, region, address, business_license, contact_name,
    Number(daily_output) || null, main_products || null, Number(farm_size_int) || null,
    JSON.stringify(license_photos), JSON.stringify(farm_photos),
    JSON.stringify(quarantine_photos || []),
    req.user.id,
  );
  res.json({ ok: true, message: '资质已提交，平台 1-3 个工作日内审核' });
});

module.exports = router;
