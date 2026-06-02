const db = require('../db');
const sms = require('./sms');
const wechat = require('./wechat-notify');

function notify(userId, type, title, content, relatedId = null) {
  db.prepare(`
    INSERT INTO messages (user_id, type, title, content, related_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, type, title, content, relatedId, Date.now());
}

function getUser(userId) {
  return db.prepare('SELECT id, phone, wechat_openid, name FROM users WHERE id = ?').get(userId);
}

function isRealPhone(p) {
  return typeof p === 'string' && /^1\d{10}$/.test(p);
}

// 场景 1：买家竞拍成功（中标）
function notifyAuctionWon(userId, resource, price) {
  const u = getUser(userId);
  if (!u) return;
  const title = '🎉 竞拍成功';
  const content = `恭喜！您以 ${price} 元拍下「${resource.title}」，请尽快联系卖家完成交易`;
  notify(u.id, 'auction_won', title, content, resource.id);

  if (isRealPhone(u.phone)) {
    sms.sendNotice(u.phone, { name: resource.title.slice(0, 20), price: String(price), action: '完成交易' });
  }
  wechat.send(u.wechat_openid, 'auction_won', {
    thing1: { value: resource.title.slice(0, 20) },
    amount2: { value: `${price} 元` },
    thing3: { value: '请联系卖家完成发货' },
  }, '/pages/resource-detail/resource-detail?id=' + resource.id);
}

// 场景 2：买家未中标（流拍 or 被其他人拍走）
function notifyAuctionLost(userId, resource, finalPrice) {
  const u = getUser(userId);
  if (!u) return;
  const title = finalPrice ? '未中标' : '已流拍';
  const content = finalPrice
    ? `「${resource.title}」已被其他买家以 ${finalPrice} 元拍下，您的保证金已退还`
    : `「${resource.title}」无人成交，已流拍，您的保证金已退还`;
  notify(u.id, finalPrice ? 'auction_lost' : 'auction_failed', title, content, resource.id);

  if (isRealPhone(u.phone)) {
    sms.sendNotice(u.phone, { name: resource.title.slice(0, 20), price: String(finalPrice || 0), action: finalPrice ? '未中标，保证金已退' : '已流拍' });
  }
  wechat.send(u.wechat_openid, 'auction_lost', {
    thing1: { value: resource.title.slice(0, 20) },
    thing2: { value: finalPrice ? `被其他买家以 ${finalPrice} 元拍下` : '无人成交，已流拍' },
    thing3: { value: '保证金已自动退还' },
  }, '/pages/resource-detail/resource-detail?id=' + resource.id);
}

// 场景 3：发布方收到订单（自己发的货被拍下，或自己的求购被应标）
function notifyOrderReceived(userId, resource, finalPrice, isSupply) {
  const u = getUser(userId);
  if (!u) return;
  const title = isSupply ? '🎉 您的货源已被竞拍成功' : '🎉 您的求购已被应标';
  const content = isSupply
    ? `「${resource.title}」已以 ${finalPrice} 元成交，请在订单中联系采购商发货`
    : `「${resource.title}」已以 ${finalPrice} 元成交，请在订单中联系养殖场`;
  notify(u.id, 'order_received', title, content, resource.id);

  if (isRealPhone(u.phone)) {
    sms.sendNotice(u.phone, { name: resource.title.slice(0, 20), price: String(finalPrice), action: '请到平台查看订单' });
  }
  wechat.send(u.wechat_openid, 'order_received', {
    thing1: { value: resource.title.slice(0, 20) },
    amount2: { value: `${finalPrice} 元` },
    thing3: { value: '请到平台查看订单' },
  }, '/pages/order-detail/order-detail?id=' + resource.id);
}

// 通用场景：流拍通知发布方
function notifyAuctionFailedToPublisher(userId, resource, isSupply) {
  const u = getUser(userId);
  if (!u) return;
  const title = '😔 流拍';
  const content = `「${resource.title}」无人${isSupply ? '出价' : '应标'}，已流拍`;
  notify(u.id, 'auction_failed', title, content, resource.id);

  if (isRealPhone(u.phone)) {
    sms.sendNotice(u.phone, { name: resource.title.slice(0, 20), price: '0', action: '已流拍' });
  }
  wechat.send(u.wechat_openid, 'auction_lost', {
    thing1: { value: resource.title.slice(0, 20) },
    thing2: { value: '无人出价，已流拍' },
    thing3: { value: '可重新发布' },
  });
}

module.exports = {
  notify,
  notifyAuctionWon,
  notifyAuctionLost,
  notifyOrderReceived,
  notifyAuctionFailedToPublisher,
};
