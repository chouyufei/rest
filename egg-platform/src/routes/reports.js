const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { notify } = require('../services/notification');

const router = express.Router();

const TARGET_TYPES = ['resource', 'user', 'chat_message', 'order'];
const CATEGORIES = ['虚假信息', '违禁品', '涉嫌欺诈', '不当言论', '冒充身份', '其它'];

// 提交举报（UGC 合规必备：每个内容都要有举报路径）
router.post('/', authRequired, (req, res) => {
  const { target_type, target_id, category, description, evidence } = req.body || {};
  if (!TARGET_TYPES.includes(target_type)) return res.status(400).json({ error: '举报对象类型错误' });
  if (!target_id) return res.status(400).json({ error: '缺少 target_id' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: '请选择举报类型' });

  const info = db.prepare(`
    INSERT INTO reports (reporter_id, target_type, target_id, category, description, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, target_type, Number(target_id), category, description || '', JSON.stringify(evidence || []), Date.now());

  notify(req.user.id, 'report_received', '举报已受理',
    `您的举报已提交，平台将在 24 小时内核实处理（编号 R${info.lastInsertRowid}）`, info.lastInsertRowid);
  res.json({ ok: true, report_id: info.lastInsertRowid });
});

// 用户查看自己提交的举报
router.get('/mine', authRequired, (req, res) => {
  const rows = db.prepare(`SELECT * FROM reports WHERE reporter_id=? ORDER BY created_at DESC LIMIT 100`).all(req.user.id);
  res.json({ reports: rows });
});

router.get('/categories', (req, res) => {
  res.json({ categories: CATEGORIES });
});

module.exports = router;
