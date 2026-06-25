const db = require('../db');
const settings = require('./settings');
const balance = require('./balance');

// 把一组保证金（按 SQL 条件查得）按"模型"释放：
//   - from_balance=1（钱包冻结模型）→ balance.unlock：balance 不变，locked - amount
//   - from_balance=0（老的微信支付外充模型）→ balance.credit：balance + amount
// 已 released/deducted 的会被 WHERE 过滤掉；balance_transactions 表的
// dedup 检查避免万一重复入账。
function releaseAndCredit(whereClause, ...params) {
  const rows = db.prepare(`SELECT * FROM deposits WHERE status IN ('available','frozen') AND ${whereClause}`).all(...params);
  for (const dep of rows) {
    db.prepare(`UPDATE deposits SET status='released', released_at=? WHERE id=?`).run(Date.now(), dep.id);
    const fromBalance = Number(dep.from_balance) === 1;
    const txType = fromBalance ? 'deposit_unlock' : 'deposit_release';
    const dup = db.prepare(`SELECT id FROM balance_transactions WHERE type=? AND ref_type='deposit' AND ref_id=?`).get(txType, dep.id);
    if (dup) continue;
    if (fromBalance) {
      // 新模型：lock() 时 balance 没变、locked +amt；释放时只 unlock，不能 credit，否则余额翻倍。
      try {
        balance.unlock(dep.user_id, dep.amount, {
          type: 'deposit_unlock',
          ref_type: 'deposit',
          ref_id: dep.id,
          note: `保证金解冻 #${dep.id}`,
        });
      } catch (e) {
        // 冻结余额不足等异常：跳过，避免抛错卡住后续清理
        console.warn('[releaseAndCredit] unlock 失败', { depositId: dep.id, error: e.message });
      }
    } else {
      // 老模型：钱原本在 deposits 表外，释放时入账钱包。
      balance.credit(dep.user_id, dep.amount, {
        type: 'deposit_release',
        ref_type: 'deposit',
        ref_id: dep.id,
        note: `保证金释放 #${dep.id}`,
      });
    }
  }
  return rows.length;
}

// 释放某个资源相关的所有保证金（取消 / 未成交 / 确认成交场景的便捷入口）
function releaseResourceDeposits(resourceId) {
  // 新模型（from_balance=1）：解冻回钱包可用余额
  const newOnes = db.prepare(`
    SELECT * FROM deposits
    WHERE resource_id=? AND status='frozen' AND from_balance=1
  `).all(resourceId);
  for (const dep of newOnes) {
    db.prepare(`UPDATE deposits SET status='released', released_at=? WHERE id=?`).run(Date.now(), dep.id);
    const dup = db.prepare(`SELECT id FROM balance_transactions WHERE type='deposit_unlock' AND ref_type='deposit' AND ref_id=?`).get(dep.id);
    if (dup) continue;
    balance.unlock(dep.user_id, dep.amount, {
      type: 'deposit_unlock',
      ref_type: 'deposit',
      ref_id: dep.id,
      note: `保证金解冻 #${dep.id}`,
    });
  }
  // 旧模型（from WeChat Pay）：旧逻辑——release 入账钱包
  return newOnes.length + releaseAndCredit(`resource_id=? AND COALESCE(from_balance,0)=0`, resourceId);
}

