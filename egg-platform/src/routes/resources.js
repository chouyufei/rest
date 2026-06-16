const express = require('express');
const db = require('../db');
const { authRequired, roleRequired } = require('../middleware/auth');
const { closeAuction, sweep, computeDepositAmount, releaseResourceDeposits, lockDepositForResource } = require('../services/auction');
const balance = require('../services/balance');
const { distanceKm } = require('../services/geo');

const NEAR_RADIUS_KM = 500;  // 推荐"附近"范围

const router = express.Router();

function enrich(r) {
  if (!r) return r;
  const farm = db.prepare('SELECT id, name, region, avatar FROM users WHERE id=?').get(r.farm_id);
  const bidCount = db.prepare('SELECT COUNT(*) AS c FROM bids WHERE resource_id=?').get(r.id).c;
  const bidderCount = db.prepare('SELECT COUNT(DISTINCT bidder_id) AS c FROM bids WHERE resource_id=?').get(r.id).c;
  return {
    ...r,
    photos: r.photos ? JSON.parse(r.photos) : [],
    farm,
    bid_count: bidCount,
    bidder_count: bidderCount,
    time_left_ms: Math.max(0, r.end_at - Date.now()),
  };
}

router.get('/', (req, res) => {
  sweep();
  const { status, region, province, color, keyword, sort, kind, breed } = req.query;
  const nearLat = req.query.near_lat ? Number(req.query.near_lat) : null;
  const nearLng = req.query.near_lng ? Number(req.query.near_lng) : null;
  const useNear = Number.isFinite(nearLat) && Number.isFinite(nearLng);

  let sql = 'SELECT * FROM resources WHERE 1=1';
  const params = [];
  if (kind) { sql += ' AND kind = ?'; params.push(kind); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  else { sql += " AND status IN ('auctioning','sold','failed')"; }
  if (region) { sql += ' AND region LIKE ?'; params.push(`%${region}%`); }
  if (province) { sql += ' AND province = ?'; params.push(province); }
  if (color) { sql += ' AND egg_color = ?'; params.push(color); }
  if (breed) { sql += ' AND chicken_breed LIKE ?'; params.push(`%${breed}%`); }
  if (keyword) { sql += ' AND (title LIKE ? OR description LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }

  // 排序：传 near_lat/near_lng 时按 500km 内优先（近 → 远）+ 创建时间次序
  // 其他显式 sort 优先于地理排序
  if (sort === 'price_asc') sql += ' ORDER BY current_price ASC';
  else if (sort === 'price_desc') sql += ' ORDER BY current_price DESC';
  else if (sort === 'ending_soon') sql += " ORDER BY CASE WHEN status='auctioning' THEN end_at ELSE end_at + 999999999999 END ASC";
  else sql += ' ORDER BY created_at DESC';

  let rows = db.prepare(sql).all(...params).map(enrich);

  if (useNear) {
    // 计算每条距离，再"附近优先"重排
    rows = rows.map(r => {
      const d = (r.lat != null && r.lng != null) ? distanceKm(nearLat, nearLng, r.lat, r.lng) : null;
      return { ...r, distance_km: d };
    });
    if (!sort) {
      // 默认排序：先附近（≤500km，按距离升序），再无定位/远（按 created_at 已经在 SQL 排好）
      rows.sort((a, b) => {
        const aNear = a.distance_km != null && a.distance_km <= NEAR_RADIUS_KM;
        const bNear = b.distance_km != null && b.distance_km <= NEAR_RADIUS_KM;
        if (aNear && !bNear) return -1;
        if (!aNear && bNear) return 1;
        if (aNear && bNear) return a.distance_km - b.distance_km;
        return 0; // 远的保持原 created_at 顺序
      });
    }
  }

  res.json({ resources: rows, near_radius_km: useNear ? NEAR_RADIUS_KM : null });
});

router.get('/mine', authRequired, (req, res) => {
  sweep();
  const rows = db.prepare('SELECT * FROM resources WHERE farm_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({ resources: rows.map(enrich) });
});

// 卖家信用 / 宝贝记录
router.get('/seller/:userId', (req, res) => {
  const u = db.prepare(`
    SELECT id, name, role, region, avatar, contact_name, daily_output, main_products,
           farm_size_int, license_status, created_at
    FROM users WHERE id=?
  `).get(req.params.userId);
  if (!u) return res.status(404).json({ error: '卖家不存在' });
  if (u.role !== 'farm') return res.status(400).json({ error: '该用户不是养殖场' });

  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold_cnt,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_cnt,
      SUM(CASE WHEN status='auctioning' THEN 1 ELSE 0 END) AS active_cnt,
      COUNT(*) AS total_cnt
    FROM resources WHERE farm_id=? AND kind='supply'
  `).get(u.id);

  const total = (stats.sold_cnt || 0) + (stats.failed_cnt || 0);
  const successRate = total > 0 ? Math.round((stats.sold_cnt || 0) * 100 / total) : null;

  const active = db.prepare(`
    SELECT * FROM resources WHERE farm_id=? AND kind='supply' AND status='auctioning'
    ORDER BY created_at DESC LIMIT 10
  `).all(u.id).map(enrich);

  const sold = db.prepare(`
    SELECT * FROM resources WHERE farm_id=? AND kind='supply' AND status='sold'
    ORDER BY created_at DESC LIMIT 10
  `).all(u.id).map(enrich);

  res.json({
    seller: u,
    stats: {
      sold_cnt: stats.sold_cnt || 0,
      failed_cnt: stats.failed_cnt || 0,
      active_cnt: stats.active_cnt || 0,
      total_cnt: stats.total_cnt || 0,
      success_rate: successRate,
    },
    active,
    sold,
  });
});

router.get('/:id', (req, res) => {
  sweep();
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  const bids = db.prepare(`
    SELECT b.*, u.name AS bidder_name FROM bids b
    JOIN users u ON u.id = b.bidder_id
    WHERE b.resource_id = ?
    ORDER BY b.created_at DESC
    LIMIT 50
  `).all(r.id).map(b => ({ ...b, bidder_name: maskName(b.bidder_name) }));
  res.json({ resource: enrich(r), bids });
});

function maskName(name) {
  if (!name) return '匿名';
  if (name.length <= 1) return name + '**';
  return name[0] + '**' + name[name.length - 1];
}

router.post('/', authRequired, (req, res) => {
  const kind = req.body.kind === 'demand' ? 'demand' : 'supply';
  const qtyNum = Number(req.body.quantity) || 1;

  // 角色 / 资质校验（保证金在资源创建后从钱包冻结，下面 lockDepositForResource）
  if (kind === 'supply') {
    if (req.user.role !== 'farm') return res.status(403).json({ error: '货源仅限养殖场发布' });
    if (req.user.license_status !== 'approved') return res.status(403).json({ error: '请先完成资质审核' });
  } else {
    if (req.user.role !== 'buyer') return res.status(403).json({ error: '求购仅限采购商发布' });
  }
  // 预检：可用余额够不够一笔保证金
  const needAmount = computeDepositAmount();
  const wallet = balance.getBalance(req.user.id);
  if (wallet.available < needAmount) {
    return res.status(402).json({
      error: `钱包可用余额不足，需冻结 ${needAmount} 元，当前可用 ${wallet.available.toFixed(2)} 元`,
      code: 'INSUFFICIENT_BALANCE',
      required: needAmount,
      available: wallet.available,
      short: needAmount - wallet.available,
    });
  }

  const {
    title, region, province, chicken_breed, farm_size, egg_color, weight_spec, shell_quality,
    freshness_days, quantity, photos, description, start_price, min_increment,
    duration_hours, unit_label, unit_size, intro_video, defect_rate, defect_note,
  } = req.body;

  if (!title || !start_price || !quantity || !duration_hours) {
    return res.status(400).json({ error: '请填写必填项：标题/起拍价/数量/竞价时长' });
  }
  const dh = Number(duration_hours);
  if (![1, 2, 3].includes(dh)) return res.status(400).json({ error: '竞价时长仅支持 1/2/3 小时' });
  const inc = Number(min_increment) || 1;
  if (inc < 0.5) return res.status(400).json({ error: '加价/降价幅度不能低于 0.5 元' });

  const now = Date.now();
  const endAt = now + dh * 60 * 60 * 1000;
  const startPrice = Number(start_price);
  const initialStatus = kind === 'demand' ? 'auctioning' : 'auctioning';

  // 快照发布者最近一次定位，用于附近推荐
  const me = db.prepare('SELECT lat, lng FROM users WHERE id=?').get(req.user.id);
  const snapLat = (req.body.lat != null ? Number(req.body.lat) : (me && me.lat)) ?? null;
  const snapLng = (req.body.lng != null ? Number(req.body.lng) : (me && me.lng)) ?? null;

  const info = db.prepare(`
    INSERT INTO resources (
      farm_id, title, region, province, chicken_breed, farm_size, egg_color, weight_spec, shell_quality,
      freshness_days, quantity, photos, description, start_price, min_increment, current_price,
      start_at, end_at, status, created_at, kind, unit_label, unit_size, intro_video,
      defect_rate, defect_note, lat, lng, review_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')
  `).run(
    req.user.id, title, region || req.user.region, province || null,
    chicken_breed, farm_size, egg_color, weight_spec, shell_quality,
    freshness_days, quantity, JSON.stringify(photos || []), description, startPrice, inc, startPrice,
    now, endAt, initialStatus, now, kind, unit_label || '元/箱',
    unit_size || '车', intro_video || null,
    defect_rate != null ? Number(defect_rate) : null,
    defect_note || null,
    snapLat, snapLng,
  );

  // 资源创建好后，从钱包冻结一笔保证金锁到该资源（订单完成时扣服务费 / 取消时解冻）
  try {
    lockDepositForResource({
      userId: req.user.id,
      resourceId: info.lastInsertRowid,
      type: kind === 'supply' ? 'farm_quality' : 'demand_quality',
    });
  } catch (e) {
    // 极小概率：余额刚好在 precheck 后被花掉。回滚资源
    db.prepare('DELETE FROM resources WHERE id=?').run(info.lastInsertRowid);
    if (e.code === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({ error: e.message, code: 'INSUFFICIENT_BALANCE' });
    }
    return res.status(500).json({ error: e.message });
  }

  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(info.lastInsertRowid);
  res.json({ resource: enrich(r) });
});

router.patch('/:id', authRequired, (req, res) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  if (r.farm_id !== req.user.id) return res.status(403).json({ error: '只能修改自己的资源' });
  if (r.status !== 'auctioning') return res.status(400).json({ error: '只能在竞价中修改' });
  const bidCount = db.prepare('SELECT COUNT(*) c FROM bids WHERE resource_id=?').get(r.id).c;
  if (bidCount > 0) return res.status(400).json({ error: '已有出价，无法修改' });

  const { description, photos } = req.body;
  db.prepare('UPDATE resources SET description=COALESCE(?,description), photos=COALESCE(?,photos) WHERE id=?')
    .run(description, photos ? JSON.stringify(photos) : null, r.id);
  res.json({ ok: true });
});

router.post('/:id/cancel', authRequired, (req, res) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  if (r.farm_id !== req.user.id) return res.status(403).json({ error: '只能操作自己的资源' });
  const bidCount = db.prepare('SELECT COUNT(*) c FROM bids WHERE resource_id=?').get(r.id).c;
  if (bidCount > 0) return res.status(400).json({ error: '已有出价，无法取消' });
  db.prepare(`UPDATE resources SET status='cancelled' WHERE id=?`).run(r.id);
  // 释放本资源所有保证金 → 入用户余额
  releaseResourceDeposits(r.id);
  res.json({ ok: true });
});

router.post('/:id/end-now', authRequired, (req, res) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  if (r.farm_id !== req.user.id) return res.status(403).json({ error: '只能操作自己发布的资源' });
  if (r.status !== 'auctioning') return res.status(400).json({ error: '竞价未进行中' });
  if (!r.current_bidder_id) return res.status(400).json({ error: '还没有人出价，无法成交' });
  closeAuction(r.id, true);
  const updated = db.prepare('SELECT * FROM resources WHERE id=?').get(r.id);
  res.json({ ok: true, resource: updated });
});

module.exports = router;
