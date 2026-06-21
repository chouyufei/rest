const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const balance = require('../services/balance');
const settings = require('../services/settings');

const router = express.Router();

// 提现规则统一从 settings 读取，微信零钱 / 银行卡 分两套额度。
function withdrawRules() {
  return {
    min_amount: Number(settings.get('withdraw_min_amount')) || 1,
    processing_hours: Number(settings.get('withdraw_processing_hours')) || 24,
    arrival_hours: Number(settings.get('withdraw_arrival_hours')) || 72,
    fee_pct: Number(settings.get('withdraw_fee_pct')) || 0,
    window: String(settings.get('withdraw_window') || '工作日 09:00-18:00'),
    methods: {
      wechat: {
        max_per_request: Number(settings.get('withdraw_wechat_max_per_request')) || 200,
        max_daily_count: Number(settings.get('withdraw_wechat_max_daily_count')) || 10,
        max_daily_amount: Number(settings.get('withdraw_wechat_max_daily_amount')) || 2000,
      },
      bank: {
        max_per_request: Number(settings.get('withdraw_max_per_request')) || 5000,
        max_daily_count: Number(settings.get('withdraw_max_daily_count')) || 3,
        max_daily_amount: Number(settings.get('withdraw_max_daily_amount')) || 5000,
      },
    },
  };
}

// 公开接口：让小程序提现页拉出详细规则展示给用户
router.get('/withdraw-rules', (req, res) => {
  res.json(withdrawRules());
});

function txTypeLabel(t) {
  return ({
    recharge:        '充值',
    deposit_release: '保证金释放',
    deposit_lock:    '冻结保证金',
    deposit_unlock:  '解冻保证金',
    service_fee:     '平台服务费',
    withdraw_lock:   '提现冻结',
    withdraw_paid:   '提现完成',
    withdraw_refund: '提现退回',
    adjust:          '管理员调整',
  })[t] || t;
}

// 给每笔流水补上关联订单 / 资源 / 资源标题，方便前端展示
function enrichTransaction(t) {
  const out = { ...t, type_label: txTypeLabel(t.type) };
  if (t.ref_type === 'order' && t.ref_id) {
    const o = db.prepare('SELECT id, resource_id, final_price, quantity FROM orders WHERE id=?').get(t.ref_id);
    if (o) {
      const r = db.prepare('SELECT id, title FROM resources WHERE id=?').get(o.resource_id);
      out.related = {
        kind: 'order',
        order_id: o.id,
        resource_id: r && r.id,
        title: r ? r.title : null,
        final_price: o.final_price,
        quantity: o.quantity,
      };
    }
  } else if (t.ref_type === 'deposit' && t.ref_id) {
    const d = db.prepare('SELECT id, resource_id, type, amount FROM deposits WHERE id=?').get(t.ref_id);
    if (d) {
      let title = null, orderId = null;
      if (d.resource_id) {
        const r = db.prepare('SELECT id, title FROM resources WHERE id=?').get(d.resource_id);
        title = r ? r.title : null;
        const o = db.prepare('SELECT id FROM orders WHERE resource_id=?').get(d.resource_id);
        orderId = o ? o.id : null;
      }
      out.related = {
        kind: 'deposit',
        deposit_id: d.id,
        resource_id: d.resource_id,
        order_id: orderId,
        title,
        deposit_type: d.type,
        deposit_amount: d.amount,
      };
    }
  } else if (t.ref_type === 'withdrawal' && t.ref_id) {
    const w = db.prepare('SELECT id, amount, method, status FROM withdrawals WHERE id=?').get(t.ref_id);
    if (w) out.related = { kind: 'withdrawal', withdrawal_id: w.id, amount: w.amount, method: w.method, status: w.status };
  } else if (t.ref_type === 'pay_order' && t.ref_id) {
    const o = db.prepare('SELECT id, amount, purpose, out_trade_no FROM pay_orders WHERE id=?').get(t.ref_id);
    if (o) out.related = { kind: 'pay_order', pay_order_id: o.id, amount: o.amount, purpose: o.purpose, out_trade_no: o.out_trade_no };
  }
  return out;
}

router.get('/balance', authRequired, (req, res) => {
  const b = balance.getBalance(req.user.id);
  res.json(b);
});

router.get('/transactions', authRequired, (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;
  const list = balance.getTransactions(req.user.id, { limit, offset });
  res.json({ transactions: list.map(enrichTransaction) });
});

// 提现申请：从可用余额扣到 locked_balance，等待管理员审核打款
router.post('/withdrawals', authRequired, (req, res) => {
  const { amount, method, account_name, account_no, bank_name } = req.body;
  const amt = Number(amount);
  const rules = withdrawRules();

  if (!['wechat', 'bank'].includes(method)) return res.status(400).json({ error: '提现方式仅支持 wechat / bank' });
  const mr = rules.methods[method];
  const methodLabel = method === 'wechat' ? '微信零钱' : '银行卡';

  if (!(amt >= rules.min_amount)) return res.status(400).json({ error: `单笔提现至少 ${rules.min_amount} 元` });
  if (amt > mr.max_per_request) return res.status(400).json({ error: `${methodLabel}单笔提现上限 ${mr.max_per_request} 元` });
  if (method === 'bank') {
    if (!account_name || !account_no || !bank_name) return res.status(400).json({ error: '银行卡提现需填写持卡人 / 卡号 / 开户行' });
  }

  const b = balance.getBalance(req.user.id);
  if (b.available < amt) return res.status(400).json({ error: `可用余额不足，当前 ${b.available} 元` });

  // 每日提现次数 / 金额上限（按自然日，UTC+8 起算的当日 00:00 开始，分 method 各算各的）
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayStart = dayStart.getTime();
  const todayRow = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS s
    FROM withdrawals
    WHERE user_id=? AND method=? AND applied_at >= ? AND status != 'cancelled'
  `).get(req.user.id, method, todayStart);
  if (todayRow.c >= mr.max_daily_count) {
    return res.status(400).json({ error: `今日${methodLabel}提现已达 ${mr.max_daily_count} 次上限` });
  }
  if ((todayRow.s + amt) > mr.max_daily_amount) {
    return res.status(400).json({
      error: `今日${methodLabel}提现总额将超过 ${mr.max_daily_amount} 元上限（已申请 ${todayRow.s} 元）`,
    });
  }

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

// 商户配置（mchId / appId）：小程序拉起 wx.requestMerchantTransfer 用
router.get('/wechat-pay-config', authRequired, (req, res) => {
  res.json({
    appid: process.env.WECHAT_APP_ID || '',
    mch_id: process.env.WECHAT_MCH_ID || '',
  });
});

// 用户从小程序「提现记录」点【确认收款】，wx.requestMerchantTransfer 成功后
// 调一下这个接口告知后端，后端把状态收尾成 paid + 扣余额
router.post('/withdrawals/:id/confirm-received', authRequired, (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!w) return res.status(404).json({ error: '提现申请不存在' });
  if (w.status === 'paid') return res.json({ ok: true, already: true });
  if (w.status !== 'transferring') return res.status(400).json({ error: '当前状态无法确认收款' });

  db.prepare(`UPDATE withdrawals SET status='paid' WHERE id=?`).run(w.id);
  // 此刻才真正从 locked_balance 出账（之前一直锁着，对账可追溯）
  balance.consume(w.user_id, w.amount, {
    type: 'withdraw_paid',
    ref_type: 'withdrawal',
    ref_id: w.id,
    note: w.out_trade_no ? `提现到账 ${w.out_trade_no}` : '提现到账',
  });
  res.json({ ok: true });
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
