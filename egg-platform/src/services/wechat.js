const APP_ID = process.env.WECHAT_APP_ID || '';
const APP_SECRET = process.env.WECHAT_APP_SECRET || '';

const isLive = !!(APP_ID && APP_SECRET);

async function code2session(jsCode) {
  if (!isLive) {
    return {
      demo: true,
      openid: 'demo_openid_' + (jsCode ? jsCode.slice(0, 8) : 'anon'),
      session_key: 'demo_session_key',
    };
  }
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${APP_ID}&secret=${APP_SECRET}&js_code=${encodeURIComponent(jsCode)}&grant_type=authorization_code`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode) throw new Error('微信登录失败: ' + (data.errmsg || data.errcode));
  return data;
}

module.exports = { code2session, isLive };
