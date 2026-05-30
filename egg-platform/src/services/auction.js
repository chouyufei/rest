const db = require('../db');
const { notify } = require('./notification');

const ANTI_SNIPE_WINDOW_MS = 5 * 60 * 1000;
const EXTENSION_MS = 5 * 60 * 1000;
const MAX_EXTENSIONS = 3;
const FARM_DEPOSIT_AMOUNT = Number(process.env.FARM_DEPOSIT_AMOUNT) || 0.1;
const BUYER_DEPOSIT_AMOUNT = Number(process.env.BUYER_DEPOSIT_AMOUNT) || 200;

function getResource(id) {
  return db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
}

function freezeBuyerDeposit(userId, resourceId) {
  const dep = db.prepare(`
    SELECT * FROM deposits
    WHERE user_id = ? AND type IN ('buyer_bid','farm_quality') AND status = 'available'
    ORDER BY type DESC
    LIMIT 1
  `).get(userId);
  if (dep) {
    db.prepare(`UPDATE deposits SET status='frozen', frozen_for=? WHERE id=?`).run(resourceId, dep.id);
    return dep;
  }
  const existingFrozen = db.prepare(`
    SELECT * FROM deposits
    WHERE user_id = ? AND type IN ('buyer_bid','farm_quality') AND status = 'frozen' AND frozen_for = ?
  `).get(userId, resourceId);
  return existingFrozen;
}

