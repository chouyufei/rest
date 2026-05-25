const express = require('express');
const db = require('../db');
const { authRequired, roleRequired } = require('../middleware/auth');
const { notify } = require('../services/notification');

const router = express.Router();
router.use(authRequired, roleRequired('admin'));

router.get('/stats', (req, res) => {
  const farmCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='farm'").get().c;
  const buyerCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='buyer'").get().c;
  const activeAuctions = db.prepare("SELECT COUNT(*) c FROM resources WHERE status='auctioning'").get().c;
  const sold = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(current_price * quantity),0) gmv FROM resources WHERE status='sold'").get();
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

module.exports = router;
