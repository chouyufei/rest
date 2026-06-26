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
  // 关键比较全走"分"整数，避免 1.35 - 0.35 = 0.999999... 导致的误判
  const amtC = Math.round(Number(amount) * 100);
  const balC = Math.round(Number(u.balance || 0) * 100);
  const lockedC = Math.round(Number(u.locked_balance || 0) * 100);
  const bal = balC / 100;
  const locked = lockedC / 100;
  const amt = amtC / 100;
  if (meta.from_locked) {
    if (lockedC < amtC) throw new Error('冻结余额不足');
    if (balC < amtC) throw new Error('账户余额不足');
    const newBal = (balC - amtC) / 100;
    const newLocked = (lockedC - amtC) / 100;
    db.prepare('UPDATE users SET balance=?, locked_balance=? WHERE id=?').run(newBal, newLocked, userId);
    db.prepare(`
      INSERT INTO balance_transactions
        (user_id, amount, type, ref_type, ref_id, balance_after, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, -amt, meta.type, meta.ref_type || null, meta.ref_id || null, newBal, meta.note || null, Date.now());
    return newBal;
  }
  if (balC - lockedC < amtC) throw new Error('可用余额不足');
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

// 直接从总余额扣（不要求资金已在 locked 里）。
// 用于：订单成交时按"后台设置的服务费"全额扣卖方钱包，无论保障金冻结了多少。
// 余额不足时允许扣到负数（平台对该用户的应收账款），由 admin 后台对账后补回。
const txPureDebit = db.transaction((userId, amount, meta) => {
  const u = db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
  if (!u) throw new Error('用户不存在');
  const amt = Number(amount);
  const bal = Number(u.balance || 0);
  const newBal = bal - amt;
  db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBal, userId);
  db.prepare(`
    INSERT INTO balance_transactions
      (user_id, amount, type, ref_type, ref_id, balance_after, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, -amt, meta.type, meta.ref_type || null, meta.ref_id || null, newBal,
    newBal < 0 ? `${meta.note || ''}（余额不足，记账后透支 ${(-newBal).toFixed(2)} 元待对账）` : (meta.note || null),
    Date.now());
  return newBal;
});

function credit(userId, amount, meta) { return txCredit(userId, amount, meta); }
function lock(userId, amount, meta)    { return txDebit(userId, amount, { ...meta, from_locked: false }); }
function consume(userId, amount, meta) { return txDebit(userId, amount, { ...meta, from_locked: true }); }
function unlock(userId, amount, meta)  { return txUnlock(userId, amount, meta); }
function debit(userId, amount, meta)   { return txPureDebit(userId, amount, meta); }

// 钱包数额走 REAL 存储，多次 +/- 累积 IEEE 754 误差，例如 1.35 - 0.35
// 在 JS 里 = 0.9999999999999999。先把 balance / locked 各自圆整到分位
// 整数，再做整数减法，结果再换算回元——可用余额永远是干净的分位值，
// 比较时不会因为 0.99999... 被误判为"不够"。
function getBalance(userId) {
  const u = db.prepare('SELECT balance, locked_balance FROM users WHERE id=?').get(userId);
  if (!u) return { balance: 0, locked_balance: 0, available: 0 };
  const balCents = Math.round(Number(u.balance || 0) * 100);
  const lockedCents = Math.round(Number(u.locked_balance || 0) * 100);
  const availableCents = balCents - lockedCents;
  return {
    balance: balCents / 100,
    locked_balance: lockedCents / 100,
    available: availableCents / 100,
  };
}

function getTransactions(userId, { limit = 50, offset = 0 } = {}) {
  return db.prepare(`
    SELECT * FROM balance_transactions WHERE user_id=?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}

module.exports = { credit, lock, consume, unlock, debit, getBalance, getTransactions };
