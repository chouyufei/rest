// 企业微信群机器人通知（平台方）
// 用法：在企业微信群里添加「群机器人」，复制 webhook URL 配到管理后台
const settings = require('./settings');

async function send(text) {
  let url = process.env.WECOM_WEBHOOK_URL || '';
  try { url = settings.get('wecom_webhook_url') || url; } catch (e) {}
  if (!url) {
    console.log('[企业微信·demo]', text);
    return { demo: true };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    });
    const r = await res.json();
    if (r.errcode && r.errcode !== 0) {
      console.warn('企业微信下发失败:', r.errcode, r.errmsg);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.warn('企业微信异常:', e.message);
    return { ok: false };
  }
}

module.exports = { send };
