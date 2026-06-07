const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { computeDepositAmount } = require('../services/auction');
const balance = require('../services/balance');

const router = express.Router();

router.get('/', authRequired, (req, res) => {
  const rows = db.prepare(`SELECT * FROM deposits WHERE user_id=? ORDER BY paid_at DESC`).all(req.user.id);
  res.json({ deposits: rows });
});

// 查询保证金状态：
//   - kind=supply / demand：检查是否有「未绑定到任何资源」且金额足够当前 qty 的"通用"保证金
//   - kind=bid (传 resource_id)：检查是否已为该资源缴竞拍保证金
// 旧 farm / buyer 字段保留兼容
router.get('/status', authRequired, (req, res) => {
  const qty = Number(req.query.qty) || 1;
  const resourceId = req.query.resource_id ? Number(req.query.resource_id) : null;

  // 货源（卖方品质保证金）：未绑定资源 + 金额够本次 qty
  const supplyRequired = computeDepositAmount('farm_quality', qty);
  const supplyDep = db.prepare(`
    SELECT * FROM deposits
    WHERE user_id=? AND type='farm_quality' AND status IN ('available','frozen')
      AND resource_id IS NULL AND amount >= ?
    ORDER BY paid_at DESC LIMIT 1
  `).get(req.user.id, supplyRequired);

  // 求购（买方发布保证金）：同样按 qty 计算
  const demandRequired = computeDepositAmount('demand_quality', qty);
  const demandDep = db.prepare(`
    SELECT * FROM deposits
    WHERE user_id=? AND type='demand_quality' AND status IN ('available','frozen')
      AND resource_id IS NULL AND amount >= ?
    ORDER BY paid_at DESC LIMIT 1
  `).get(req.user.id, demandRequired);

  // 竞拍（按资源绑定）
  let bidDep = null;
  let bidRequired = computeDepositAmount('buyer_bid', 1);  // 基础档（用于无 resource_id 的信息展示）
  if (resourceId) {
    const r = db.prepare('SELECT quantity FROM resources WHERE id=?').get(resourceId);
    const resQty = r ? r.quantity : qty;
    bidRequired = computeDepositAmount('buyer_bid', resQty);
    bidDep = db.prepare(`
      SELECT * FROM deposits
      WHERE user_id=? AND type='buyer_bid' AND resource_id=? AND status IN ('available','frozen')
      ORDER BY paid_at DESC LIMIT 1
    `).get(req.user.id, resourceId);
  }

  res.json({
    qty,
    supply: { paid: !!supplyDep, required: supplyRequired, deposit: supplyDep || null },
    demand: { paid: !!demandDep, required: demandRequired, deposit: demandDep || null },
    bid:    { paid: !!bidDep,    required: bidRequired,    deposit: bidDep || null, resource_id: resourceId },
    // 兼容旧字段名
    farm:   { paid: !!supplyDep, required: supplyRequired, deposit: supplyDep || null },
    buyer:  { paid: !!bidDep,    required: bidRequired,    deposit: bidDep || null, resource_id: resourceId },
  });
});

router.post('/refund/:id', authRequired, (req, res) => {
  const dep = db.prepare(`SELECT * FROM deposits WHERE id=? AND user_id=?`).get(req.params.id, req.user.id);
  if (!dep) return res.status(404).json({ error: '保证金不存在' });
  if (dep.status !== 'available') return res.status(400).json({ error: '保证金当前不可退还' });
  if (dep.resource_id) return res.status(400).json({ error: '已绑定到货源的保证金需待竞拍结束后释放' });
  db.prepare(`UPDATE deposits SET status='released', released_at=? WHERE id=?`).run(Date.now(), dep.id);
  // 入账到用户钱包余额
  balance.credit(req.user.id, dep.amount, {
    type: 'deposit_release',
    ref_type: 'deposit',
    ref_id: dep.id,
    note: `退还未使用保证金 #${dep.id}`,
  });
  res.json({ ok: true, message: `已退还 ${dep.amount} 元至钱包余额` });
});

module.exports = router;