function placeBidTx(resourceId, bidderId, price, isAuto = 0, maxPrice = null) {
  const now = Date.now();
  const resource = getResource(resourceId);
  if (!resource) throw new Error('资源不存在');
  if (resource.status !== 'auctioning') throw new Error('竞拍未进行中');
  if (now < resource.start_at) throw new Error('竞拍未开始');
  if (now > resource.end_at) throw new Error('竞拍已结束');
  if (resource.farm_id === bidderId) throw new Error('不能参与自己发布的竞拍');

  const isSupply = (resource.kind || 'supply') === 'supply';
  if (isSupply) {
    const requiredMin = (resource.current_bidder_id ? resource.current_price : resource.start_price - resource.min_increment) + resource.min_increment;
    if (price < requiredMin) throw new Error(`出价需 ≥ ${requiredMin} 元`);
  } else {
    const requiredMax = (resource.current_bidder_id ? resource.current_price : resource.start_price + resource.min_increment) - resource.min_increment;
    if (price > requiredMax) throw new Error(`报价需 ≤ ${requiredMax} 元`);
  }

  const dep = freezeBuyerDeposit(bidderId, resourceId);
  if (!dep) throw new Error(isSupply ? '请先缴纳 200 元竞拍保证金' : '请先缴纳保证金（养殖场 1000 / 采购商 200）');

  db.prepare(`
    INSERT INTO bids (resource_id, bidder_id, price, is_auto, max_price, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(resourceId, bidderId, price, isAuto, maxPrice, now);

  const prevBidder = resource.current_bidder_id;
  let newEndAt = resource.end_at;
  let newExtendCount = resource.extend_count;
  const timeLeft = resource.end_at - now;
  if (timeLeft <= ANTI_SNIPE_WINDOW_MS && newExtendCount < MAX_EXTENSIONS) {
    newEndAt = resource.end_at + EXTENSION_MS;
    newExtendCount += 1;
    notify(resource.farm_id, 'auction_extended', '竞拍延时',
      `「${resource.title}」因最后5分钟出价，延长5分钟（第${newExtendCount}次/共3次）`, resource.id);
  }

  db.prepare(`
    UPDATE resources
    SET current_price = ?, current_bidder_id = ?, end_at = ?, extend_count = ?
    WHERE id = ?
  `).run(price, bidderId, newEndAt, newExtendCount, resourceId);

  if (prevBidder && prevBidder !== bidderId) {
    db.prepare(`
      UPDATE deposits SET status='available', frozen_for=NULL
      WHERE user_id = ? AND type='buyer_bid' AND status='frozen' AND frozen_for = ?
    `).run(prevBidder, resourceId);
    notify(prevBidder, 'outbid', isSupply ? '被反超' : '被压价', `您在「${resource.title}」的${isSupply ? '出价' : '报价'}已被超过`, resourceId);
  }

  notify(resource.farm_id, 'new_bid', isSupply ? '新出价' : '新报价', `「${resource.title}」收到 ${price} 元${isSupply ? '出价' : '报价'}`, resourceId);

  triggerAutoBids(resourceId, bidderId);

  return getResource(resourceId);
}

function triggerAutoBids(resourceId, latestBidderId) {
  const resource = getResource(resourceId);
  if (!resource || resource.status !== 'auctioning') return;

  if ((resource.kind || 'supply') !== 'supply') return;

  const autoBids = db.prepare(`
    SELECT * FROM auto_bids
    WHERE resource_id = ? AND active = 1 AND bidder_id != ?
    ORDER BY max_price DESC, created_at ASC
  `).all(resourceId, resource.current_bidder_id);

  for (const ab of autoBids) {
    const next = resource.current_price + resource.min_increment;
    if (ab.max_price >= next && ab.bidder_id !== resource.current_bidder_id) {
      try {
        placeBidTx(resourceId, ab.bidder_id, next, 1, ab.max_price);
        return;
      } catch (e) {
        db.prepare('UPDATE auto_bids SET active=0 WHERE id=?').run(ab.id);
      }
    }
  }
}

function closeAuction(resourceId) {
  const r = getResource(resourceId);
  if (!r || r.status !== 'auctioning') return;
  const now = Date.now();
  if (now < r.end_at) return;

  const isSupply = (r.kind || 'supply') === 'supply';

  if (r.current_bidder_id) {
    db.prepare(`UPDATE resources SET status='sold' WHERE id=?`).run(r.id);
    const farmId = isSupply ? r.farm_id : r.current_bidder_id;
    const buyerId = isSupply ? r.current_bidder_id : r.farm_id;
    db.prepare(`
      INSERT INTO orders (resource_id, farm_id, buyer_id, final_price, quantity, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending_group', ?)
    `).run(r.id, farmId, buyerId, r.current_price, r.quantity, now);

    notify(r.farm_id, 'auction_won', '竞拍成交',
      `「${r.title}」以 ${r.current_price} 元成交，请在群中沟通发货${isSupply ? '' : '（您是采购方）'}` + ' [SMS: 已发送短信提醒]', r.id);
    notify(r.current_bidder_id, 'auction_won', isSupply ? '竞拍成功' : '应标成功',
      `恭喜！您以 ${r.current_price} 元${isSupply ? '拍下' : '中标'}「${r.title}」 [SMS: 已发送短信提醒]`, r.id);

    db.prepare(`
      UPDATE deposits SET status='available', frozen_for=NULL
      WHERE type IN ('buyer_bid','farm_quality') AND status='frozen' AND frozen_for=? AND user_id != ?
    `).run(r.id, r.current_bidder_id);
  } else {
    db.prepare(`UPDATE resources SET status='failed' WHERE id=?`).run(r.id);
    notify(r.farm_id, 'auction_failed', '流拍', `「${r.title}」无人${isSupply ? '出价' : '应标'}，已流拍`, r.id);
    db.prepare(`
      UPDATE deposits SET status='available', frozen_for=NULL
      WHERE type IN ('buyer_bid','farm_quality') AND status='frozen' AND frozen_for=?
    `).run(r.id);
  }
}

function sweep() {
  const now = Date.now();
  db.prepare(`UPDATE resources SET status='auctioning' WHERE status='draft' AND start_at <= ?`).run(now);
  const expired = db.prepare(`SELECT id FROM resources WHERE status='auctioning' AND end_at <= ?`).all(now);
  for (const row of expired) closeAuction(row.id);

  const now7d = now - 7 * 24 * 60 * 60 * 1000;
  const autoOrders = db.prepare(`
    SELECT * FROM orders
    WHERE status='communicating' AND group_created_at IS NOT NULL AND group_created_at <= ? AND confirmed_at IS NULL
  `).all(now7d);
  for (const order of autoOrders) {
    db.prepare(`UPDATE orders SET status='completed', confirmed_at=? WHERE id=?`).run(now, order.id);
    releaseDeposits(order.id);
    notify(order.buyer_id, 'order_auto_complete', '订单自动完成', `订单 #${order.id} 7天未操作自动确认收货`, order.id);
    notify(order.farm_id, 'order_auto_complete', '订单自动完成', `订单 #${order.id} 已自动确认收货并释放保证金`, order.id);
  }
}

function releaseDeposits(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) return;
  db.prepare(`
    UPDATE deposits SET status='available', frozen_for=NULL, released_at=?
    WHERE type IN ('buyer_bid','farm_quality') AND frozen_for=?
  `).run(Date.now(), order.resource_id);
}

module.exports = {
  placeBidTx,
  closeAuction,
  sweep,
  triggerAutoBids,
  releaseDeposits,
  FARM_DEPOSIT_AMOUNT,
  BUYER_DEPOSIT_AMOUNT,
  ANTI_SNIPE_WINDOW_MS,
  EXTENSION_MS,
  MAX_EXTENSIONS,
};
