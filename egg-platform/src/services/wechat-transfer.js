// 商家转账到零钱（微信支付 V3 「转账」能力）。
// 接通需在商户后台开通"商家转账"产品权限 + 完成 KYC，否则 API 调用会被拒。
// 没接通或缺关键信息时返回 { ok: false, demo: true, reason }，让管理员在微信商家平台手工打款。

const WECHAT_APP_ID = process.env.WECHAT_APP_ID || '';
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID || '';
const isConfigured = !!(WECHAT_APP_ID && WECHAT_MCH_ID);

let pay = null;
let sdkInitError = null;
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
  sdkInitError = e.message || String(e);
}

// 解析 SDK 提供的「发起商家转账」方法。wechatpay-node-v3 各版本命名不一致：
//   - 2.x: batches_transfer(params)
//   - 老版本: transfer_batches / transferBatches
function resolveBatchesTransfer() {
  if (!pay) return null;
  return pay.batches_transfer
      || pay.transfer_batches
      || pay.transferBatches
      || null;
}

// 转账到指定 openid 的微信零钱
// withdrawal: { id, user_id, amount }
// openid: 用户 wechat_openid
async function transferToWechat(withdrawal, openid) {
  if (!isConfigured) {
    return { ok: false, demo: true, reason: 'SDK_NOT_CONFIGURED',
      message: '商户支付环境变量未配置（WECHAT_APP_ID / WECHAT_MCH_ID 等）' };
  }
  if (!pay) {
    return { ok: false, demo: true, reason: 'SDK_INIT_FAILED',
      message: '微信支付 SDK 初始化失败' + (sdkInitError ? '：' + sdkInitError : '') };
  }
  if (!openid) {
    return { ok: false, demo: true, reason: 'USER_NO_OPENID',
      message: '用户未绑定微信 openid（仅用手机号注册过，未走过微信登录），无法发起商家转账到零钱' };
  }
  const fn = resolveBatchesTransfer();
  if (typeof fn !== 'function') {
    return { ok: false, demo: true, reason: 'SDK_METHOD_NOT_FOUND',
      message: 'wechatpay-node-v3 当前版本未导出商家转账方法（batches_transfer / transfer_batches）' };
  }
  const outBatchNo = 'EGGWD' + Date.now() + withdrawal.id;
  const outDetailNo = 'D' + Date.now() + withdrawal.id;
  const totalFen = Math.round(Number(withdrawal.amount) * 100);

  try {
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
    // wechatpay-node-v3 返回的对象通常带 { status, data, headers }
    if (result && result.status === 200) {
      return { ok: true, transfer_id: outBatchNo, batch_id: result.data && result.data.batch_id, raw: result.data };
    }
    return {
      ok: false,
      error: (result && result.error && (result.error.message || result.error.code))
        || (result && result.data && (result.data.message || result.data.code))
        || ('HTTP ' + (result && result.status)),
      raw: result,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), stack: e.stack };
  }
}

module.exports = { transferToWechat, isConfigured };
