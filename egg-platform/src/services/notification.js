const db = require('../db');
const sms = require('./sms');
const wechat = require('./wechat-notify');
const wecom = require('./wecom-notify');
const settings = require('./settings');
const { distanceKm } = require('./geo');

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
    sms.sendUserNotice(user.phone, resourceTitle, smsNoticeType(scenario));
  }
}

// 短信提醒类型（对应模板 ${type} 变量）：报价类事件显示「报价提醒」，
// 成交/订单类显示「订单提醒」，附近新货源/求购显示「货源提醒」。
function smsNoticeType(scenario) {
  if (scenario === 'new_bid' || scenario === 'outbid') return '报价提醒';
  if (scenario === 'nearby') return '货源提醒';
  return '订单提醒';
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

  // 优先使用 16 位 order_no 而不是 #自增 id，给用户看的字符串都用编号
  const o = db.prepare('SELECT order_no FROM orders WHERE id=?').get(orderId);
  const oLabel = (o && o.order_no) ? '订单 ' + o.order_no : '订单 #' + orderId;

  const title = '📲 交易疑问？联系客服';
  const content = `${oLabel}「${resource.title}」已成交。\n订单履约或买卖双方沟通中如有疑问，可扫码添加 ${owner} 的企业微信进行咨询，由客服协助解答与协调。`;

  notify(buyerId,  'order_group', title, content, orderId, qrUrl);
  notify(sellerId, 'order_group', title, content, orderId, qrUrl);

  // 企业微信机器人：通知客服去人工拉群
  try {
    const buyer = getUser(buyerId);
    const seller = getUser(sellerId);
    const txt = [
      '【凤伯乐·待拉群】',
      `${oLabel}：${resource.title}`,
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

// 场景：有人出价 → 通知发布方（站内 + 订阅消息 + 短信）
function notifyNewBidToPublisher(userId, resource, price, isSupply) {
  const u = getUser(userId); if (!u) return;
  notify(u.id, 'new_bid', isSupply ? '收到新报价' : '收到新应标',
    `「${resource.title}」收到新报价 ¥${price}`, resource.id);
  dispatchUserChannels(u, 'new_bid', resource.title, resource.id, true);
}

// 场景：出价被超越 → 通知原出价者（站内 + 订阅消息 + 短信）
function notifyOutbid(userId, resource, price, isSupply) {
  const u = getUser(userId); if (!u) return;
  notify(u.id, 'outbid', isSupply ? '您的报价被反超' : '您的报价被压价',
    `「${resource.title}」当前价 ¥${price}，您的报价已被超过，可继续出价`, resource.id);
  dispatchUserChannels(u, 'outbid', resource.title, resource.id, false);
}

// 场景：新货源 / 求购发布 → 给定位在推送半径内的用户推订阅消息 + 站内信
// （排除发布者自己；按 users.lat/lng 与资源 lat/lng 距离过滤）
function notifyNearbyOnPublish(resource) {
  if (resource.lat == null || resource.lng == null) return 0;
  const radius = Number(settings.get('push_radius_km')) || 500;
  const isSupply = (resource.kind || 'supply') === 'supply';
  // 候选：有定位、非发布者、未被封禁
  const users = db.prepare(`
    SELECT id, phone, wechat_openid, lat, lng FROM users
    WHERE lat IS NOT NULL AND lng IS NOT NULL AND id != ? AND COALESCE(banned,0)=0
  `).all(resource.farm_id);
  // 货源(supply)的附近推送对象是潜在采购商→走买方短信开关；
  // 求购(demand)的对象是潜在养殖场→走卖方短信开关。
  const smsEnable = isSupply ? settings.get('notify_buyer_sms') : settings.get('notify_seller_sms');
  let sent = 0;
  const page = '/pages/resource-detail/resource-detail?id=' + resource.id;
  const title = isSupply ? '附近有新货源' : '附近有新求购';
  for (const u of users) {
    const d = distanceKm(Number(resource.lat), Number(resource.lng), Number(u.lat), Number(u.lng));
    if (d == null || d > radius) continue;
    notify(u.id, 'nearby_publish', title,
      `${Math.round(d)}km 内${isSupply ? '新货源' : '新求购'}：「${resource.title}」`, resource.id);
    wechat.send(u.wechat_openid, 'nearby', resource.title, page);
    // 附近货源 → 货源提醒；附近求购 → 采购提醒（分开两类短信）
    if (smsEnable && isRealPhone(u.phone)) {
      sms.sendUserNotice(u.phone, resource.title, isSupply ? '货源提醒' : '采购提醒');
    }
    sent++;
  }
  if (sent) console.log(`[push] 资源 #${resource.id} 推送给 ${sent} 名附近用户（半径 ${radius}km）`);
  return sent;
}

module.exports = {
  notify,
  notifyNearbyOnPublish,
  notifyAuctionWon,
  notifyAuctionLost,
  notifyOrderReceived,
  notifyAuctionFailedToPublisher,
  notifyOrderGroupReady,
  notifyPlatformOnDeal,
  notifyNewBidToPublisher,
  notifyOutbid,
};