// 锁定一笔保证金到资源上：从用户钱包可用余额扣到冻结部分，并写 deposits 行。
// 同一用户对同一资源已有 frozen 保证金 → 直接返回该行（幂等）
// 余额不足 → 抛 "INSUFFICIENT_BALANCE" 错误，前端弹"去充值"
function lockDepositForResource({ userId, resourceId, type }) {
  const existing = db.prepare(`
    SELECT * FROM deposits
    WHERE user_id=? AND resource_id=? AND type=? AND status IN ('available','frozen')
  `).get(userId, resourceId, type);
  if (existing) return existing;

  const amount = computeDepositAmount();
  const { available } = balance.getBalance(userId);
  // 浮点对比要按分（整数）算，避免 1.00 vs 1 被判成"差 0.00 元"
  if (Math.round(available * 100) < Math.round(amount * 100)) {
    const e = new Error(`钱包可用余额不足，需 ${amount} 元，当前可用 ${available.toFixed(2)} 元`);
    e.code = 'INSUFFICIENT_BALANCE';
    e.required = amount;
    e.available = available;
    throw e;
  }

  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO deposits (user_id, type, amount, status, resource_id, note, paid_at, from_balance)
    VALUES (?, ?, ?, 'frozen', ?, ?, ?, 1)
  `).run(userId, type, amount, resourceId, `钱包冻结 · 资源 #${resourceId}`, now);

  balance.lock(userId, amount, {
    type: 'deposit_lock',
    ref_type: 'deposit',
    ref_id: info.lastInsertRowid,
    note: `冻结保证金 · 资源 #${resourceId}`,
  });

  return db.prepare('SELECT * FROM deposits WHERE id=?').get(info.lastInsertRowid);
}

// 订单完成时：
//  1) 把该资源上所有"新模型"冻结保证金全额解冻（buyer + seller 都各自回各自的可用余额）
//  2) 从卖方账户直接扣后台设置的 service_fee_amount（不受冻结金额限制；
//     若余额不足，只扣到 0，不允许负数）
//  两步都用 balance_transactions 做幂等，重复调用安全
function settleOrderDeposits(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) return;
  const fee = computeServiceFee();
  const now = Date.now();

  // 1) 解冻所有 frozen 保证金
  const rows = db.prepare(`
    SELECT * FROM deposits WHERE resource_id=? AND status='frozen' AND from_balance=1
  `).all(order.resource_id);
  for (const dep of rows) {
    const dup = db.prepare(`
      SELECT id FROM balance_transactions
      WHERE type='deposit_unlock' AND ref_type='deposit' AND ref_id=?
    `).get(dep.id);
    if (!dup) {
      try {
        balance.unlock(dep.user_id, dep.amount, {
          type: 'deposit_unlock',
          ref_type: 'deposit',
          ref_id: dep.id,
          note: `订单 #${order.id} 保证金解冻`,
        });
      } catch (e) {
        console.warn('[settleOrderDeposits] unlock 失败', { depositId: dep.id, error: e.message });
      }
    }
    db.prepare(`UPDATE deposits SET status='released', released_at=?, note=? WHERE id=?`)
      .run(now, `订单 #${order.id} 解冻`, dep.id);
  }

  // 2) 卖方账户扣服务费（直接 balance -fee；不要求资金一定来自 locked）
  if (fee > 0 && order.farm_id) {
    const dupFee = db.prepare(`
      SELECT id FROM balance_transactions
      WHERE type='service_fee' AND ref_type='order' AND ref_id=?
    `).get(order.id);
    if (!dupFee) {
      balance.debit(order.farm_id, fee, {
        type: 'service_fee',
        ref_type: 'order',
        ref_id: order.id,
        note: `订单 #${order.id} 平台服务费`,
      });
    }
  }
}

// 一次性数据补救：把所有"应已释放但未入账"的历史保证金，统一补释放 + 入账。
// 适用于在钱包系统上线"之前"已经处于 available 状态、或绑定到已结束资源
// 但仍是 frozen 状态的旧记录。幂等：靠 balance_transactions dedup 不会重复入账。
function reconcileLegacyDeposits() {
  // 1) status='available' 且没 resource_id（旧的"一次性保证金"模型留下来的）
  releaseAndCredit(`status='available' AND resource_id IS NULL`);

  // 2) status='frozen' 但绑定的资源已结束（sold/failed/cancelled）→ 漏放的
  const stuck = db.prepare(`
    SELECT d.id FROM deposits d
    JOIN resources r ON r.id = d.resource_id
    WHERE d.status='frozen' AND r.status IN ('sold','failed','cancelled')
  `).all();
  for (const row of stuck) releaseAndCredit(`id=?`, row.id);

  // 3) status='available' 且绑定的资源已结束 → 之前的 closeAuction 改的旧记录
  const oldReleased = db.prepare(`
    SELECT d.id FROM deposits d
    JOIN resources r ON r.id = d.resource_id
    WHERE d.status='available' AND r.status IN ('sold','failed','cancelled')
  `).all();
  for (const row of oldReleased) releaseAndCredit(`id=?`, row.id);
}
const {
  notify,
  notifyAuctionWon,
  notifyAuctionLost,
  notifyOrderReceived,
  notifyAuctionFailedToPublisher,
  notifyOrderGroupReady,
  notifyPlatformOnDeal,
} = require('./notification');

