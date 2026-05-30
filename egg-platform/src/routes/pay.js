const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { notify } = require('../services/notification');
const { FARM_DEPOSIT_AMOUNT: FARM_DEPOSIT, BUYER_DEPOSIT_AMOUNT: BUYER_DEPOSIT } = require('../services/auction');

const router = express.Router();

const WECHAT_APP_ID = process.env.WECHAT_APP_ID || '';
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID || '';
const WECHAT_API_V3_KEY = process.env.WECHAT_API_V3_KEY || '';
const WECHAT_SERIAL_NO = process.env.WECHAT_SERIAL_NO || '';
const WECHAT_PRIVATE_KEY = process.env.WECHAT_PRIVATE_KEY || '';
const WECHAT_PUBLIC_KEY = process.env.WECHAT_PUBLIC_KEY || '';
const WECHAT_NOTIFY_URL = process.env.WECHAT_NOTIFY_URL || '';

const hasAllPayEnv = !!(WECHAT_APP_ID && WECHAT_MCH_ID && WECHAT_API_V3_KEY &&
  WECHAT_SERIAL_NO && WECHAT_PRIVATE_KEY && WECHAT_PUBLIC_KEY && WECHAT_NOTIFY_URL);

let pay = null;
if (hasAllPayEnv) {
  try {
    const mod = require('wechatpay-node-v3');
    const WxPay = mod.default || mod;
    pay = new WxPay({
      appid: WECHAT_APP_ID,
      mchid: WECHAT_MCH_ID,
      serial_no: WECHAT_SERIAL_NO,
      publicKey: Buffer.from(WECHAT_PUBLIC_KEY),
      privateKey: Buffer.from(WECHAT_PRIVATE_KEY),
      key: WECHAT_API_V3_KEY,
    });
    console.log('微信支付已启用 mch_id=' + WECHAT_MCH_ID + ' serial_no=' + WECHAT_SERIAL_NO.slice(0, 12) + '…');
    pay.get_certificates(WECHAT_API_V3_KEY)
      .then((certs) => console.log('已预热平台证书 ' + (certs && certs.length) + ' 张'))
      .catch((e) => console.warn('预热平台证书失败（首次回调时会自动拉取）:', e.message));
  } catch (e) {
    console.error('微信支付 SDK 初始化失败:', e.message);
    pay = null;
  }
}

const isLive = !!pay;

