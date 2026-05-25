const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { FARM_DEPOSIT_AMOUNT, BUYER_DEPOSIT_AMOUNT } = require('../services/auction');

const router = express.Router();

router.get('/', authRequired, (req, res) => {
  const rows = db.prepare(`SELECT * FROM deposits WHERE user_id=? ORDER BY paid_at DESC`).all(req.user.id);
  res.json({ deposits: rows });
});

router.get('/status', authRequired, (req, res) => {
  const farmDep = db.prepare(`
    SELECT * FROM deposits WHERE user_id=? AND type='farm_quality' AND status IN ('available','frozen')
    ORDER BY paid_at DESC LIMIT 1
  `).get(req.user.id);
  const buyerDep = db.prepare(`
    SELECT * FROM deposits WHERE user_id=? AND type='buyer_bid' AND status IN ('available','frozen')
    ORDER BY paid_at DESC LIMIT 1
  `).get(req.user.id);
  res.json({
    farm: { paid: !!farmDep, required: FARM_DEPOSIT_AMOUNT, deposit: farmDep || null },
    buyer: { paid: !!buyerDep, required: BUYER_DEPOSIT_AMOUNT, deposit: buyerDep || null },
  });
});

router.post('/pay', authRequired, (req, res) => {
  const { type } = req.body;
  if (!['farm_quality', 'buyer_bid'].includes(type)) return res.status(400).json({ error: '保证金类型错误' });
  if (type === 'farm_quality' && req.user.role !== 'farm') return res.status(403).json({ error: '仅养殖场需缴纳品质保证金' });
  if (type === 'buyer_bid' && req.user.role !== 'buyer') return res.status(403).json({ error: '仅采购商需缴纳竞拍保证金' });
  if (type === 'farm_quality' && req.user.license_status !== 'approved') {
    return res.status(403).json({ error: '请先完成资质审核' });
  }

  const existing = db.prepare(`
    SELECT * FROM deposits WHERE user_id=? AND type=? AND status IN ('available','frozen')
  `).get(req.user.id, type);
  if (existing) return res.json({ ok: true, deposit: existing, message: '已缴纳保证金' });

  const amount = type === 'farm_quality' ? FARM_DEPOSIT_AMOUNT : BUYER_DEPOSIT_AMOUNT;
  const info = db.prepare(`
    INSERT INTO deposits (user_id, type, amount, status, paid_at) VALUES (?, ?, ?, 'available', ?)
  `).run(req.user.id, type, amount, Date.now());
  const dep = db.prepare('SELECT * FROM deposits WHERE id=?').get(info.lastInsertRowid);
  res.json({ ok: true, deposit: dep, message: `已支付 ${amount} 元保证金（演示模式）` });
});

router.post('/refund/:id', authRequired, (req, res) => {
  const dep = db.prepare(`SELECT * FROM deposits WHERE id=? AND user_id=?`).get(req.params.id, req.user.id);
  if (!dep) return res.status(404).json({ error: '保证金不存在' });
  if (dep.status !== 'available') return res.status(400).json({ error: '保证金当前不可退还' });
  db.prepare(`UPDATE deposits SET status='released', released_at=? WHERE id=?`).run(Date.now(), dep.id);
  res.json({ ok: true, message: '保证金已退还（演示模式）' });
});

module.exports = router;
