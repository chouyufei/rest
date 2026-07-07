const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { computeDepositAmount, computeServiceFee, lockDepositForResource } = require('../services/auction');
const balance = require('../services/balance');

const router = express.Router();

router.get('/', authRequired, (req, res) => {
  const rows = db.prepare(`SELECT * FROM deposits WHERE user_id=? ORDER BY paid_at DESC`).all(req.user.id);
  res.json({ deposits: rows });
});

// 查询当前需冻结金额 + 钱包余额情况 + 该资源是否已冻结
router.get('/status', authRequired, (req, res) => {
  const resourceId = req.query.resource_id ? Number(req.query.resource_id) : null;
  const required = computeDepositAmount();
  const serviceFee = computeServiceFee();
  const b = balance.getBalance(req.user.id);

  let bound = null;
  if (resourceId) {
    bound = db.prepare(`
      SELECT * FROM deposits
      WHERE user_id=? AND resource_id=? AND status='frozen'
      ORDER BY paid_at DESC LIMIT 1
    `).get(req.user.id, resourceId);
  }

  res.json({
    required,
    service_fee: serviceFee,
    balance: b,                          // { balance, locked_balance, available }
    sufficient: b.available >= required, // 是否够冻结一笔
    bound: bound || null,                // 该资源已冻结的记录（如存在）
  });
});

// 手动锁定一笔保证金到指定资源（主要给"先报价 / 应标"等场景用）
// 发布货源 / 求购的锁定在 /resources POST 内部自动完成，前端不必单独调用
router.post('/lock', authRequired, (req, res) => {
  const { type, resource_id } = req.body;
  if (!['farm_quality', 'buyer_bid', 'demand_quality'].includes(type)) {
    return res.status(400).json({ error: '保证金类型错误' });
  }
  if (!resource_id) return res.status(400).json({ error: '需指定 resource_id' });

  try {
    const dep = lockDepositForResource({ userId: req.user.id, resourceId: Number(resource_id), type });
    const b = balance.getBalance(req.user.id);
    res.json({ ok: true, deposit: dep, balance: b });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({
        error: e.message,
        code: 'INSUFFICIENT_BALANCE',
        required: e.required,
        available: e.available,
        short: e.required - e.available,
      });
    }
    res.status(500).json({ error: e.message });
  }
});

router.post('/refund/:id', authRequired, (req, res) => {
  const dep = db.prepare(`SELECT * FROM deposits WHERE id=? AND user_id=?`).get(req.params.id, req.user.id);
  if (!dep) return res.status(404).json({ error: '保证金不存在' });
  if (dep.status !== 'available') return res.status(400).json({ error: '保证金当前不可退还' });
  if (dep.type === 'buyer_bid' && dep.resource_id) {
    return res.status(400).json({ error: '已绑定到货源的服务保障金需待报价结束后释放' });
  }
  db.prepare(`UPDATE deposits SET status='released', released_at=? WHERE id=?`).run(Date.now(), dep.id);
  balance.credit(req.user.id, dep.amount, {
    type: 'deposit_release',
    ref_type: 'deposit',
    ref_id: dep.id,
    note: `退还未使用保证金 #${dep.id}`,
  });
  res.json({ ok: true, message: `已退还 ${dep.amount} 元至钱包余额` });
});

module.exports = router;
