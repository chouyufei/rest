const db = require('../db');
const sms = require('./sms');
const wechat = require('./wechat-notify');
const wecom = require('./wecom-notify');
const settings = require('./settings');

function notify(userId, type, title, content, relatedId = null) {
  db.prepare(`
    INSERT INTO messages (user_id, type, title, content, related_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, type, title, content, relatedId, Date.now());
}

function getUser(userId) {
  return db.prepare('SELECT id, phone, wechat_openid, name FROM users WHERE id = ?').get(userId);
}

function isRealPhone(p) { return typeof p === 'string' && /^1\d{10}$/.test(p); }

// 内部：发给某个用户（买/卖），按 settings 开关决定是否发短信
function dispatchUserChannels(user, scenario, resourceTitle, resourceId, isSeller) {
  const page = '/pages/resource-detail/resource-detail?id=' + resourceId;
  wechat.send(user.wechat_openid, scenario, resourceTitle, page);

  // 短信：分卖方/买方开关
  const enable = isSeller ? settings.get('notify_seller_sms') : settings.get('notify_buyer_sms');
  if (enable && isRealPhone(user.phone)) {
    const resultText = wechatResultText(scenario);
    sms.sendUserNotice(user.phone, resourceTitle, resultText);
  }
}

function wechatResultText(scenario) {
  return ({
    buyer_won: '货源竞拍成功',
    buyer_lost: '货源竞拍失败',
    seller: '您的货源已被成功竞拍',
  }[scenario]) || scenario;
}

// 通知平台方（企业微信 + 短信，按 settings）
function dispatchPlatformChannels(resource, seller, buyer, finalPrice) {
  const sellerInfo = `${seller.name || '未填名'} / 微信:${seller.wechat_openid ? seller.wechat_openid.slice(0, 8) + '…' : '无'} / ${seller.phone || '无'}`;
  const buyerInfo  = `${buyer.name  || '未填名'} / 微信:${buyer.wechat_openid  ? buyer.wechat_openid.slice(0, 8)  + '…' : '无'} / ${buyer.phone  || '无'}`;

  const wecomText = [
    '【凤伯乐·竞拍成交】',
    `货源：${resource.title}`,
    `成交价：¥${finalPrice}`,
    `卖方：${sellerInfo}`,
    `买方：${buyerInfo}`,
  ].join('\n');
  wecom.send(wecomText);

  if (settings.get('notify_platform_sms')) {
    const phones = settings.get('platform_phones') || [];
    for (const p of phones) {
      if (isRealPhone(p)) sms.sendPlatformNotice(p, resource.title, sellerInfo, buyerInfo);
    }
  }
}

// 场景 1：买家竞拍成功（中标）
function notifyAuctionWon(userId, resource, price) {
  const u = getUser(userId); if (!u) return;
  notify(u.id, 'auction_won', '🎉 竞拍成功',
    `恭喜！您以 ${price} 元拍下「${resource.title}」`, resource.id);
  dispatchUserChannels(u, 'buyer_won', resource.title, resource.id, false);
}

// 场景 2：买家未中标 / 流拍
function notifyAuctionLost(userId, resource, finalPrice) {
  const u = getUser(userId); if (!u) return;
  const title = finalPrice ? '未中标' : '已流拍';
  const content = finalPrice
    ? `「${resource.title}」已被其他买家以 ${finalPrice} 元拍下，您的保证金已退还`
    : `「${resource.title}」无人成交，已流拍，您的保证金已退还`;
  notify(u.id, finalPrice ? 'auction_lost' : 'auction_failed', title, content, resource.id);
  dispatchUserChannels(u, 'buyer_lost', resource.title, resource.id, false);
}

// 场景 3：发布方收到订单（货被拍下）
function notifyOrderReceived(userId, resource, finalPrice, isSupply) {
  const u = getUser(userId); if (!u) return;
  notify(u.id, 'order_received', '🎉 您的货源已被竞拍成功',
    `「${resource.title}」已以 ${finalPrice} 元成交`, resource.id);
  dispatchUserChannels(u, 'seller', resource.title, resource.id, true);
}

// 场景：无人出价时发布方收到流拍
function notifyAuctionFailedToPublisher(userId, resource, isSupply) {
  const u = getUser(userId); if (!u) return;
  notify(u.id, 'auction_failed', '😔 流拍',
    `「${resource.title}」无人${isSupply ? '出价' : '应标'}，已流拍`, resource.id);
  dispatchUserChannels(u, 'buyer_lost', resource.title, resource.id, true);
}

// 场景：竞拍成交时通知平台方（企业微信 + 平台短信）
function notifyPlatformOnDeal(resource, sellerId, buyerId, finalPrice) {
  const seller = getUser(sellerId);
  const buyer = getUser(buyerId);
  if (!seller || !buyer) return;
  dispatchPlatformChannels(resource, seller, buyer, finalPrice);
}

module.exports = {
  notify,
  notifyAuctionWon,
  notifyAuctionLost,
  notifyOrderReceived,
  notifyAuctionFailedToPublisher,
  notifyPlatformOnDeal,
};
