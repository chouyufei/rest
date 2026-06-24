const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { releaseDeposits, settleOrderDeposits } = require('../services/auction');
const { notify } = require('../services/notification');
const settings = require('../services/settings');

const router = express.Router();

function enrich(o) {
  if (!o) return o;
  const resource = db.prepare('SELECT * FROM resources WHERE id=?').get(o.resource_id);
  const farm = db.prepare('SELECT id, name, phone, region, lat, lng FROM users WHERE id=?').get(o.farm_id);
  const buyer = db.prepare('SELECT id, name, phone, region, lat, lng FROM users WHERE id=?').get(o.buyer_id);
  return {
    ...o,
    resource: resource ? { ...resource, photos: resource.photos ? JSON.parse(resource.photos) : [] } : null,
    farm, buyer,
  };
}

router.get('/', authRequired, (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
  } else {
    // 一个用户同时可能既是卖方（发布货源 / 求购应标）又是买方（参与报价 /
    // 发布求购）；订单列表统一返回 farm_id 或 buyer_id 任一匹配的全部记录，
    // 前端按 side（买/卖）打标签区分，不再因主页"切换买卖"而漏单。
    rows = db.prepare(`
      SELECT * FROM orders WHERE farm_id=? OR buyer_id=? ORDER BY created_at DESC
    `).all(req.user.id, req.user.id);
  }
  res.json({ orders: rows.map(enrich) });
});

router.get('/:id', authRequired, (req, res) => {
  // 支持用 数字 id 或 16 位 order_no 查询
  const key = String(req.params.id);
  const o = /^\d{16}$/.test(key)
    ? db.prepare('SELECT * FROM orders WHERE order_no=?').get(key)
    : db.prepare('SELECT * FROM orders WHERE id=?').get(key);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (req.user.role !== 'admin' && o.farm_id !== req.user.id && o.buyer_id !== req.user.id) {
    return res.status(403).json({ error: '无权查看' });
  }
  const chats = db.prepare(`
    SELECT cm.*, u.name AS sender_name, u.role AS sender_role
    FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
    WHERE cm.order_id=? ORDER BY cm.created_at ASC
  `).all(o.id);
  res.json({
    order: enrich(o),
    chats,
    service_qr: {
      url: settings.get('service_qr_url') || '',
      owner: settings.get('service_qr_owner') || '',
    },
  });
});

router.post('/:id/create-group', authRequired, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.farm_id !== req.user.id && o.buyer_id !== req.user.id) return res.status(403).json({ error: '无权操作' });
  if (o.group_id) return res.json({ ok: true, group_id: o.group_id });
  const groupId = `G${o.id}-${Date.now().toString(36)}`;
  db.prepare(`UPDATE orders SET group_id=?, status='communicating', group_created_at=? WHERE id=?`)
    .run(groupId, Date.now(), o.id);
  notify(o.farm_id, 'group_created', '群已建立', `订单 #${o.id} 沟通群已创建`, o.id);
  notify(o.buyer_id, 'group_created', '群已建立', `订单 #${o.id} 沟通群已创建`, o.id);
  res.json({ ok: true, group_id: groupId });
});

router.post('/:id/chat', authRequired, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.farm_id !== req.user.id && o.buyer_id !== req.user.id) return res.status(403).json({ error: '无权发言' });
  const { content, kind } = req.body;
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  db.prepare(`
    INSERT INTO chat_messages (order_id, sender_id, content, kind, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(o.id, req.user.id, content, kind || 'text', Date.now());
  res.json({ ok: true });
});

router.post('/:id/confirm', authRequired, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.buyer_id !== req.user.id) return res.status(403).json({ error: '仅采购商可确认收货' });
  if (o.status === 'completed') return res.json({ ok: true });
  if (o.status === 'disputed') return res.status(400).json({ error: '订单存在纠纷，请先处理' });
  db.prepare(`UPDATE orders SET status='completed', confirmed_at=? WHERE id=?`).run(Date.now(), o.id);
  // 必须先 settle（新模型解冻 + 扣服务费），否则 releaseDeposits 会先把所有冻结
  // 释放掉，settle 再扫 frozen 状态就空了，服务费永远扣不到。
  settleOrderDeposits(o.id);       // 新模型：解冻 buyer+seller 冻结金 + 从卖方账户直扣服务费
  releaseDeposits(o.id);           // 老模型遗留兜底（status=available 之类）
  notify(o.farm_id, 'order_completed', '交易完成', `订单 #${o.id} 已确认收货，保证金已扣服务费并解冻余款`, o.id);
  res.json({ ok: true });
});

router.post('/:id/dispute', authRequired, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.farm_id !== req.user.id && o.buyer_id !== req.user.id) return res.status(403).json({ error: '无权操作' });
  const { type, description, evidence } = req.body;
  if (!type) return res.status(400).json({ error: '请选择纠纷类型' });
  db.prepare(`
    INSERT INTO disputes (order_id, raised_by, type, description, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(o.id, req.user.id, type, description || '', JSON.stringify(evidence || []), Date.now());
  db.prepare(`UPDATE orders SET status='disputed' WHERE id=?`).run(o.id);
  notify(o.farm_id === req.user.id ? o.buyer_id : o.farm_id,
    'dispute_raised', '纠纷已发起', `订单 #${o.id} 出现纠纷：${type}`, o.id);
  res.json({ ok: true });
});

module.exports = router;
