// 微信订阅消息（单模板·按规范）
// 模板含字段：thing1.DATA（货源标题）/ short_thing2.DATA（结果文案，≤15 字）/ thing4.DATA（固定提示）

const APP_ID = process.env.WECHAT_APP_ID || '';
const APP_SECRET = process.env.WECHAT_APP_SECRET || '';
const TEMPLATE_ID = process.env.WECHAT_TPL_AUCTION || 'O8k9dw5eVZafa1ZqaZtyb0R_MCfoBOBTmlJNuq7juA4';
const FIXED_TIP = '请进入小程序查看详情，后续平台方会添加相关人员建微信群沟通';

const isLive = !!(APP_ID && APP_SECRET && TEMPLATE_ID);

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

// 结果文案映射（≤15 字）
const RESULT_TEXTS = {
  buyer_won:  '货源竞拍成功',
  buyer_lost: '货源竞拍失败',
  seller:     '您的货源已被成功竞拍',
};

// scenario: 'buyer_won' | 'buyer_lost' | 'seller'
async function send(openid, scenario, resourceTitle, page) {
  const resultText = RESULT_TEXTS[scenario] || scenario;
  if (!isLive || !openid) {
    console.log(`[微信订阅消息·demo] openid=${openid} scenario=${scenario} title="${resourceTitle}" → "${resultText}"`);
    return { demo: true };
  }
  try {
    const token = await getAccessToken();
    const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`;
    const body = {
      touser: openid,
      template_id: TEMPLATE_ID,
      data: {
        thing1:        { value: String(resourceTitle || '').slice(0, 20) },
        short_thing2:  { value: resultText },
        thing4:        { value: FIXED_TIP },
      },
      miniprogram_state: process.env.NODE_ENV === 'production' ? 'formal' : 'trial',
      lang: 'zh_CN',
    };
    if (page) body.page = page;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await res.json();
    if (r.errcode && r.errcode !== 0) {
      console.warn('微信订阅消息下发失败:', r.errcode, r.errmsg);
      return { ok: false, err: r };
    }
    return { ok: true };
  } catch (e) {
    console.warn('微信订阅消息异常:', e.message);
    return { ok: false, err: e };
  }
}

function templatesPublic() {
  return { auction: TEMPLATE_ID || null };
}

module.exports = { send, templatesPublic, isLive };
