const express = require('express');
const db = require('../db');
const { authRequired, roleRequired } = require('../middleware/auth');
const { placeBidTx, triggerAutoBids, lockDepositForResource } = require('../services/auction');
const balance = require('../services/balance');

const router = express.Router();

router.post('/', authRequired, (req, res) => {
  const { resource_id, price } = req.body;
  if (!resource_id || !price) return res.status(400).json({ error: '缺少参数' });
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(Number(resource_id));
  if (!r) return res.status(404).json({ error: '资源不存在' });
  const isSupply = (r.kind || 'supply') === 'supply';
  if (isSupply && req.user.role !== 'buyer') return res.status(403).json({ error: '货源仅限采购商出价' });
  if (!isSupply && req.user.role !== 'farm') return res.status(403).json({ error: '求购仅限养殖场应标' });
  // 首次出价：自动从钱包冻结一笔竞拍保证金
  try {
    lockDepositForResource({ userId: req.user.id, resourceId: Number(resource_id), type: 'buyer_bid' });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({ error: e.message, code: 'INSUFFICIENT_BALANCE', required: e.required, available: e.available });
    }
    return res.status(500).json({ error: e.message });
  }
  try {
    const updated = placeBidTx(Number(resource_id), req.user.id, Number(price), 0, null);
    res.json({ ok: true, resource: updated });
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
  if ((r.kind || 'supply') !== 'supply') return res.status(400).json({ error: '求购暂不支持自动出价' });
  // 自动出价前也确保保证金已冻结
  try {
    lockDepositForResource({ userId: req.user.id, resourceId: Number(resource_id), type: 'buyer_bid' });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({ error: e.message, code: 'INSUFFICIENT_BALANCE', required: e.required, available: e.available });
    }
    return res.status(500).json({ error: e.message });
  }

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

router.get('/mine', authRequired, (req, res) => {
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
