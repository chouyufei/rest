const db = require('../db');

// 入账：amount 必须 > 0
const txCredit = db.transaction((userId, amount, meta) => {
  const u = db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
  if (!u) throw new Error('用户不存在');
  const newBal = Number(u.balance || 0) + Number(amount);
  db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBal, userId);
  db.prepare(`
    INSERT INTO balance_transactions
      (user_id, amount, type, ref_type, ref_id, balance_after, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, Number(amount), meta.type, meta.ref_type || null, meta.ref_id || null, newBal, meta.note || null, Date.now());
  return newBal;
});

// 出账（已含锁定可用 / 检查可用余额）：amount 必须 > 0
//   from_locked=true 表示从 locked_balance 扣减（提现真正到账时使用，
//     此刻 balance 与 locked_balance 同步减少，账户总额下降）
//   from_locked=false 表示申请提现时的"锁定"：balance 不变，locked_balance + amt
const txDebit = db.transaction((userId, amount, meta) => {
  const u = db.prepare('SELECT balance, locked_balance FROM users WHERE id=?').get(userId);
  if (!u) throw new Error('用户不存在');
  const amt = Number(amount);
  const bal = Number(u.balance || 0);
  const locked = Number(u.locked_balance || 0);
  if (meta.from_locked) {
    if (locked < amt) throw new Error('冻结余额不足');
    if (bal < amt) throw new Error('账户余额不足');
    const newBal = bal - amt;
    const newLocked = locked - amt;
    db.prepare('UPDATE users SET balance=?, locked_balance=? WHERE id=?').run(newBal, newLocked, userId);
    db.prepare(`
      INSERT INTO balance_transactions
        (user_id, amount, type, ref_type, ref_id, balance_after, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, -amt, meta.type, meta.ref_type || null, meta.ref_id || null, newBal, meta.note || null, Date.now());
    return newBal;
  }
  if (bal - locked < amt) throw new Error('可用余额不足');
  // 锁定：balance 不变化，locked_balance + amt
  db.prepare('UPDATE users SET locked_balance=? WHERE id=?').run(locked + amt, userId);
  db.prepare(`
    INSERT INTO balance_transactions
      (user_id, amount, type, ref_type, ref_id, balance_after, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, -amt, meta.type, meta.ref_type || null, meta.ref_id || null, bal, meta.note || null, Date.now());
  return bal;
});

// 解锁（提现被拒 / 用户取消时使用）：把锁定金额释放回可用
const txUnlock = db.transaction((userId, amount, meta) => {
  const u = db.prepare('SELECT balance, locked_balance FROM users WHERE id=?').get(userId);
  if (!u) throw new Error('用户不存在');
  const amt = Number(amount);
  const locked = Number(u.locked_balance || 0);
  if (locked < amt) throw new Error('冻结余额不足以解锁');
  db.prepare('UPDATE users SET locked_balance=? WHERE id=?').run(locked - amt, userId);
  db.prepare(`
    INSERT INTO balance_transactions
      (user_id, amount, type, ref_type, ref_id, balance_after, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, amt, meta.type, meta.ref_type || null, meta.ref_id || null, Number(u.balance || 0), meta.note || null, Date.now());
  return Number(u.balance || 0);
});

function credit(userId, amount, meta) { return txCredit(userId, amount, meta); }
function lock(userId, amount, meta)    { return txDebit(userId, amount, { ...meta, from_locked: false }); }
function consume(userId, amount, meta) { return txDebit(userId, amount, { ...meta, from_locked: true }); }
function unlock(userId, amount, meta)  { return txUnlock(userId, amount, meta); }

function getBalance(userId) {
  const u = db.prepare('SELECT balance, locked_balance FROM users WHERE id=?').get(userId);
  if (!u) return { balance: 0, locked_balance: 0, available: 0 };
  const bal = Number(u.balance || 0);
  const locked = Number(u.locked_balance || 0);
  return { balance: bal, locked_balance: locked, available: bal - locked };
}

function getTransactions(userId, { limit = 50, offset = 0 } = {}) {
  return db.prepare(`
    SELECT * FROM balance_transactions WHERE user_id=?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}

module.exports = { credit, lock, consume, unlock, getBalance, getTransactions };
