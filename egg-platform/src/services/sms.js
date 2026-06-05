const otpStore = require('./otp');

const PROVIDER = process.env.SMS_PROVIDER || '';
const SIGN_NAME = process.env.SMS_SIGN_NAME || '';
const TEMPLATE_CODE = process.env.SMS_TEMPLATE_CODE || '';
// 通知模板：买卖方（2657517）/ 平台方（2657523）
const NOTICE_USER_TEMPLATE = process.env.SMS_NOTICE_USER_TEMPLATE || '2657517';
const NOTICE_PLATFORM_TEMPLATE = process.env.SMS_NOTICE_PLATFORM_TEMPLATE || '2657523';
const ACCESS_KEY_ID = process.env.SMS_ACCESS_KEY_ID || '';
const ACCESS_KEY_SECRET = process.env.SMS_ACCESS_KEY_SECRET || '';

const isLive = !!(PROVIDER && SIGN_NAME && TEMPLATE_CODE && ACCESS_KEY_ID && ACCESS_KEY_SECRET);
const noticeLive = isLive;

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// 通知给买卖方：[货源标题, 结果文案]
// 模板 2657517 假设格式：「【凤伯乐】{1}：{2}」 — 实际看模板申请时的字段顺序
async function sendUserNotice(phone, resourceTitle, resultText) {
  const params = [String(resourceTitle || '').slice(0, 20), String(resultText || '')];
  if (!noticeLive) {
    console.log(`[SMS-用户·demo] → ${phone} 模板=${NOTICE_USER_TEMPLATE} 参数=`, params);
    return { ok: true, demo: true };
  }
  try {
    if (PROVIDER === 'tencent') await sendViaTencent(phone, params, NOTICE_USER_TEMPLATE);
    else if (PROVIDER === 'aliyun') await sendViaAliyun(phone, { name: params[0], result: params[1] }, NOTICE_USER_TEMPLATE);
    return { ok: true };
  } catch (e) {
    console.warn('SMS user notice failed:', e.message);
    return { ok: false, err: e.message };
  }
}

// 通知给平台方：[货源标题, 卖方信息, 买方信息]
async function sendPlatformNotice(phone, resourceTitle, sellerInfo, buyerInfo) {
  const params = [
    String(resourceTitle || '').slice(0, 20),
    String(sellerInfo || ''),
    String(buyerInfo || ''),
  ];
  if (!noticeLive) {
    console.log(`[SMS-平台·demo] → ${phone} 模板=${NOTICE_PLATFORM_TEMPLATE} 参数=`, params);
    return { ok: true, demo: true };
  }
  try {
    if (PROVIDER === 'tencent') await sendViaTencent(phone, params, NOTICE_PLATFORM_TEMPLATE);
    else if (PROVIDER === 'aliyun') await sendViaAliyun(phone, { name: params[0], seller: params[1], buyer: params[2] }, NOTICE_PLATFORM_TEMPLATE);
    return { ok: true };
  } catch (e) {
    console.warn('SMS platform notice failed:', e.message);
    return { ok: false, err: e.message };
  }
}

async function send(phone) {
  if (!isLive) {
    otpStore.set(phone, '123456');
    console.log(`[SMS DEMO] ${phone} → 123456`);
    return { ok: true, demo: true, code: '123456' };
  }

  const code = genCode();
  try {
    if (PROVIDER === 'aliyun') await sendViaAliyun(phone, { code }, TEMPLATE_CODE);
    else if (PROVIDER === 'tencent') await sendViaTencent(phone, { code }, TEMPLATE_CODE);
    else throw new Error('不支持的 SMS_PROVIDER: ' + PROVIDER);
    otpStore.set(phone, code);
    return { ok: true };
  } catch (e) {
    console.error('SMS send failed:', e.message);
    throw new Error('短信发送失败: ' + e.message);
  }
}

async function sendViaAliyun(phone, params, templateCode) {
  let Dysmsapi, OpenApi, Util;
  try {
    Dysmsapi = require('@alicloud/dysmsapi20170525');
    OpenApi = require('@alicloud/openapi-client');
    Util = require('@alicloud/tea-util');
  } catch (e) {
    throw new Error('请先安装阿里云 SMS SDK: npm i @alicloud/dysmsapi20170525 @alicloud/openapi-client @alicloud/tea-util');
  }
  const config = new OpenApi.Config({
    accessKeyId: ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SECRET,
    endpoint: 'dysmsapi.aliyuncs.com',
  });
  const client = new Dysmsapi.default(config);
  const req = new Dysmsapi.SendSmsRequest({
    phoneNumbers: phone,
    signName: SIGN_NAME,
    templateCode,
    templateParam: JSON.stringify(params),
  });
  const runtime = new Util.RuntimeOptions({});
  const res = await client.sendSmsWithOptions(req, runtime);
  if (res.body.code !== 'OK') throw new Error(res.body.message || 'aliyun: ' + res.body.code);
}

async function sendViaTencent(phone, params, templateCode) {
  let tencentcloud;
  try { tencentcloud = require('tencentcloud-sdk-nodejs'); }
  catch (e) { throw new Error('请先安装腾讯云 SMS SDK: npm i tencentcloud-sdk-nodejs'); }
  const SmsClient = tencentcloud.sms.v20210111.Client;
  const client = new SmsClient({
    credential: { secretId: ACCESS_KEY_ID, secretKey: ACCESS_KEY_SECRET },
    region: 'ap-guangzhou',
  });
  const paramSet = Array.isArray(params) ? params : Object.values(params).map(v => String(v));
  const res = await client.SendSms({
    SmsSdkAppId: process.env.SMS_APP_ID,
    SignName: SIGN_NAME,
    TemplateId: templateCode,
    TemplateParamSet: paramSet,
    PhoneNumberSet: ['+86' + phone],
  });
  const r = res.SendStatusSet && res.SendStatusSet[0];
  if (!r || r.Code !== 'Ok') throw new Error((r && r.Message) || 'tencent send failed');
}

module.exports = { send, sendUserNotice, sendPlatformNotice, isLive, noticeLive, provider: PROVIDER };
