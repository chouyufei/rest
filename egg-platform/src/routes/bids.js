const express = require('express');
const db = require('../db');
const { authRequired, roleRequired } = require('../middleware/auth');
const { placeBidTx, triggerAutoBids } = require('../services/auction');

const router = express.Router();

router.post('/', authRequired, roleRequired('buyer'), (req, res) => {
  const { resource_id, price } = req.body;
  if (!resource_id || !price) return res.status(400).json({ error: '缺少参数' });
  try {
    const r = placeBidTx(Number(resource_id), req.user.id, Number(price), 0, null);
    res.json({ ok: true, resource: r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/auto', authRequired, roleRequired('buyer'), (req, res) => {
  const { resource_id, max_price } = req.body;
  if (!resource_id || !max_price) return res.status(400).json({ error: '缺少参数' });
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(resource_id);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  if (r.status !== 'auctioning') return res.status(400).json({ error: '竞拍未进行中' });
  const buyerDep = db.prepare(`SELECT * FROM deposits WHERE user_id=? AND type='buyer_bid' AND status IN ('available','frozen')`).get(req.user.id);
  if (!buyerDep) return res.status(403).json({ error: '请先缴纳 200 元竞拍保证金' });

  db.prepare(`
    INSERT INTO auto_bids (resource_id, bidder_id, max_price, active, created_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(resource_id, bidder_id) DO UPDATE SET max_price=excluded.max_price, active=1
  `).run(resource_id, req.user.id, Number(max_price), Date.now());

  triggerAutoBids(Number(resource_id), req.user.id);
  res.json({ ok: true });
});

router.delete('/auto/:resource_id', authRequired, roleRequired('buyer'), (req, res) => {
  db.prepare('UPDATE auto_bids SET active=0 WHERE resource_id=? AND bidder_id=?')
    .run(req.params.resource_id, req.user.id);
  res.json({ ok: true });
});

router.get('/mine', authRequired, roleRequired('buyer'), (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT r.*, (r.current_bidder_id = ?) AS leading
    FROM resources r
    WHERE r.id IN (SELECT resource_id FROM bids WHERE bidder_id = ?)
    ORDER BY r.end_at DESC
  `).all(req.user.id, req.user.id);
  const out = rows.map(r => ({
    ...r,
    photos: r.photos ? JSON.parse(r.photos) : [],
    leading: !!r.leading,
    time_left_ms: Math.max(0, r.end_at - Date.now()),
  }));
  res.json({ resources: out });
});

module.exports = router;
