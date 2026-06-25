const db = require('../db');
const sms = require('./sms');
const wechat = require('./wechat-notify');
const wecom = require('./wecom-notify');
const settings = require('./settings');

function notify(userId, type, title, content, relatedId = null, imageUrl = null) {
  db.prepare(`
    INSERT INTO messages (user_id, type, title, content, related_id, image_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, type, title, content, relatedId, imageUrl, Date.now());
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
    buyer_won: '货源报价成功',
    buyer_lost: '货源报价失败',
    seller: '您的货源已被成功报价',
  }[scenario]) || scenario;
}

// 通知平台方（企业微信 + 短信，按 settings）
function dispatchPlatformChannels(resource, seller, buyer, finalPrice) {
  const sellerInfo = `${seller.name || '未填名'} / 微信:${seller.wechat_openid ? seller.wechat_openid.slice(0, 8) + '…' : '无'} / ${seller.phone || '无'}`;
  const buyerInfo  = `${buyer.name  || '未填名'} / 微信:${buyer.wechat_openid  ? buyer.wechat_openid.slice(0, 8)  + '…' : '无'} / ${buyer.phone  || '无'}`;

  const wecomText = [
    '【凤伯乐·报价成交】',
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

// 场景 1：买家报价成功（中标）
function notifyAuctionWon(userId, resource, price) {
  const u = getUser(userId); if (!u) return;
  notify(u.id, 'auction_won', '🎉 报价成功',
    `恭喜！您以 ${price} 元订下「${resource.title}」`, resource.id);
  dispatchUserChannels(u, 'buyer_won', resource.title, resource.id, false);
}

// 场景 2：买家未中标 / 未成交
function notifyAuctionLost(userId, resource, finalPrice) {
  const u = getUser(userId); if (!u) return;
  const title = finalPrice ? '未中标' : '未成交';
  const content = finalPrice
    ? `「${resource.title}」已被其他买家以 ${finalPrice} 元订下，您的保证金已退还`
    : `「${resource.title}」无人成交，未成交，您的保证金已退还`;
  notify(u.id, finalPrice ? 'auction_lost' : 'auction_failed', title, content, resource.id);
  dispatchUserChannels(u, 'buyer_lost', resource.title, resource.id, false);
}

// 场景 3：发布方收到订单（货已成交）
function notifyOrderReceived(userId, resource, finalPrice, isSupply) {
  const u = getUser(userId); if (!u) return;
  notify(u.id, 'order_received', '🎉 您的货源已被报价成功',
    `「${resource.title}」已以 ${finalPrice} 元成交`, resource.id);
  dispatchUserChannels(u, 'seller', resource.title, resource.id, true);
}

// 场景：无人报价时发布方收到未成交
function notifyAuctionFailedToPublisher(userId, resource, isSupply) {
  const u = getUser(userId); if (!u) return;
  notify(u.id, 'auction_failed', '😔 未成交',
    `「${resource.title}」无人${isSupply ? '报价' : '应标'}，未成交`, resource.id);
  dispatchUserChannels(u, 'buyer_lost', resource.title, resource.id, true);
}

// 场景：订单生成后向买卖双方下发企业微信服务二维码 + 提示扫码加好友
function notifyOrderGroupReady(orderId, buyerId, sellerId, resource) {
  const qrUrl = settings.get('service_qr_url');
  const owner = settings.get('service_qr_owner') || '凤伯乐 · 客服';
  if (!qrUrl) return;  // 后台未上传二维码则不下发

  const title = '📲 交易疑问？联系客服';
  const content = `订单 #${orderId}「${resource.title}」已成交。\n订单履约或买卖双方沟通中如有疑问，可扫码添加 ${owner} 的企业微信进行咨询，由客服协助解答与协调。`;

  notify(buyerId,  'order_group', title, content, orderId, qrUrl);
  notify(sellerId, 'order_group', title, content, orderId, qrUrl);

  // 企业微信机器人：通知客服去人工拉群
  try {
    const buyer = getUser(buyerId);
    const seller = getUser(sellerId);
    const txt = [
      '【凤伯乐·待拉群】',
      `订单 #${orderId}：${resource.title}`,
      `买方：${buyer && buyer.name || '?'}（${buyer && buyer.phone || '?'}）`,
      `卖方：${seller && seller.name || '?'}（${seller && seller.phone || '?'}）`,
      '请等买卖双方扫码加好友后建群。',
    ].join('\n');
    wecom.send(txt);
  } catch (e) {}
}

// 场景：报价成交时通知平台方（企业微信 + 平台短信）
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
  notifyOrderGroupReady,
  notifyPlatformOnDeal,
};
