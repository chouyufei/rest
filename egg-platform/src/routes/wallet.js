const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const balance = require('../services/balance');

const router = express.Router();

const MIN_WITHDRAW = 1;          // 最低提现金额
const MAX_PENDING = 3;           // 同时进行中的提现申请上限

function txTypeLabel(t) {
  return ({
    deposit_release: '保证金释放',
    withdraw_lock: '提现冻结',
    withdraw_paid: '提现完成',
    withdraw_refund: '提现退回',
    adjust: '管理员调整',
  })[t] || t;
}

router.get('/balance', authRequired, (req, res) => {
  const b = balance.getBalance(req.user.id);
  res.json(b);
});

router.get('/transactions', authRequired, (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;
  const list = balance.getTransactions(req.user.id, { limit, offset });
  res.json({ transactions: list.map(t => ({ ...t, type_label: txTypeLabel(t.type) })) });
});

// 提现申请：从可用余额扣到 locked_balance，等待管理员审核打款
router.post('/withdrawals', authRequired, (req, res) => {
  const { amount, method, account_name, account_no, bank_name } = req.body;
  const amt = Number(amount);
  if (!(amt >= MIN_WITHDRAW)) return res.status(400).json({ error: `提现金额至少 ${MIN_WITHDRAW} 元` });
  if (!['wechat', 'bank'].includes(method)) return res.status(400).json({ error: '提现方式仅支持 wechat / bank' });
  if (method === 'bank') {
    if (!account_name || !account_no || !bank_name) return res.status(400).json({ error: '银行卡提现需填写持卡人 / 卡号 / 开户行' });
  }

  const b = balance.getBalance(req.user.id);
  if (b.available < amt) return res.status(400).json({ error: `可用余额不足，当前 ${b.available} 元` });

  const pending = db.prepare(`SELECT COUNT(*) c FROM withdrawals WHERE user_id=? AND status IN ('pending','approved')`).get(req.user.id).c;
  if (pending >= MAX_PENDING) return res.status(400).json({ error: `进行中的提现已有 ${pending} 笔，请等待处理` });

  const info = db.prepare(`
    INSERT INTO withdrawals (user_id, amount, status, method, account_name, account_no, bank_name, applied_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(req.user.id, amt, method, account_name || null, account_no || null, bank_name || null, Date.now());

  balance.lock(req.user.id, amt, {
    type: 'withdraw_lock',
    ref_type: 'withdrawal',
    ref_id: info.lastInsertRowid,
    note: `提现冻结 #${info.lastInsertRowid}`,
  });

  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(info.lastInsertRowid);
  res.json({ ok: true, withdrawal: w });
});

router.get('/withdrawals/mine', authRequired, (req, res) => {
  const list = db.prepare(`SELECT * FROM withdrawals WHERE user_id=? ORDER BY applied_at DESC LIMIT 100`).all(req.user.id);
  res.json({ withdrawals: list });
});

// 用户取消尚未处理的提现：解冻金额回到可用余额
router.post('/withdrawals/:id/cancel', authRequired, (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!w) return res.status(404).json({ error: '提现申请不存在' });
  if (w.status !== 'pending') return res.status(400).json({ error: '仅待审核的申请可取消' });
  db.prepare(`UPDATE withdrawals SET status='cancelled', processed_at=? WHERE id=?`).run(Date.now(), w.id);
  balance.unlock(req.user.id, w.amount, {
    type: 'withdraw_refund',
    ref_type: 'withdrawal',
    ref_id: w.id,
    note: '用户取消提现',
  });
  res.json({ ok: true });
});

module.exports = router;