// 统一保证金：所有三类（发布货源 / 发起求购 / 参与报价）固定一笔，
// 后台 settings.deposit_amount 可改。原签名 (type, qty) 保留兼容旧调用点。
function computeDepositAmount(/* type, qty */) {
  return Number(settings.get('deposit_amount')) || 0;
}
function computeServiceFee() {
  return Number(settings.get('service_fee_amount')) || 0;
}

function getResource(id) {
  return db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
}

// 服务保障金按「资源」绑定：每个货源单独一笔。返回该用户对该资源的有效保证金，没有则 null。
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
  if (resource.status !== 'auctioning') throw new Error('报价未进行中');
  if (now < resource.start_at) throw new Error('报价未开始');
  if (now > resource.end_at && !resource.current_bidder_id) throw new Error('报价已结束');
  if (resource.farm_id === bidderId) throw new Error('不能参与自己发布的报价');

  const isSupply = (resource.kind || 'supply') === 'supply';
  if (isSupply) {
    const requiredMin = (resource.current_bidder_id ? resource.current_price : resource.start_price - resource.min_increment) + resource.min_increment;
    if (price < requiredMin) throw new Error(`报价需 ≥ ${requiredMin} 元`);
  } else {
    const requiredMax = (resource.current_bidder_id ? resource.current_price : resource.start_price + resource.min_increment) - resource.min_increment;
    if (price > requiredMax) throw new Error(`报价需 ≤ ${requiredMax} 元`);
  }

  const dep = resourceDeposit(bidderId, resourceId);
  if (!dep) throw new Error('请先为该报价缴纳保证金');

  db.prepare(`
    INSERT INTO bids (resource_id, bidder_id, price, is_auto, max_price, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(resourceId, bidderId, price, isAuto, maxPrice, now);

  const prevBidder = resource.current_bidder_id;

  // 每次报价刷新 last_bid_at（记录用，参与排序 / 展示）。
  db.prepare(`
    UPDATE resources
    SET current_price = ?, current_bidder_id = ?, last_bid_at = ?
    WHERE id = ?
  `).run(price, bidderId, now, resourceId);

  if (prevBidder && prevBidder !== bidderId) {
    notify(prevBidder, 'outbid', isSupply ? '被反超' : '被压价',
      `您在「${resource.title}」的${isSupply ? '报价' : '报价'}已被超过，可继续报价`, resourceId);
  }

  notify(resource.farm_id, 'new_bid', isSupply ? '新报价' : '新报价',
    `「${resource.title}」收到 ${price} 元${isSupply ? '报价' : '报价'}`, resourceId);

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

  // 关闭规则：
  //  - 到了 end_at（订单有效期到期）：按当前最优报价成交，没人报价则未成交。
  //  - force=true：发布方手动确认成交，跳过时间检查直接按当前最高价成交。
  if (!force && now < r.end_at) return;

  const isSupply = (r.kind || 'supply') === 'supply';

  if (r.current_bidder_id) {
    db.prepare(`UPDATE resources SET status='sold' WHERE id=?`).run(r.id);
    const farmId = isSupply ? r.farm_id : r.current_bidder_id;
    const buyerId = isSupply ? r.current_bidder_id : r.farm_id;
    // 生成 16 位订单编号：时间戳(13) + 随机(3)
    const orderNo = (String(now).slice(-13) + String(Math.floor(Math.random() * 1000)).padStart(3, '0')).slice(0, 16);
    const orderInfo = db.prepare(`
      INSERT INTO orders (resource_id, farm_id, buyer_id, final_price, quantity, status, order_no, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending_group', ?, ?)
    `).run(r.id, farmId, buyerId, r.current_price, r.quantity, orderNo, now);

    // 站内 + 短信 + 微信订阅消息 三通道
    notifyOrderReceived(r.farm_id, r, r.current_price, isSupply);          // 发布方：单已已成交
    notifyAuctionWon(r.current_bidder_id, r, r.current_price);             // 中标方：报价成功
    notifyPlatformOnDeal(r, farmId, buyerId, r.current_price);             // 平台方：企业微信 + 短信

    // 订单已生成 → 给买卖双方下发企业微信客服二维码 + 提示扫码加好友
    notifyOrderGroupReady(orderInfo.lastInsertRowid, buyerId, farmId, r);

    // 未中标的其他报价者：发"未中标"通知 + 释放保证金
    const losers = db.prepare(`
      SELECT DISTINCT bidder_id FROM bids WHERE resource_id=? AND bidder_id != ?
    `).all(r.id, r.current_bidder_id);
    for (const l of losers) notifyAuctionLost(l.bidder_id, r, r.current_price);

    // 未中标的服务保障金：释放 + 自动入账到对应用户余额
    releaseAndCredit(`type='buyer_bid' AND resource_id=? AND user_id != ?`, r.id, r.current_bidder_id);
    // 发布方（货源/求购）保证金：在收货确认后通过 releaseDeposits(orderId) 再释放，这里保持冻结
  } else {
    db.prepare(`UPDATE resources SET status='failed' WHERE id=?`).run(r.id);
    notifyAuctionFailedToPublisher(r.farm_id, r, isSupply);                // 发布方：未成交
    // 未成交：该资源所有保证金（报价方 + 发布方）释放 + 入账
    releaseAndCredit(`resource_id=?`, r.id);
  }
}

function sweep() {
  const now = Date.now();
  db.prepare(`UPDATE resources SET status='auctioning' WHERE status='draft' AND start_at <= ?`).run(now);
  // 候选：到达 end_at（订单有效期到期）的资源；有报价则按最优成交，没报价则未成交
  const expired = db.prepare(`
    SELECT id FROM resources
    WHERE status='auctioning' AND end_at <= ?
  `).all(now);
  for (const row of expired) closeAuction(row.id);

  const AUTO_CONFIRM_DAYS = Number(process.env.AUTO_CONFIRM_DAYS) || 3;
  const now7d = now - AUTO_CONFIRM_DAYS * 24 * 60 * 60 * 1000;
  const autoOrders = db.prepare(`
    SELECT * FROM orders
    WHERE status='communicating' AND group_created_at IS NOT NULL AND group_created_at <= ? AND confirmed_at IS NULL
  `).all(now7d);
  for (const order of autoOrders) {
    db.prepare(`UPDATE orders SET status='completed', confirmed_at=? WHERE id=?`).run(now, order.id);
    releaseDeposits(order.id);
    const oLabel = order.order_no ? '订单 ' + order.order_no : '订单 #' + order.id;
    notify(order.buyer_id, 'order_auto_complete', '订单自动完成', `${oLabel} 7天未操作自动确认收货`, order.id);
    notify(order.farm_id, 'order_auto_complete', '订单自动完成', `${oLabel} 已自动确认收货并释放保证金`, order.id);
  }
}

function releaseDeposits(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) return;
  // 释放该资源上所有剩余保证金：中标者的服务保障金 + 发布方的货源/求购保证金 → 入账
  releaseAndCredit(`resource_id=?`, order.resource_id);
}

module.exports = {
  placeBidTx,
  closeAuction,
  sweep,
  triggerAutoBids,
  releaseDeposits,
  resourceDeposit,
  computeDepositAmount,
  computeServiceFee,
  lockDepositForResource,
  settleOrderDeposits,
  releaseResourceDeposits,
  reconcileLegacyDeposits,
};
