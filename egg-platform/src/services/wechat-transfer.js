// 商家转账到零钱（微信支付 V3 「转账」能力）。
// 接通需在商户后台开通"商家转账"产品权限 + 完成 KYC，否则 API 调用会被拒。
// 没接通或缺关键信息时返回 { ok: false, demo: true, reason }，让管理员在微信商家平台手工打款。
//
// 接口选择：
//   - WECHAT_TRANSFER_SCENE_ID 配了（如 1011 企业转账） → 走新版"单笔转账" API
//     /v3/fund-app/mch-transfer/transfer-bills
//   - 没配 → 回退老的"批次转账" API /v3/transfer/batches（仅老商户可用）

const WECHAT_APP_ID = process.env.WECHAT_APP_ID || '';
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID || '';
const isConfigured = !!(WECHAT_APP_ID && WECHAT_MCH_ID);

let pay = null;
let sdkInitError = null;
const WECHAT_PLATFORM_PUBLIC_KEY    = process.env.WECHAT_PLATFORM_PUBLIC_KEY    || '';
const WECHAT_PLATFORM_PUBLIC_KEY_ID = process.env.WECHAT_PLATFORM_PUBLIC_KEY_ID || '';
const usePublicKeyMode = !!(WECHAT_PLATFORM_PUBLIC_KEY && WECHAT_PLATFORM_PUBLIC_KEY_ID);
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
    // 微信支付公钥模式：把公钥灌进 SDK 静态字典，敏感字段加密直接用它
    if (usePublicKeyMode) {
      const pem = WECHAT_PLATFORM_PUBLIC_KEY.includes('-----BEGIN')
        ? WECHAT_PLATFORM_PUBLIC_KEY
        : `-----BEGIN PUBLIC KEY-----\n${WECHAT_PLATFORM_PUBLIC_KEY}\n-----END PUBLIC KEY-----`;
      WxPay.certificates = Object.assign({}, WxPay.certificates || {}, {
        [WECHAT_PLATFORM_PUBLIC_KEY_ID]: pem,
      });
    }
  }
} catch (e) {
  pay = null;
  sdkInitError = e.message || String(e);
}

function resolveBatchesTransfer() {
  if (!pay) return null;
  return pay.batches_transfer || pay.transfer_batches || pay.transferBatches || null;
}

// 单笔转账（新接口）所需的场景报备信息。各场景对 info_type / info_content 的要求不同：
//   1000 现金营销: [{info_type:"活动名称",info_content:"xxx"},{info_type:"奖励说明",info_content:"xxx"}]
//   1005 报销:    [{info_type:"报销人姓名",info_content:"xxx"},{info_type:"报销事由",info_content:"xxx"}]
//   1006 劳务报酬: [{info_type:"劳务事由",info_content:"xxx"}]
//   1011 企业转账: [{info_type:"事由",info_content:"xxx"}]
// 通过 WECHAT_TRANSFER_REPORT_INFOS（JSON 字符串）覆盖默认值。
function parseReportInfos() {
  const raw = process.env.WECHAT_TRANSFER_REPORT_INFOS;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) {}
  }
  return [{ info_type: '事由', info_content: '凤伯乐平台用户提现' }];
}

// 用户感知文案（微信收款通知"XX到账"里展示）。每个场景允许的枚举不同：
//   1000 现金营销:  现金奖励 / 现金营销 / 活动奖励
//   1005 报销:      企业报销 / 报销款
//   1006 劳务报酬:  劳务报酬
//   1011 企业转账:  劳务报酬 / 报销款 / 经营奖励 / 企业转账（按业务选）
// 默认空字符串 → 不带这个字段，让微信使用通用通知；
// 通过 WECHAT_TRANSFER_RECV_PERCEPTION 显式配置后才带。
function getRecvPerception() {
  return process.env.WECHAT_TRANSFER_RECV_PERCEPTION || '';
}

// 拿公钥 + serial 用于敏感字段加密
//  - 公钥模式：直接用 env 配的微信支付公钥 + 公钥 ID
//  - 旧证书模式：调 /v3/certificates 拉一次
async function loadPlatformCert() {
  if (!pay) throw new Error('SDK 未初始化');
  if (usePublicKeyMode) {
    const pem = WECHAT_PLATFORM_PUBLIC_KEY.includes('-----BEGIN')
      ? WECHAT_PLATFORM_PUBLIC_KEY
      : `-----BEGIN PUBLIC KEY-----\n${WECHAT_PLATFORM_PUBLIC_KEY}\n-----END PUBLIC KEY-----`;
    return { publicKey: pem, serial_no: WECHAT_PLATFORM_PUBLIC_KEY_ID };
  }
  const certs = await pay.get_certificates(process.env.WECHAT_API_V3_KEY);
  if (!Array.isArray(certs) || !certs.length) throw new Error('微信平台证书拉取失败');
  const sorted = [...certs].sort((a, b) => (b.serial_no || '').localeCompare(a.serial_no || ''));
  return sorted[0];
}

