// 微信订阅消息（单模板·按规范）
// 模板含字段：
//   thing1.DATA       货源标题      ≤ 20 字符
//   short_thing2.DATA 结果文案      ≤ 5 字符（!! 这是微信硬约束 !!）
//   thing4.DATA       固定提示      ≤ 20 字符

const APP_ID = process.env.WECHAT_APP_ID || '';
const APP_SECRET = process.env.WECHAT_APP_SECRET || '';
const TEMPLATE_ID = process.env.WECHAT_TPL_AUCTION || 'O8k9dw5eVZafa1ZqaZtyb0R_MCfoBOBTmlJNuq7juA4';
const FIXED_TIP = '已成交，请进小程序查看';

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

// 结果文案（≤ 5 字，微信 short_thing 硬约束）
const RESULT_TEXTS = {
  buyer_won:  '已中标',
  buyer_lost: '未中标',
  seller:     '已成交',
  new_bid:    '新报价',
  outbid:     '被反超',
  nearby:     '附近新货',
};

// 过滤 emoji + 杂质：thing 类字段不允许 emoji，部分平台对全角符号也敏感
function stripEmoji(s) {
  return String(s || '').replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1F900}-\u{1F9FF}\u{2700}-\u{27BF}]/gu,
    ''
  );
}
function sanitizeThing(s, max) {
  return stripEmoji(s).trim().slice(0, max);
}

// scenario: 'buyer_won' | 'buyer_lost' | 'seller'
async function send(openid, scenario, resourceTitle, page) {
  const resultText = RESULT_TEXTS[scenario] || '通知';
  if (!isLive || !openid) {
    console.log(`[微信订阅消息·demo] openid=${openid} scenario=${scenario} title="${resourceTitle}" → "${resultText}"`);
    return { demo: true };
  }
  const data = {
    thing1:        { value: sanitizeThing(resourceTitle, 20) || '凤伯乐通知' },
    short_thing2:  { value: sanitizeThing(resultText, 5) },
    thing4:        { value: sanitizeThing(FIXED_TIP, 20) },
  };
  try {
    const token = await getAccessToken();
    const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`;
    const body = {
      touser: openid,
      template_id: TEMPLATE_ID,
      data,
      miniprogram_state: process.env.NODE_ENV === 'production' ? 'formal' : 'trial',
      lang: 'zh_CN',
    };
    if (page) body.page = page;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await res.json();
    if (r.errcode && r.errcode !== 0) {
      console.warn('微信订阅消息下发失败:', r.errcode, r.errmsg, 'data=', JSON.stringify(data));
      return { ok: false, err: r };
    }
    return { ok: true };
  } catch (e) {
    console.warn('微信订阅消息异常:', e.message, 'data=', JSON.stringify(data));
    return { ok: false, err: e };
  }
}

function templatesPublic() {
  // 单模板 + 多场景：所有场景共用同一个 TEMPLATE_ID，但前端 requestSubscribe
  // 时仍按场景名 (order_received / auction_won / auction_lost) 调用，
  // 这里把同一个 ID 映射到所有场景 key，避免前端查不到模板而跳过授权弹窗
  const tpl = TEMPLATE_ID || null;
  return {
    auction:        tpl,
    auction_won:    tpl,
    auction_lost:   tpl,
    order_received: tpl,
    new_bid:        tpl,
    outbid:         tpl,
    nearby:         tpl,
  };
}

module.exports = { send, templatesPublic, isLive };
