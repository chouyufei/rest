const express = require('express');
const db = require('../db');
const { authRequired, roleRequired } = require('../middleware/auth');
const { closeAuction, sweep, FARM_DEPOSIT_AMOUNT } = require('../services/auction');

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

  if (sort === 'price_asc') sql += ' ORDER BY current_price ASC';
  else if (sort === 'price_desc') sql += ' ORDER BY current_price DESC';
  else if (sort === 'ending_soon') sql += " ORDER BY CASE WHEN status='auctioning' THEN end_at ELSE end_at + 999999999999 END ASC";
  else sql += ' ORDER BY created_at DESC';

  const rows = db.prepare(sql).all(...params);
  res.json({ resources: rows.map(enrich) });
});

router.get('/mine', authRequired, (req, res) => {
  sweep();
  const rows = db.prepare('SELECT * FROM resources WHERE farm_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({ resources: rows.map(enrich) });
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

  if (kind === 'supply') {
    if (req.user.role !== 'farm') return res.status(403).json({ error: '货源仅限养殖场发布' });
    if (req.user.license_status !== 'approved') return res.status(403).json({ error: '请先完成资质审核' });
    const farmDep = db.prepare(`SELECT * FROM deposits WHERE user_id=? AND type='farm_quality' AND status IN ('available','frozen')`).get(req.user.id);
    if (!farmDep) return res.status(403).json({ error: `请先缴纳 ${FARM_DEPOSIT_AMOUNT} 元品质保证金` });
  } else {
    if (req.user.role !== 'buyer') return res.status(403).json({ error: '求购仅限采购商发布' });
    // 求购发布免保证金；应标的养殖场按场缴纳竞拍保证金
  }

  const {
    title, region, province, chicken_breed, farm_size, egg_color, weight_spec, shell_quality,
    freshness_days, quantity, photos, description, start_price, min_increment,
    duration_hours, unit_label, unit_size, intro_video,
  } = req.body;

  if (!title || !start_price || !quantity || !duration_hours) {
    return res.status(400).json({ error: '请填写必填项：标题/起拍价/数量/竞拍时长' });
  }
  const dh = Number(duration_hours);
  if (![1, 2, 3].includes(dh)) return res.status(400).json({ error: '竞拍时长仅支持 1/2/3 小时' });
  const inc = Number(min_increment) || 2;
  if (inc < 0.5) return res.status(400).json({ error: '加价/降价幅度不能低于 0.5 元' });

  const now = Date.now();
  const endAt = now + dh * 60 * 60 * 1000;
  const startPrice = Number(start_price);
  const initialStatus = kind === 'demand' ? 'auctioning' : 'auctioning';

  const info = db.prepare(`
    INSERT INTO resources (
      farm_id, title, region, province, chicken_breed, farm_size, egg_color, weight_spec, shell_quality,
      freshness_days, quantity, photos, description, start_price, min_increment, current_price,
      start_at, end_at, status, created_at, kind, unit_label, unit_size, intro_video, review_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')
  `).run(
    req.user.id, title, region || req.user.region, province || null,
    chicken_breed, farm_size, egg_color, weight_spec, shell_quality,
    freshness_days, quantity, JSON.stringify(photos || []), description, startPrice, inc, startPrice,
    now, endAt, initialStatus, now, kind, unit_label || '元/箱',
    unit_size || '车', intro_video || null,
  );

  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(info.lastInsertRowid);
  res.json({ resource: enrich(r) });
});

router.patch('/:id', authRequired, (req, res) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  if (r.farm_id !== req.user.id) return res.status(403).json({ error: '只能修改自己的资源' });
  if (r.status !== 'auctioning') return res.status(400).json({ error: '只能在竞拍中修改' });
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
  res.json({ ok: true });
});

router.post('/:id/end-now', authRequired, (req, res) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  if (r.farm_id !== req.user.id) return res.status(403).json({ error: '只能操作自己发布的资源' });
  if (r.status !== 'auctioning') return res.status(400).json({ error: '竞拍未进行中' });
  if (!r.current_bidder_id) return res.status(400).json({ error: '还没有人出价，无法成交' });
  closeAuction(r.id, true);
  const updated = db.prepare('SELECT * FROM resources WHERE id=?').get(r.id);
  res.json({ ok: true, resource: updated });
});

module.exports = router;
