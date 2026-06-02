// 微信订阅消息（一次性）：subscribeMessage.send
// 需要用户在小程序里通过 wx.requestSubscribeMessage 主动授权一次模板，后端才能下发。

const APP_ID = process.env.WECHAT_APP_ID || '';
const APP_SECRET = process.env.WECHAT_APP_SECRET || '';

const TEMPLATES = {
  auction_won:     process.env.WECHAT_TPL_AUCTION_WON || '',
  auction_lost:    process.env.WECHAT_TPL_AUCTION_LOST || '',
  order_received:  process.env.WECHAT_TPL_ORDER_RECEIVED || '',
};

const isLive = !!(APP_ID && APP_SECRET);

let _accessToken = null;
let _accessTokenExpiresAt = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _accessTokenExpiresAt - 5 * 60 * 1000) return _accessToken;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APP_ID}&secret=${APP_SECRET}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.access_token) throw new Error('获取 access_token 失败: ' + (data.errmsg || JSON.stringify(data)));
  _accessToken = data.access_token;
  _accessTokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
  return _accessToken;
}

// 下发订阅消息。data 形如 { thing1: { value: 'xxx' }, amount2: { value: '100元' }, ... }
async function send(openid, templateKey, data, page) {
  const templateId = TEMPLATES[templateKey];
  if (!isLive || !templateId || !openid) {
    console.log(`[微信订阅消息·demo] openid=${openid} template=${templateKey} data=`, data);
    return { demo: true };
  }
  try {
    const token = await getAccessToken();
    const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`;
    const body = {
      touser: openid,
      template_id: templateId,
      data,
      miniprogram_state: process.env.NODE_ENV === 'production' ? 'formal' : 'trial',
      lang: 'zh_CN',
    };
    if (page) body.page = page;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await res.json();
    if (r.errcode && r.errcode !== 0) {
      console.warn('微信订阅消息下发失败:', r.errcode, r.errmsg, 'template=' + templateKey);
      return { ok: false, err: r };
    }
    return { ok: true };
  } catch (e) {
    console.warn('微信订阅消息异常:', e.message);
    return { ok: false, err: e };
  }
}

function templatesPublic() {
  // 提供给小程序前端用于 wx.requestSubscribeMessage 的模板 ID（只暴露公开值）
  return {
    auction_won: TEMPLATES.auction_won || null,
    auction_lost: TEMPLATES.auction_lost || null,
    order_received: TEMPLATES.order_received || null,
  };
}

module.exports = { send, templatesPublic, isLive };
