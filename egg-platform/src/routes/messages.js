const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ messages: rows });
});

router.get('/unread-count', authRequired, (req, res) => {
  const row = db.prepare('SELECT COUNT(*) c FROM messages WHERE user_id=? AND read=0').get(req.user.id);
  res.json({ count: row.c });
});

router.post('/read', authRequired, (req, res) => {
  const { ids } = req.body;
  if (Array.isArray(ids) && ids.length) {
    const stmt = db.prepare('UPDATE messages SET read=1 WHERE id=? AND user_id=?');
    for (const id of ids) stmt.run(id, req.user.id);
  } else {
    db.prepare('UPDATE messages SET read=1 WHERE user_id=?').run(req.user.id);
  }
  res.json({ ok: true });
});

module.exports = router;