router.get('/mode', (req, res) => {
  res.json({
    live: isLive,
    mode: isLive ? 'wechat_pay' : 'demo',
    message: isLive
      ? '已接入微信支付'
      : (hasAllPayEnv ? 'SDK 初始化失败，请检查证书格式' : '演示模式：跳过支付直接缴纳'),
    mch_id: isLive ? WECHAT_MCH_ID : undefined,
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

  if (!isLive) {
    const orderNo = 'DEMO' + Date.now() + Math.floor(Math.random() * 1000);
    const info = db.prepare(`
      INSERT INTO deposits (user_id, type, amount, status, note, paid_at)
      VALUES (?, ?, ?, 'available', ?, ?)
    `).run(req.user.id, type, amount, `演示订单 ${orderNo}`, Date.now());
    const dep = db.prepare('SELECT * FROM deposits WHERE id=?').get(info.lastInsertRowid);
    return res.json({ ok: true, demo: true, deposit: dep, message: `[演示] 已缴纳 ${amount} 元保证金` });
  }

  if (!req.user.wechat_openid) {
    return res.status(400).json({ error: '需先用微信登录获取 openid 才能支付（微信小程序 JSAPI 要求）' });
  }

  const outTradeNo = 'EGGDEP' + Date.now() + req.user.id;
  const totalFen = Math.round(amount * 100);

  db.prepare(`
    INSERT INTO pay_orders (out_trade_no, user_id, deposit_type, amount, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(outTradeNo, req.user.id, type, amount, Date.now());

  try {
    const result = await pay.transactions_jsapi({
      description: `凤伯乐${type === 'farm_quality' ? '品质' : '竞拍'}保证金`,
      out_trade_no: outTradeNo,
      notify_url: WECHAT_NOTIFY_URL,
      amount: { total: totalFen, currency: 'CNY' },
      payer: { openid: req.user.wechat_openid },
    });

    if (result.status !== 200 || !result.data || !result.data.paySign) {
      db.prepare(`UPDATE pay_orders SET status='cancelled' WHERE out_trade_no=?`).run(outTradeNo);
      const errMsg = (result.error && (result.error.message || result.error.code)) ||
        (result.errRaw && JSON.stringify(result.errRaw)) ||
        ('HTTP ' + result.status);
      console.error('微信下单失败:', errMsg);
      return res.status(400).json({ error: '微信下单失败: ' + errMsg });
    }

    const p = result.data;
    return res.json({
      ok: true,
      timeStamp: p.timeStamp,
      nonceStr: p.nonceStr,
      package: p.package,
      signType: p.signType || 'RSA',
      paySign: p.paySign,
      out_trade_no: outTradeNo,
    });
  } catch (e) {
    console.error('微信下单异常:', e);
    db.prepare(`UPDATE pay_orders SET status='cancelled' WHERE out_trade_no=?`).run(outTradeNo);
    return res.status(500).json({ error: '微信下单异常: ' + (e.message || String(e)) });
  }
});

router.post('/notify', async (req, res) => {
  if (!pay) return res.status(503).json({ code: 'FAIL', message: '支付未启用' });

  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  const h = req.headers;

  let verified = false;
  try {
    verified = await pay.verifySign({
      timestamp: h['wechatpay-timestamp'],
      nonce: h['wechatpay-nonce'],
      body: rawBody,
      serial: h['wechatpay-serial'],
      signature: h['wechatpay-signature'],
      apiSecret: WECHAT_API_V3_KEY,
    });
  } catch (e) {
    console.error('回调验签异常:', e.message);
    return res.status(401).json({ code: 'FAIL', message: '验签失败: ' + e.message });
  }
  if (!verified) {
    console.warn('回调验签失败（signature mismatch）');
    return res.status(401).json({ code: 'FAIL', message: '验签失败' });
  }

  let json;
  try { json = JSON.parse(rawBody); }
  catch (e) { return res.status(400).json({ code: 'FAIL', message: '解析失败' }); }

  if (!json.resource) {
    return res.json({ code: 'SUCCESS', message: '无 resource，已忽略' });
  }

  let payload;
  try {
    const r = json.resource;
    payload = pay.decipher_gcm(r.ciphertext, r.associated_data, r.nonce);
  } catch (e) {
    console.error('回调解密失败:', e);
    return res.status(500).json({ code: 'FAIL', message: '解密失败' });
  }

  const { out_trade_no, transaction_id, trade_state } = payload;
  if (trade_state !== 'SUCCESS') {
    return res.json({ code: 'SUCCESS', message: 'ack non-success: ' + trade_state });
  }

  const order = db.prepare('SELECT * FROM pay_orders WHERE out_trade_no=?').get(out_trade_no);
  if (!order) return res.json({ code: 'SUCCESS', message: '未找到订单，已忽略' });
  if (order.status === 'paid') return res.json({ code: 'SUCCESS', message: '已处理' });

  fulfillOrder(order, transaction_id);
  res.json({ code: 'SUCCESS', message: '成功' });
});

router.get('/check/:out_trade_no', authRequired, async (req, res) => {
  const order = db.prepare('SELECT * FROM pay_orders WHERE out_trade_no=? AND user_id=?')
    .get(req.params.out_trade_no, req.user.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.status === 'paid') return res.json({ paid: true, order });
  if (!isLive) return res.json({ paid: false, order });

  try {
    const result = await pay.query({ out_trade_no: req.params.out_trade_no });
    if (result.status === 200 && result.data && result.data.trade_state === 'SUCCESS') {
      fulfillOrder(order, result.data.transaction_id);
      const fresh = db.prepare('SELECT * FROM pay_orders WHERE id=?').get(order.id);
      return res.json({ paid: true, order: fresh });
    }
    res.json({
      paid: false,
      order,
      trade_state: result.data && result.data.trade_state,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function fulfillOrder(order, transactionId) {
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE pay_orders SET status='paid', transaction_id=?, paid_at=? WHERE id=? AND status='pending'`)
      .run(transactionId, now, order.id);
    const exists = db.prepare(`SELECT id FROM deposits WHERE user_id=? AND type=? AND status IN ('available','frozen')`)
      .get(order.user_id, order.deposit_type);
    if (!exists) {
      db.prepare(`
        INSERT INTO deposits (user_id, type, amount, status, note, paid_at)
        VALUES (?, ?, ?, 'available', ?, ?)
      `).run(order.user_id, order.deposit_type, order.amount, `微信支付 ${transactionId}`, now);
    }
  });
  tx();
  notify(order.user_id, 'deposit_paid', '保证金已缴纳',
    `${order.deposit_type === 'farm_quality' ? '品质' : '竞拍'}保证金 ${order.amount} 元已通过微信支付完成`, null);
}

module.exports = router;
