const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, roleRequired } = require('../middleware/auth');
const { notify } = require('../services/notification');

const router = express.Router();
router.use(authRequired, roleRequired('admin'));

router.get('/admins', (req, res) => {
  const rows = db.prepare(`
    SELECT id, username, name, phone, created_at, banned
    FROM users WHERE role='admin' AND username IS NOT NULL
    ORDER BY created_at ASC
  `).all();
  res.json({ admins: rows });
});

router.post('/admins', (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: '账号需 3-20 位字母数字下划线' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const exists = db.prepare("SELECT id FROM users WHERE username=?").get(username);
  if (exists) return res.status(400).json({ error: '账号已存在' });
  const hashed = bcrypt.hashSync(password, 10);
  const placeholderPhone = 'admin_' + username + '_' + Date.now().toString(36);
  const info = db.prepare(`
    INSERT INTO users (phone, username, password, name, role, license_status, created_at)
    VALUES (?, ?, ?, ?, 'admin', 'none', ?)
  `).run(placeholderPhone, username, hashed, name || username, Date.now());
  const u = db.prepare('SELECT id, username, name, phone, created_at FROM users WHERE id=?').get(info.lastInsertRowid);
  res.json({ ok: true, admin: u });
});

router.post('/admins/:id/reset-password', (req, res) => {
  const { new_password } = req.body;
  if (!new_password || String(new_password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const target = db.prepare("SELECT id, role FROM users WHERE id=?").get(req.params.id);
  if (!target || target.role !== 'admin') return res.status(404).json({ error: '管理员不存在' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(new_password, 10), target.id);
  res.json({ ok: true, message: '密码已重置' });
});

router.delete('/admins/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const target = db.prepare("SELECT id, role, username FROM users WHERE id=?").get(id);
  if (!target || target.role !== 'admin') return res.status(404).json({ error: '管理员不存在' });
  if (target.username === 'admin') return res.status(400).json({ error: '默认 admin 账号不可删除' });
  const remaining = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND banned=0").get().c;
  if (remaining <= 1) return res.status(400).json({ error: '至少要保留 1 个管理员' });
  db.prepare("UPDATE users SET banned=1, username=NULL WHERE id=?").run(id);
  res.json({ ok: true });
});

router.get('/stats', (req, res) => {
  const farmCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='farm'").get().c;
  const buyerCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='buyer'").get().c;
  const activeAuctions = db.prepare("SELECT COUNT(*) c FROM resources WHERE status='auctioning'").get().c;
  const sold = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(current_price),0) gmv FROM resources WHERE status='sold'").get();
  const failed = db.prepare("SELECT COUNT(*) c FROM resources WHERE status='failed'").get().c;
  const total = sold.c + failed;
  const successRate = total === 0 ? 0 : Math.round((sold.c / total) * 100);
  const avgPriceRow = db.prepare("SELECT AVG(current_price) a FROM resources WHERE status='sold'").get();
  const avgPrice = avgPriceRow.a ? Number(avgPriceRow.a.toFixed(2)) : 0;
  const startPriceAvgRow = db.prepare("SELECT AVG(start_price) a, AVG(current_price) b FROM resources WHERE status='sold'").get();
  const premiumRate = startPriceAvgRow && startPriceAvgRow.a
    ? Math.round(((startPriceAvgRow.b - startPriceAvgRow.a) / startPriceAvgRow.a) * 100)
    : 0;
  const openDisputes = db.prepare("SELECT COUNT(*) c FROM disputes WHERE status='open'").get().c;
  res.json({
    farmCount, buyerCount, activeAuctions,
    soldCount: sold.c, failedCount: failed,
    gmv: sold.gmv, avgPrice, successRate, premiumRate, openDisputes,
  });
});

router.get('/users', (req, res) => {
  const { role, status } = req.query;
  let sql = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  if (role) { sql += ' AND role=?'; params.push(role); }
  if (status) { sql += ' AND license_status=?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  res.json({ users: db.prepare(sql).all(...params) });
});

router.post('/users/:id/approve', (req, res) => {
  db.prepare("UPDATE users SET license_status='approved' WHERE id=?").run(req.params.id);
  notify(req.params.id, 'qualify_approved', '资质审核通过', '您的资质已审核通过，现在可以缴纳保证金并发布资源', null);
  res.json({ ok: true });
});

router.post('/users/:id/reject', (req, res) => {
  const { reason } = req.body;
  db.prepare("UPDATE users SET license_status='rejected' WHERE id=?").run(req.params.id);
  notify(req.params.id, 'qualify_rejected', '资质审核未通过', reason || '请重新提交资质', null);
  res.json({ ok: true });
});

router.post('/users/:id/ban', (req, res) => {
  const { ban } = req.body;
  db.prepare('UPDATE users SET banned=? WHERE id=?').run(ban ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.get('/resources', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.name AS farm_name FROM resources r
    JOIN users u ON u.id = r.farm_id
    ORDER BY r.created_at DESC LIMIT 500
  `).all();
  res.json({
    resources: rows.map(r => ({
      ...r,
      photos: r.photos ? JSON.parse(r.photos) : [],
    }))
  });
});

router.post('/resources/:id/takedown', (req, res) => {
  const { reason } = req.body;
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  db.prepare(`UPDATE resources SET status='cancelled' WHERE id=?`).run(r.id);
  notify(r.farm_id, 'resource_takedown', '资源已下架', `「${r.title}」被平台下架：${reason || '违规'}`, r.id);
  res.json({ ok: true });
});

router.get('/deposits', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, u.name AS user_name, u.role AS user_role FROM deposits d
    JOIN users u ON u.id = d.user_id
    ORDER BY d.paid_at DESC LIMIT 500
  `).all();
  res.json({ deposits: rows });
});

router.post('/deposits/:id/deduct', (req, res) => {
  const { amount, reason } = req.body;
  const dep = db.prepare('SELECT * FROM deposits WHERE id=?').get(req.params.id);
  if (!dep) return res.status(404).json({ error: '保证金不存在' });
  db.prepare("UPDATE deposits SET status='deducted', note=?, released_at=? WHERE id=?")
    .run(reason || '扣款', Date.now(), dep.id);
  notify(dep.user_id, 'deposit_deducted', '保证金扣款', `保证金扣款 ${amount || dep.amount} 元：${reason || ''}`, dep.id);
  res.json({ ok: true });
});

router.get('/disputes', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, o.farm_id, o.buyer_id, o.final_price,
      uf.name AS farm_name, ub.name AS buyer_name
    FROM disputes d
    JOIN orders o ON o.id = d.order_id
    JOIN users uf ON uf.id = o.farm_id
    JOIN users ub ON ub.id = o.buyer_id
    ORDER BY d.created_at DESC LIMIT 500
  `).all();
  res.json({ disputes: rows });
});

router.post('/disputes/:id/resolve', (req, res) => {
  const { resolution, side } = req.body;
  const d = db.prepare('SELECT * FROM disputes WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: '纠纷不存在' });
  db.prepare(`UPDATE disputes SET status='resolved', resolution=?, resolved_at=? WHERE id=?`)
    .run(resolution || '', Date.now(), d.id);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(d.order_id);
  if (side === 'buyer') {
    db.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(order.id);
  } else if (side === 'farm') {
    db.prepare(`UPDATE orders SET status='completed', confirmed_at=? WHERE id=?`).run(Date.now(), order.id);
  } else {
    db.prepare(`UPDATE orders SET status='completed', confirmed_at=? WHERE id=?`).run(Date.now(), order.id);
  }
  notify(order.farm_id, 'dispute_resolved', '纠纷已处理', resolution || '', order.id);
  notify(order.buyer_id, 'dispute_resolved', '纠纷已处理', resolution || '', order.id);
  res.json({ ok: true });
});

// ===== 通知设置 =====
const settings = require('../services/settings');

router.get('/notice-settings', (req, res) => {
  res.json({ settings: settings.getAll() });
});

router.put('/notice-settings', (req, res) => {
  const { notify_seller_sms, notify_buyer_sms, notify_platform_sms, platform_phones, wecom_webhook_url } = req.body;
  if (notify_seller_sms !== undefined) settings.set('notify_seller_sms', !!notify_seller_sms);
  if (notify_buyer_sms !== undefined) settings.set('notify_buyer_sms', !!notify_buyer_sms);
  if (notify_platform_sms !== undefined) settings.set('notify_platform_sms', !!notify_platform_sms);
  if (platform_phones !== undefined) {
    const list = Array.isArray(platform_phones) ? platform_phones : [];
    const cleaned = list.map(p => String(p).trim()).filter(p => /^1\d{10}$/.test(p));
    settings.set('platform_phones', cleaned);
  }
  if (wecom_webhook_url !== undefined) {
    settings.set('wecom_webhook_url', String(wecom_webhook_url || '').trim());
  }
  res.json({ ok: true, settings: settings.getAll() });
});

// ===== 保证金 / 服务费金额设置 =====
router.get('/deposit-settings', (req, res) => {
  const s = settings.getAll();
  res.json({
    deposit_amount: s.deposit_amount,
    service_fee_amount: s.service_fee_amount,
    // 旧档位制（兼容旧后台 UI）
    deposit_step_qty: s.deposit_step_qty,
    deposit_supply_per_step: s.deposit_supply_per_step,
    deposit_demand_per_step: s.deposit_demand_per_step,
    deposit_bid_per_step: s.deposit_bid_per_step,
  });
});

router.put('/deposit-settings', (req, res) => {
  const fields = ['deposit_amount', 'service_fee_amount', 'deposit_step_qty', 'deposit_supply_per_step', 'deposit_demand_per_step', 'deposit_bid_per_step'];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      const n = Number(req.body[f]);
      if (!(n >= 0)) return res.status(400).json({ error: `${f} 必须为非负数` });
      settings.set(f, n);
    }
  }
  const s = settings.getAll();
  res.json({
    ok: true,
    deposit_amount: s.deposit_amount,
    service_fee_amount: s.service_fee_amount,
    deposit_step_qty: s.deposit_step_qty,
    deposit_supply_per_step: s.deposit_supply_per_step,
    deposit_demand_per_step: s.deposit_demand_per_step,
    deposit_bid_per_step: s.deposit_bid_per_step,
  });
});

// ===== 客服二维码（订单成交后下发给买卖双方） =====
router.get('/service-qr', (req, res) => {
  res.json({
    service_qr_url: settings.get('service_qr_url') || '',
    service_qr_owner: settings.get('service_qr_owner') || '',
  });
});

router.put('/service-qr', (req, res) => {
  const { service_qr_url, service_qr_owner } = req.body;
  if (service_qr_url !== undefined) settings.set('service_qr_url', String(service_qr_url || '').trim());
  if (service_qr_owner !== undefined) settings.set('service_qr_owner', String(service_qr_owner || '').trim());
  res.json({
    ok: true,
    service_qr_url: settings.get('service_qr_url') || '',
    service_qr_owner: settings.get('service_qr_owner') || '',
  });
});

// ===== 审核模式总开关 =====
router.get('/review-mode', (req, res) => {
  res.json({ review_mode: !!settings.get('review_mode') });
});
router.put('/review-mode', (req, res) => {
  const v = !!req.body.review_mode;
  settings.set('review_mode', v);
  res.json({ ok: true, review_mode: v });
});

// ===== 提现审核 =====
const balance = require('../services/balance');
const { reconcileLegacyDeposits } = require('../services/auction');

router.post('/reconcile-deposits', (req, res) => {
  try {
    reconcileLegacyDeposits();
    res.json({ ok: true, message: '已重新对账历史保证金' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/withdrawals', (req, res) => {
  const status = req.query.status;
  let sql = `
    SELECT w.*, u.name AS user_name, u.phone AS user_phone, u.role AS user_role
    FROM withdrawals w JOIN users u ON u.id = w.user_id
  `;
  const params = [];
  if (status) { sql += ' WHERE w.status=?'; params.push(status); }
  sql += ' ORDER BY w.applied_at DESC LIMIT 200';
  res.json({ withdrawals: db.prepare(sql).all(...params) });
});

router.post('/withdrawals/:id/approve', (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: '申请不存在' });
  if (w.status !== 'pending') return res.status(400).json({ error: '仅待审核可批准' });
  db.prepare(`UPDATE withdrawals SET status='approved', processed_at=?, processed_by=? WHERE id=?`)
    .run(Date.now(), req.user.id, w.id);
  notify(w.user_id, 'withdraw_approved', '提现已批准',
    `您的 ${w.amount} 元提现申请已批准，将尽快打款`, w.id);
  res.json({ ok: true });
});

router.post('/withdrawals/:id/reject', (req, res) => {
  const { reason } = req.body || {};
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: '申请不存在' });
  if (!['pending', 'approved'].includes(w.status)) return res.status(400).json({ error: '当前状态无法拒绝' });
  db.prepare(`UPDATE withdrawals SET status='rejected', processed_at=?, processed_by=?, failure_reason=? WHERE id=?`)
    .run(Date.now(), req.user.id, reason || '管理员驳回', w.id);
  // 解冻金额回到用户可用余额
  balance.unlock(w.user_id, w.amount, {
    type: 'withdraw_refund',
    ref_type: 'withdrawal',
    ref_id: w.id,
    note: reason ? `提现被拒：${reason}` : '提现被拒',
  });
  notify(w.user_id, 'withdraw_rejected', '提现被拒',
    `您的 ${w.amount} 元提现申请被拒：${reason || '管理员驳回'}，金额已退回余额`, w.id);
  res.json({ ok: true });
});

router.post('/withdrawals/:id/mark-paid', async (req, res) => {
  const { out_trade_no, mode } = req.body || {};
  // mode: 'auto'（默认）→ 尝试调商家转账 API；'manual' → 仅记账，需管理员手工打款
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: '申请不存在' });
  if (!['pending', 'approved'].includes(w.status)) return res.status(400).json({ error: '当前状态无法标记为已打款' });

  let actualTradeNo = out_trade_no || null;
  let transferNote = '';

  if (mode !== 'manual' && w.method === 'wechat') {
    // 尝试微信商家转账
    const user = db.prepare('SELECT id, wechat_openid FROM users WHERE id=?').get(w.user_id);
    const { transferToWechat } = require('../services/wechat-transfer');
    const result = await transferToWechat(w, user && user.wechat_openid);
    if (result.ok) {
      actualTradeNo = actualTradeNo || result.transfer_id;
      transferNote = `微信商家转账已发起 ${result.transfer_id}` + (result.batch_id ? `（批次号 ${result.batch_id}）` : '');
    } else if (!result.demo) {
      // 真实 API 返回错误：不要静默标记成功，保持 approved/pending，把错误返回前端
      console.error('[withdraw] 商家转账 API 调用失败', {
        withdrawalId: w.id,
        http_status: result.http_status,
        wx_code: result.wx_code,
        wx_message: result.wx_message,
        wx_detail: result.wx_detail,
      });
      return res.status(500).json({
        error: '商家转账失败: ' + (result.error || '未知'),
        http_status: result.http_status,
        wx_code: result.wx_code,
        wx_message: result.wx_message,
        wx_detail: result.wx_detail,
      });
    } else {
      // 缺前置条件（未配置 / SDK 未导出方法 / 用户未绑定 openid）→ 记账 + 透出原因
      console.warn('[withdraw] 商家转账走 demo 分支', { withdrawalId: w.id, reason: result.reason, msg: result.message });
      transferNote = `⚠ ${result.message || '未接入商家转账，需在微信商户后台手工打款'}（reason=${result.reason || 'UNKNOWN'}）`;
    }
  } else if (w.method === 'bank') {
    transferNote = '银行卡转账需后台财务线下操作';
  }

  db.prepare(`UPDATE withdrawals SET status='paid', out_trade_no=?, processed_at=?, processed_by=? WHERE id=?`)
    .run(actualTradeNo, Date.now(), req.user.id, w.id);
  balance.consume(w.user_id, w.amount, {
    type: 'withdraw_paid',
    ref_type: 'withdrawal',
    ref_id: w.id,
    note: actualTradeNo ? `提现已打款 ${actualTradeNo}` : '提现已打款',
  });
  notify(w.user_id, 'withdraw_paid', '提现处理完成',
    `您的 ${w.amount} 元提现平台已处理${actualTradeNo ? '（流水号 ' + actualTradeNo + '）' : ''}，资金通常 1-3 个工作日到账`, w.id);
  res.json({ ok: true, note: transferNote });
});

module.exports = router;
