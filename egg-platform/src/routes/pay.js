const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { notify } = require('../services/notification');

const router = express.Router();

const FARM_DEPOSIT = 1000;
const BUYER_DEPOSIT = 200;

const WECHAT_APP_ID = process.env.WECHAT_APP_ID || '';
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID || '';
const WECHAT_API_V3_KEY = process.env.WECHAT_API_V3_KEY || '';
const WECHAT_SERIAL_NO = process.env.WECHAT_SERIAL_NO || '';
const WECHAT_PRIVATE_KEY = process.env.WECHAT_PRIVATE_KEY || '';
const WECHAT_NOTIFY_URL = process.env.WECHAT_NOTIFY_URL || '';

const isLiveMode = !!(WECHAT_APP_ID && WECHAT_MCH_ID && WECHAT_API_V3_KEY && WECHAT_SERIAL_NO && WECHAT_PRIVATE_KEY && WECHAT_NOTIFY_URL);

router.get('/mode', (req, res) => {
  res.json({
    live: isLiveMode,
    mode: isLiveMode ? 'wechat_pay' : 'demo',
    message: isLiveMode ? '已接入微信支付' : '演示模式：跳过支付直接缴纳（生产请配置微信支付环境变量）',
  });
});

router.post('/create-order', authRequired, async (req, res) => {
  const { type } = req.body;
  if (!['farm_quality', 'buyer_bid'].includes(type)) {
    return res.status(400).json({ error: '保证金类型错误' });
  }
  if (type === 'farm_quality' && req.user.role !== 'farm') return res.status(403).json({ error: '仅养殖场需缴纳品质保证金' });
  if (type === 'buyer_bid' && req.user.role !== 'buyer') return res.status(403).json({ error: '仅采购商需缴纳竞拍保证金' });
  if (type === 'farm_quality' && req.user.license_status !== 'approved') {
    return res.status(403).json({ error: '请先完成资质审核' });
  }

  const existing = db.prepare(`
    SELECT * FROM deposits WHERE user_id=? AND type=? AND status IN ('available','frozen')
  `).get(req.user.id, type);
  if (existing) return res.json({ ok: true, paid: true, message: '已缴纳保证金' });

  const amount = type === 'farm_quality' ? FARM_DEPOSIT : BUYER_DEPOSIT;
  const orderNo = 'DEP' + Date.now() + Math.floor(Math.random() * 1000);

  if (!isLiveMode) {
    const info = db.prepare(`
      INSERT INTO deposits (user_id, type, amount, status, note, paid_at)
      VALUES (?, ?, ?, 'available', ?, ?)
    `).run(req.user.id, type, amount, `演示模式订单 ${orderNo}`, Date.now());
    const dep = db.prepare('SELECT * FROM deposits WHERE id=?').get(info.lastInsertRowid);
    return res.json({ ok: true, demo: true, deposit: dep, message: `[演示] 已缴纳 ${amount} 元保证金（生产请配置微信支付）` });
  }

  return res.status(501).json({
    error: '微信支付尚未配置完整',
    todo: [
      '需要设置环境变量: WECHAT_APP_ID, WECHAT_MCH_ID, WECHAT_API_V3_KEY, WECHAT_SERIAL_NO, WECHAT_PRIVATE_KEY, WECHAT_NOTIFY_URL',
      '需在 routes/pay.js 中调用微信支付下单接口（POST /v3/pay/transactions/jsapi）',
      '需实现 /api/pay/notify 接收异步支付结果回调',
    ],
  });
});

router.post('/notify', express.raw({ type: '*/*' }), (req, res) => {
  res.json({ code: 'SUCCESS', message: '成功' });
});

module.exports = router;
