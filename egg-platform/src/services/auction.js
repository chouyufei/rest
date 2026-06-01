const db = require('../db');
const { notify } = require('./notification');

const ANTI_SNIPE_WINDOW_MS = 5 * 60 * 1000; // 最后一次出价后静默此时长即成交
const FARM_DEPOSIT_AMOUNT = Number(process.env.FARM_DEPOSIT_AMOUNT) || 0.1;
const BUYER_DEPOSIT_AMOUNT = Number(process.env.BUYER_DEPOSIT_AMOUNT) || 0.1;

function getResource(id) {
  return db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
}

// 竞拍保证金按「资源」绑定：每个货源单独一笔。返回该用户对该资源的有效保证金，没有则 null。
function resourceDeposit(userId, resourceId) {
  return db.prepare(`
    SELECT * FROM deposits
    WHERE user_id = ? AND type = 'buyer_bid' AND resource_id = ? AND status IN ('available','frozen')
  `).get(userId, resourceId);
}

function placeBidTx(resourceId, bidderId, price, isAuto = 0, maxPrice = null) {
  const now = Date.now();
  const resource = getResource(resourceId);
  if (!resource) throw new Error('资源不存在');
  if (resource.status !== 'auctioning') throw new Error('竞拍未进行中');
  if (now < resource.start_at) throw new Error('竞拍未开始');
  if (now > resource.end_at && !resource.current_bidder_id) throw new Error('竞拍已结束');
  if (resource.farm_id === bidderId) throw new Error('不能参与自己发布的竞拍');

  const isSupply = (resource.kind || 'supply') === 'supply';
  if (isSupply) {
    const requiredMin = (resource.current_bidder_id ? resource.current_price : resource.start_price - resource.min_increment) + resource.min_increment;
    if (price < requiredMin) throw new Error(`出价需 ≥ ${requiredMin} 元`);
  } else {
    const requiredMax = (resource.current_bidder_id ? resource.current_price : resource.start_price + resource.min_increment) - resource.min_increment;
    if (price > requiredMax) throw new Error(`报价需 ≤ ${requiredMax} 元`);
  }

  const dep = resourceDeposit(bidderId, resourceId);
  if (!dep) throw new Error('请先为该竞拍缴纳保证金');

  db.prepare(`
    INSERT INTO bids (resource_id, bidder_id, price, is_auto, max_price, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(resourceId, bidderId, price, isAuto, maxPrice, now);

  const prevBidder = resource.current_bidder_id;

  // 软关闭：每次出价刷新 last_bid_at。静默满 ANTI_SNIPE_WINDOW_MS 即成交（见 closeAuction）。
  db.prepare(`
    UPDATE resources
    SET current_price = ?, current_bidder_id = ?, last_bid_at = ?
    WHERE id = ?
  `).run(price, bidderId, now, resourceId);

  if (prevBidder && prevBidder !== bidderId) {
    notify(prevBidder, 'outbid', isSupply ? '被反超' : '被压价',
      `您在「${resource.title}」的${isSupply ? '出价' : '报价'}已被超过，可继续出价`, resourceId);
  }

  notify(resource.farm_id, 'new_bid', isSupply ? '新出价' : '新报价',
    `「${resource.title}」收到 ${price} 元${isSupply ? '出价' : '报价'}`, resourceId);

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

function closeAuction(resourceId, force = false) {
  const r = getResource(resourceId);
  if (!r || r.status !== 'auctioning') return;
  const now = Date.now();

  // 软关闭规则：
  //  - 有出价：最后一次出价后静默满 5 分钟即成交（不必等到计划结束时间）；
  //    只要有人在 5 分钟内继续出价就一直顺延（无限防狙击）。
  //  - 无出价：到计划结束时间即流拍。
  //  - force=true：发布方手动结束竞拍，跳过静默检查直接按当前最高价成交。
  if (!force) {
    if (r.current_bidder_id) {
      const lastBid = r.last_bid_at || r.start_at;
      if (now - lastBid < ANTI_SNIPE_WINDOW_MS) return;
    } else {
      if (now < r.end_at) return;
    }
  }

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

    // 未中标者的该资源保证金 → 释放退还；中标者保留至订单完成
    db.prepare(`
      UPDATE deposits SET status='available', released_at=?
      WHERE type='buyer_bid' AND resource_id=? AND user_id != ? AND status IN ('available','frozen')
    `).run(now, r.id, r.current_bidder_id);
  } else {
    db.prepare(`UPDATE resources SET status='failed' WHERE id=?`).run(r.id);
    notify(r.farm_id, 'auction_failed', '流拍', `「${r.title}」无人${isSupply ? '出价' : '应标'}，已流拍`, r.id);
    db.prepare(`
      UPDATE deposits SET status='available', released_at=?
      WHERE type='buyer_bid' AND resource_id=? AND status IN ('available','frozen')
    `).run(now, r.id);
  }
}

function sweep() {
  const now = Date.now();
  db.prepare(`UPDATE resources SET status='auctioning' WHERE status='draft' AND start_at <= ?`).run(now);
  // 候选：到计划结束时间（用于无人出价流拍），或已有出价且静默满 5 分钟（软关闭成交）。
  const silenceCutoff = now - ANTI_SNIPE_WINDOW_MS;
  const expired = db.prepare(`
    SELECT id FROM resources
    WHERE status='auctioning' AND (
      (current_bidder_id IS NULL AND end_at <= ?) OR
      (current_bidder_id IS NOT NULL AND COALESCE(last_bid_at, start_at) <= ?)
    )
  `).all(now, silenceCutoff);
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
  // 释放中标者绑定在该资源上的竞拍保证金
  db.prepare(`
    UPDATE deposits SET status='available', released_at=?
    WHERE type='buyer_bid' AND resource_id=? AND status IN ('available','frozen')
  `).run(Date.now(), order.resource_id);
}

module.exports = {
  placeBidTx,
  closeAuction,
  sweep,
  triggerAutoBids,
  releaseDeposits,
  resourceDeposit,
  FARM_DEPOSIT_AMOUNT,
  BUYER_DEPOSIT_AMOUNT,
  ANTI_SNIPE_WINDOW_MS,
};
