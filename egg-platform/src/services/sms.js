const otpStore = require('./otp');

const PROVIDER = process.env.SMS_PROVIDER || '';
const SIGN_NAME = process.env.SMS_SIGN_NAME || '';
const TEMPLATE_CODE = process.env.SMS_TEMPLATE_CODE || '';
const ACCESS_KEY_ID = process.env.SMS_ACCESS_KEY_ID || '';
const ACCESS_KEY_SECRET = process.env.SMS_ACCESS_KEY_SECRET || '';

const isLive = !!(PROVIDER && SIGN_NAME && TEMPLATE_CODE && ACCESS_KEY_ID && ACCESS_KEY_SECRET);

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function send(phone) {
  if (!isLive) {
    otpStore.set(phone, '123456');
    console.log(`[SMS DEMO] ${phone} → 123456`);
    return { ok: true, demo: true, code: '123456' };
  }

  const code = genCode();
  try {
    if (PROVIDER === 'aliyun') await sendViaAliyun(phone, code);
    else if (PROVIDER === 'tencent') await sendViaTencent(phone, code);
    else throw new Error('不支持的 SMS_PROVIDER: ' + PROVIDER);
    otpStore.set(phone, code);
    return { ok: true };
  } catch (e) {
    console.error('SMS send failed:', e.message);
    throw new Error('短信发送失败: ' + e.message);
  }
}

async function sendViaAliyun(phone, code) {
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
    templateCode: TEMPLATE_CODE,
    templateParam: JSON.stringify({ code }),
  });
  const runtime = new Util.RuntimeOptions({});
  const res = await client.sendSmsWithOptions(req, runtime);
  if (res.body.code !== 'OK') throw new Error(res.body.message || 'aliyun: ' + res.body.code);
}

async function sendViaTencent(phone, code) {
  let tencentcloud;
  try { tencentcloud = require('tencentcloud-sdk-nodejs'); }
  catch (e) { throw new Error('请先安装腾讯云 SMS SDK: npm i tencentcloud-sdk-nodejs'); }
  const SmsClient = tencentcloud.sms.v20210111.Client;
  const client = new SmsClient({
    credential: { secretId: ACCESS_KEY_ID, secretKey: ACCESS_KEY_SECRET },
    region: 'ap-guangzhou',
  });
  const res = await client.SendSms({
    SmsSdkAppId: process.env.SMS_APP_ID,
    SignName: SIGN_NAME,
    TemplateId: TEMPLATE_CODE,
    TemplateParamSet: [code],
    PhoneNumberSet: ['+86' + phone],
  });
  const r = res.SendStatusSet && res.SendStatusSet[0];
  if (!r || r.Code !== 'Ok') throw new Error((r && r.Message) || 'tencent send failed');
}

module.exports = { send, isLive, provider: PROVIDER };
