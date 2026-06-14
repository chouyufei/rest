// 商家转账到零钱（微信支付 V3 「转账」能力）。
// 接通需在商户后台开通"商家转账"产品权限 + 完成 KYC，否则 API 调用会被拒。
// 没接通时返回 { ok: false, demo: true }，让管理员在微信商家平台手工打款。

const WECHAT_APP_ID = process.env.WECHAT_APP_ID || '';
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID || '';
const isConfigured = !!(WECHAT_APP_ID && WECHAT_MCH_ID);

let pay = null;
try {
  const mod = require('wechatpay-node-v3');
  const WxPay = mod.default || mod;
  if (isConfigured && process.env.WECHAT_API_V3_KEY && process.env.WECHAT_PRIVATE_KEY) {
    pay = new WxPay({
      appid: WECHAT_APP_ID,
      mchid: WECHAT_MCH_ID,
      serial_no: process.env.WECHAT_SERIAL_NO || '',
      publicKey: Buffer.from(process.env.WECHAT_PUBLIC_KEY || ''),
      privateKey: Buffer.from(process.env.WECHAT_PRIVATE_KEY || ''),
      key: process.env.WECHAT_API_V3_KEY,
    });
  }
} catch (e) {
  pay = null;
}

// 转账到指定 openid 的微信零钱
// withdrawal: { id, user_id, amount }
// openid: 用户 wechat_openid
async function transferToWechat(withdrawal, openid) {
  if (!pay || !openid) {
    return { ok: false, demo: true, message: '未接入商家转账，需手工在商户后台打款' };
  }
  const outBatchNo = 'EGGWD' + Date.now() + withdrawal.id;
  const outDetailNo = 'D' + Date.now() + withdrawal.id;
  const totalFen = Math.round(Number(withdrawal.amount) * 100);

  try {
    // 优先使用 SDK 提供的转账方法。不同 SDK 版本字段名可能不同。
    const fn = pay.transfer_batches || pay.transferBatches || null;
    if (typeof fn !== 'function') {
      return { ok: false, demo: true, message: 'wechatpay-node-v3 当前版本不支持 transfer_batches' };
    }
    const result = await fn.call(pay, {
      appid: WECHAT_APP_ID,
      out_batch_no: outBatchNo,
      batch_name: '凤伯乐提现',
      batch_remark: `提现 #${withdrawal.id}`,
      total_amount: totalFen,
      total_num: 1,
      transfer_detail_list: [{
        out_detail_no: outDetailNo,
        transfer_amount: totalFen,
        transfer_remark: `凤伯乐 #${withdrawal.id}`,
        openid,
      }],
    });
    if (result.status === 200) {
      return { ok: true, transfer_id: outBatchNo, raw: result.data };
    }
    return { ok: false, error: (result.error && result.error.message) || ('HTTP ' + result.status), raw: result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { transferToWechat, isConfigured };