// 新版单笔转账 /v3/fund-app/mch-transfer/transfer-bills
async function transferBillToWechat(withdrawal, openid, sceneId) {
  const outBillNo = 'EGGWD' + Date.now() + withdrawal.id;
  const totalFen = Math.round(Number(withdrawal.amount) * 100);

  const payload = {
    appid: WECHAT_APP_ID,
    out_bill_no: outBillNo,
    transfer_scene_id: String(sceneId),
    openid,
    transfer_amount: totalFen,
    transfer_remark: `凤伯乐 #${withdrawal.id}`,
    transfer_scene_report_infos: parseReportInfos(),
  };
  const perception = getRecvPerception();
  if (perception) payload.user_recv_perception = perception;
  if (process.env.WECHAT_TRANSFER_NOTIFY_URL) {
    payload.notify_url = process.env.WECHAT_TRANSFER_NOTIFY_URL;
  }

  // ≥ 2000 元 微信要求带加密后的 user_name；user_name 必须真实姓名
  let wxSerial = '';
  if (totalFen >= 200000) {
    const userName = withdrawal._user_name;
    if (!userName) {
      return { ok: false, reason: 'USER_NAME_REQUIRED',
        message: '单笔转账金额 ≥ 2000 元时微信要求实名校验，需先在 users 表里补充收款人真实姓名（user.name 或新加 real_name 列），再发起本次提现。' };
    }
    try {
      const cert = await loadPlatformCert();
      payload.user_name = pay.publicEncrypt(userName, cert.publicKey);
      wxSerial = cert.serial_no;
    } catch (e) {
      return { ok: false, reason: 'CERT_FETCH_FAILED', error: e.message };
    }
  }

  const url = 'https://api.mch.weixin.qq.com/v3/fund-app/mch-transfer/transfer-bills';
  const authorization = pay.buildAuthorization('POST', url, payload);
  const headers = pay.getHeaders(authorization, {
    'Content-Type': 'application/json',
    ...(wxSerial ? { 'Wechatpay-Serial': wxSerial } : {}),
  });

  const result = await pay.httpService.post(url, payload, headers);
  if (result && result.status === 200) {
    return {
      ok: true,
      transfer_id: outBillNo,
      bill_id: result.data && (result.data.transfer_bill_no || result.data.out_bill_no),
      package_info: result.data && result.data.package_info,
      raw: result.data,
    };
  }
  return parseHttpError(result);
}

// 老版批次转账 /v3/transfer/batches
async function batchesTransferToWechat(withdrawal, openid, sceneId) {
  const fn = resolveBatchesTransfer();
  if (typeof fn !== 'function') {
    return { ok: false, demo: true, reason: 'SDK_METHOD_NOT_FOUND',
      message: 'wechatpay-node-v3 当前版本未导出商家转账方法（batches_transfer）' };
  }
  const outBatchNo = 'EGGWD' + Date.now() + withdrawal.id;
  const outDetailNo = 'D' + Date.now() + withdrawal.id;
  const totalFen = Math.round(Number(withdrawal.amount) * 100);
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
  if (sceneId) payload.transfer_scene_id = String(sceneId);
  const result = await fn.call(pay, payload);
  if (result && result.status === 200) {
    return { ok: true, transfer_id: outBatchNo, batch_id: result.data && result.data.batch_id, raw: result.data };
  }
  return parseHttpError(result);
}

function parseHttpError(result) {
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
  return {
    ok: false,
    http_status: httpStatus,
    wx_code: wxCode,
    wx_message: wxMessage,
    wx_detail: wxDetail,
    error: explainWxError(httpStatus, wxCode, wxMessage),
    raw: result,
  };
}

// 入口：根据场景 ID 是否配置选择 单笔 / 批次 接口
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
  const sceneId = process.env.WECHAT_TRANSFER_SCENE_ID || '';
  try {
    if (sceneId) {
      return await transferBillToWechat(withdrawal, openid, sceneId);
    }
    return await batchesTransferToWechat(withdrawal, openid, '');
  } catch (e) {
    return { ok: false, error: e.message || String(e), stack: e.stack };
  }
}

function explainWxError(http, code, msg) {
  const base = (code ? `[${code}] ` : `[HTTP ${http}] `) + (msg || '');
  if (http === 403 || code === 'FORBIDDEN' || code === 'NO_AUTH') {
    return base + ' — 商户未开通该产品权限 / 该 API 未授权 / 申请的转账场景与调用接口不匹配。注意：1011（企业转账）等场景只能用单笔转账接口 /v3/fund-app/mch-transfer/transfer-bills；1000（现金营销）才支持老批次接口 /v3/transfer/batches。';
  }
  if (code === 'SIGN_ERROR' || code === 'INVALID_SIGNATURE') {
    return base + ' — 签名错误：检查 WECHAT_SERIAL_NO（商户证书序列号）/ WECHAT_PRIVATE_KEY（与证书匹配的私钥）是否正确。';
  }
  if (code === 'RULE_LIMIT' || code === 'AMOUNT_LIMIT') {
    return base + ' — 商户转账额度或频率被限制（单日上限 / 单笔上限 / 频次）。';
  }
  if (code === 'PAYEE_ERROR' || code === 'NOT_FOUND') {
    return base + ' — 收款用户 openid 无效或与当前 AppID 不绑定（用户没在该小程序授权过登录）。';
  }
  if (code === 'PARAM_ERROR' || code === 'INVALID_REQUEST') {
    return base + ' — 参数错误：检查 out_bill_no 唯一性 / 金额合规性 / transfer_scene_report_infos 字段是否符合场景要求。';
  }
  return base;
}

module.exports = { transferToWechat, isConfigured };
