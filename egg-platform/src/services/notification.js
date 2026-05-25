const db = require('../db');

function notify(userId, type, title, content, relatedId = null) {
  db.prepare(`
    INSERT INTO messages (user_id, type, title, content, related_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, type, title, content, relatedId, Date.now());
}

module.exports = { notify };
