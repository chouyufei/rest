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

  // 部分商户需要在 payload 里带 transfer_scene_id（在商户后台「商家转账」申请场景后给到）
  const sceneId = process.env.WECHAT_TRANSFER_SCENE_ID || '';

  try {
    const payload = {
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
    };
    if (sceneId) payload.transfer_scene_id = sceneId;

    const result = await fn.call(pay, payload);
    // wechatpay-node-v3 成功：{ status: 200, data: {...} }
    if (result && result.status === 200) {
      return { ok: true, transfer_id: outBatchNo, batch_id: result.data && result.data.batch_id, raw: result.data };
    }
    // 失败：{ status: 4xx, error: <raw response text>, errRaw }
    // 微信 V3 错误 body 是 JSON：{ "code": "FORBIDDEN", "message": "未授权访问该API" }
    let wxCode = '', wxMessage = '', wxDetail = null;
    if (result && result.error) {
      try {
        const parsed = typeof result.error === 'string' ? JSON.parse(result.error) : result.error;
        wxCode = parsed.code || '';
        wxMessage = parsed.message || '';
        wxDetail = parsed.detail || null;
      } catch (e) {
        wxMessage = String(result.error).slice(0, 300);
      }
    }
    const httpStatus = (result && result.status) || 0;
    const friendly = explainWxError(httpStatus, wxCode, wxMessage);
    return {
      ok: false,
      http_status: httpStatus,
      wx_code: wxCode,
      wx_message: wxMessage,
      wx_detail: wxDetail,
      error: friendly,
      raw: result,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), stack: e.stack };
  }
}

// 把常见的微信 V3 错误码翻译成"接下来该做什么"的提示
function explainWxError(http, code, msg) {
  const base = (code ? `[${code}] ` : `[HTTP ${http}] `) + (msg || '');
  if (http === 403 || code === 'FORBIDDEN' || code === 'NO_AUTH') {
    return base + ' — 通常是商户未开通"商家转账"产品权限 / 该 API 未授权 / 未申请对应转账场景。请到微信商户平台 → 产品中心 → 商家转账，确认权限已开通并申请场景，拿到 transfer_scene_id 后配 WECHAT_TRANSFER_SCENE_ID 环境变量重试。';
  }
  if (code === 'SIGN_ERROR' || code === 'INVALID_SIGNATURE') {
    return base + ' — 签名错误：检查 WECHAT_SERIAL_NO（商户证书序列号）/ WECHAT_PRIVATE_KEY（与证书匹配的私钥）是否正确。';
  }
  if (code === 'RULE_LIMIT' || code === 'AMOUNT_LIMIT') {
    return base + ' — 商户转账额度或频率被限制（单日上限 / 单笔上限 / 频次）。';
  }
  if (code === 'PAYEE_ERROR' || code === 'NOT_FOUND') {
    return base + ' — 收款用户 openid 无效或与当前 AppID 不绑定（可能用户没在该小程序授权过登录）。';
  }
  if (code === 'PARAM_ERROR') {
    return base + ' — 参数错误：检查 out_batch_no 唯一性、金额最小 0.3 元、备注字符等。';
  }
  return base;
}

module.exports = { transferToWechat, isConfigured };
