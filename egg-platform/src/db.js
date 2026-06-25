const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  password TEXT,
  name TEXT,
  role TEXT NOT NULL CHECK(role IN ('farm','buyer','admin')),
  avatar TEXT,
  region TEXT,
  address TEXT,
  business_license TEXT,
  license_status TEXT DEFAULT 'pending' CHECK(license_status IN ('pending','approved','rejected','none')),
  banned INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('farm_quality','buyer_bid')),
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','frozen','released','deducted')),
  frozen_for INTEGER,
  note TEXT,
  paid_at INTEGER NOT NULL,
  released_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  region TEXT,
  chicken_breed TEXT,
  farm_size INTEGER,
  egg_color TEXT,
  weight_spec TEXT,
  shell_quality TEXT,
  freshness_days INTEGER,
  quantity INTEGER NOT NULL,
  photos TEXT,
  description TEXT,
  start_price REAL NOT NULL,
  min_increment REAL NOT NULL DEFAULT 2,
  current_price REAL NOT NULL,
  current_bidder_id INTEGER,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  extend_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','auctioning','sold','failed','cancelled')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (farm_id) REFERENCES users(id),
  FOREIGN KEY (current_bidder_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status);
CREATE INDEX IF NOT EXISTS idx_resources_end_at ON resources(end_at);

CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL,
  bidder_id INTEGER NOT NULL,
  price REAL NOT NULL,
  is_auto INTEGER NOT NULL DEFAULT 0,
  max_price REAL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id),
  FOREIGN KEY (bidder_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_bids_resource ON bids(resource_id);

CREATE TABLE IF NOT EXISTS auto_bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL,
  bidder_id INTEGER NOT NULL,
  max_price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(resource_id, bidder_id),
  FOREIGN KEY (resource_id) REFERENCES resources(id),
  FOREIGN KEY (bidder_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL UNIQUE,
  farm_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  final_price REAL NOT NULL,
  quantity INTEGER NOT NULL,
  group_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_group' CHECK(status IN ('pending_group','communicating','completed','cancelled','disputed')),
  group_created_at INTEGER,
  confirmed_at INTEGER,
  auto_complete_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id),
  FOREIGN KEY (farm_id) REFERENCES users(id),
  FOREIGN KEY (buyer_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  related_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, read);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  raised_by INTEGER NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','rejected')),
  resolution TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pay_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  out_trade_no TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  deposit_type TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled','refunded')),
  transaction_id TEXT,
  prepay_id TEXT,
  paid_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_pay_orders_user ON pay_orders(user_id, status);
`);

function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find((c) => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
  }
}

addColumnIfMissing('resources', 'kind', "kind TEXT NOT NULL DEFAULT 'supply'");
addColumnIfMissing('resources', 'province', 'province TEXT');
addColumnIfMissing('resources', 'unit_label', "unit_label TEXT DEFAULT '元/箱'");
addColumnIfMissing('resources', 'review_status', "review_status TEXT DEFAULT 'approved'");

addColumnIfMissing('users', 'contact_name', 'contact_name TEXT');
addColumnIfMissing('users', 'daily_output', 'daily_output INTEGER');
addColumnIfMissing('users', 'main_products', 'main_products TEXT');
addColumnIfMissing('users', 'farm_size_int', 'farm_size_int INTEGER');
addColumnIfMissing('users', 'license_photos', 'license_photos TEXT');
addColumnIfMissing('users', 'farm_photos', 'farm_photos TEXT');
addColumnIfMissing('users', 'quarantine_photos', 'quarantine_photos TEXT');
addColumnIfMissing('users', 'wechat_openid', 'wechat_openid TEXT');
addColumnIfMissing('users', 'username', 'username TEXT');
addColumnIfMissing('users', 'balance', 'balance REAL NOT NULL DEFAULT 0');         // 钱包余额（保证金释放 / 退款 沉淀于此）
addColumnIfMissing('users', 'locked_balance', 'locked_balance REAL NOT NULL DEFAULT 0');  // 提现申请中冻结部分
addColumnIfMissing('users', 'lat', 'lat REAL');                                   // 用户最近一次定位
addColumnIfMissing('users', 'lng', 'lng REAL');
addColumnIfMissing('users', 'location_updated_at', 'location_updated_at INTEGER');

addColumnIfMissing('resources', 'last_bid_at', 'last_bid_at INTEGER');
addColumnIfMissing('resources', 'unit_size', "unit_size TEXT DEFAULT '车'");
addColumnIfMissing('resources', 'intro_video', 'intro_video TEXT');
addColumnIfMissing('resources', 'defect_rate', 'defect_rate REAL');
addColumnIfMissing('resources', 'defect_note', 'defect_note TEXT');
addColumnIfMissing('resources', 'pack_size', 'pack_size INTEGER');                // 单箱枚数 (常见 360 / 480)
addColumnIfMissing('resources', 'yolk_color', 'yolk_color TEXT');                // 蛋黄颜色: 红心 / 黄心 / 双色
addColumnIfMissing('resources', 'yolk_shade', 'yolk_shade TEXT');                // 蛋黄色号 (罗氏比色卡 度数, 如 "12-13")
addColumnIfMissing('resources', 'truck_type', 'truck_type TEXT');                // 车型 (米数, 如 "4.2" / "6.8" / "9.6" / "13.5")
addColumnIfMissing('resources', 'weight_specs', 'weight_specs TEXT');            // JSON: 每个整数斤值的 { weight, boxes, price }
addColumnIfMissing('resources', 'deleted_at', 'deleted_at INTEGER');             // 软删除时间戳（仅 failed / cancelled 资源可由发布方主动删除）
addColumnIfMissing('resources', 'lat', 'lat REAL');                              // 发布时快照养殖场 / 采购商定位
addColumnIfMissing('resources', 'lng', 'lng REAL');
addColumnIfMissing('messages', 'image_url', 'image_url TEXT');                   // 消息可附带图片（如企业微信二维码）

db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS balance_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,                -- 正数=入账，负数=出账
  type TEXT NOT NULL,                  -- deposit_release | withdraw_lock | withdraw_paid | withdraw_refund | adjust
  ref_type TEXT,                       -- deposit | withdrawal | manual
  ref_id INTEGER,
  balance_after REAL NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_balance_tx_user ON balance_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','transferring','rejected','paid','failed','cancelled')),
  method TEXT NOT NULL DEFAULT 'wechat',  -- wechat | bank
  account_name TEXT,
  account_no TEXT,
  bank_name TEXT,
  applied_at INTEGER NOT NULL,
  processed_at INTEGER,
  processed_by INTEGER,
  out_trade_no TEXT,
  failure_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, applied_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,   -- resource / user / chat_message / order
  target_id INTEGER NOT NULL,
  category TEXT NOT NULL,      -- 虚假信息 / 违禁品 / 涉嫌欺诈 / 不当言论 / 其它
  description TEXT,
  evidence TEXT,               -- JSON array of image URLs
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','rejected')),
  resolution TEXT,
  handled_at INTEGER,
  handled_by INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (reporter_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
`);
addColumnIfMissing('deposits', 'resource_id', 'resource_id INTEGER');
addColumnIfMissing('deposits', 'from_balance', 'from_balance INTEGER NOT NULL DEFAULT 0');  // 1=新模型（钱包冻结）；0=旧模型（微信支付）
addColumnIfMissing('pay_orders', 'purpose', "purpose TEXT NOT NULL DEFAULT 'deposit'");      // deposit / recharge

// 一次性迁移：让 deposits.type 允许 'demand_quality'（SQLite 不支持 ALTER CHECK，只能重建表）
(function ensureDepositTypeCheck() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deposits'").get();
  if (!row || !row.sql || row.sql.includes('demand_quality')) return;
  db.exec(`
    BEGIN;
    CREATE TABLE deposits_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('farm_quality','buyer_bid','demand_quality')),
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','frozen','released','deducted')),
      frozen_for INTEGER,
      note TEXT,
      paid_at INTEGER NOT NULL,
      released_at INTEGER,
      resource_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    INSERT INTO deposits_new (id, user_id, type, amount, status, frozen_for, note, paid_at, released_at, resource_id)
      SELECT id, user_id, type, amount, status, frozen_for, note, paid_at, released_at, resource_id FROM deposits;
    DROP TABLE deposits;
    ALTER TABLE deposits_new RENAME TO deposits;
    COMMIT;
  `);
})();
addColumnIfMissing('pay_orders', 'resource_id', 'resource_id INTEGER');
addColumnIfMissing('orders', 'order_no', 'order_no TEXT');                  // 16 位订单编号，用户可凭此向客服反馈
addColumnIfMissing('withdrawals', 'package_info', 'package_info TEXT');     // 单笔转账 API 返回的 package_info，小程序拉起 wx.requestMerchantTransfer 用
addColumnIfMissing('withdrawals', 'transfer_bill_no', 'transfer_bill_no TEXT'); // 微信转账单号

// 一次性迁移：让 withdrawals.status 允许 'transferring'（转账已发起、等用户在小程序确认收款）
(function ensureWithdrawStatusCheck() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='withdrawals'").get();
  if (!row || !row.sql || row.sql.includes('transferring')) return;
  db.exec(`
    BEGIN;
    CREATE TABLE withdrawals_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','transferring','rejected','paid','failed','cancelled')),
      method TEXT NOT NULL DEFAULT 'wechat',
      account_name TEXT,
      account_no TEXT,
      bank_name TEXT,
      applied_at INTEGER NOT NULL,
      processed_at INTEGER,
      processed_by INTEGER,
      out_trade_no TEXT,
      failure_reason TEXT,
      package_info TEXT,
      transfer_bill_no TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    INSERT INTO withdrawals_new
      (id, user_id, amount, status, method, account_name, account_no, bank_name,
       applied_at, processed_at, processed_by, out_trade_no, failure_reason,
       package_info, transfer_bill_no)
    SELECT id, user_id, amount, status, method, account_name, account_no, bank_name,
       applied_at, processed_at, processed_by, out_trade_no, failure_reason,
       package_info, transfer_bill_no
    FROM withdrawals;
    DROP TABLE withdrawals;
    ALTER TABLE withdrawals_new RENAME TO withdrawals;
    CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, applied_at DESC);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, applied_at DESC);
    COMMIT;
  `);
})();

// 一次性修正：旧版 releaseAndCredit() 对 from_balance=1 的保证金也走 credit()，
// 导致解冻一次相当于"加钱"，账户余额被虚增。把所有"新模型保证金 + deposit_release"
// 流水的金额从 users.balance 里减回来。
(function fixHistoricalDepositReleaseOvercredit() {
  const flag = db.prepare("SELECT value FROM app_settings WHERE key='_fix_deposit_release_overcredit_v1'").get();
  if (flag) return;
  const rows = db.prepare(`
    SELECT bt.user_id, SUM(bt.amount) AS total
    FROM balance_transactions bt
    JOIN deposits d ON bt.ref_id = d.id
    WHERE bt.type='deposit_release' AND bt.ref_type='deposit'
      AND COALESCE(d.from_balance, 0) = 1
      AND bt.amount > 0
    GROUP BY bt.user_id
    HAVING total > 0
  `).all();
  for (const t of rows) {
    const u = db.prepare('SELECT balance FROM users WHERE id=?').get(t.user_id);
    if (!u) continue;
    const newBal = Math.max(0, Number(u.balance) - Number(t.total));
    db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBal, t.user_id);
    console.log(`[migrate] user ${t.user_id} balance ${u.balance} - 误增 ${t.total} → ${newBal}`);
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run('_fix_deposit_release_overcredit_v1', JSON.stringify(true), Date.now());
})();

// 一次性修正：旧版 balance.consume() 只扣了 locked_balance，没扣 balance；
// 把每个用户的历史「withdraw_paid」金额从 balance 里补减回去，使数据归正。
(function fixHistoricalWithdrawPaidBalance() {
  const flag = db.prepare("SELECT value FROM app_settings WHERE key='_fix_withdraw_paid_balance_v1'").get();
  if (flag) return;
  const txns = db.prepare(`
    SELECT user_id, SUM(-amount) AS total_paid
    FROM balance_transactions
    WHERE type='withdraw_paid' AND amount < 0
    GROUP BY user_id
    HAVING total_paid > 0
  `).all();
  for (const t of txns) {
    const u = db.prepare('SELECT balance FROM users WHERE id=?').get(t.user_id);
    if (!u) continue;
    const newBal = Math.max(0, Number(u.balance) - Number(t.total_paid));
    db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBal, t.user_id);
    console.log(`[migrate] user ${t.user_id} balance ${u.balance} - paid ${t.total_paid} → ${newBal}`);
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run('_fix_withdraw_paid_balance_v1', JSON.stringify(true), Date.now());
})();

// 给历史订单补 order_no（一次性，幂等：已有就跳过）
(function backfillOrderNo() {
  const rows = db.prepare(`SELECT id, created_at FROM orders WHERE order_no IS NULL OR order_no = ''`).all();
  for (const r of rows) {
    const ts = String(r.created_at || Date.now()).slice(-13);
    const rnd = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const no = (ts + rnd).slice(0, 16).padEnd(16, '0');
    db.prepare(`UPDATE orders SET order_no = ? WHERE id = ?`).run(no, r.id);
  }
})();

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no) WHERE order_no IS NOT NULL;`);

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;`);

// 一次性把历史保存过的提现单笔/日累计上限钳到 5000 以内
// （之前默认 50000，会被 app_settings 行覆盖；现在新规则是 5000 封顶）
(function clampWithdrawCaps() {
  const CAP = 5000;
  for (const key of ['withdraw_max_per_request', 'withdraw_max_daily_amount']) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    if (!row) continue;
    let v;
    try { v = JSON.parse(row.value); } catch (e) { continue; }
    if (typeof v === 'number' && v > CAP) {
      db.prepare(`UPDATE app_settings SET value=?, updated_at=? WHERE key=?`)
        .run(JSON.stringify(CAP), Date.now(), key);
      console.log(`[migrate] ${key} ${v} → ${CAP}`);
    }
  }
})();

// 一次性把历史保存过的保证金额度钳到 500 以内（新规则：冻结 = 服务费 = 500）
(function clampDepositAmount() {
  const CAP = 500;
  const row = db.prepare("SELECT value FROM app_settings WHERE key='deposit_amount'").get();
  if (!row) return;
  let v;
  try { v = JSON.parse(row.value); } catch (e) { return; }
  if (typeof v === 'number' && v > CAP) {
    db.prepare(`UPDATE app_settings SET value=?, updated_at=? WHERE key='deposit_amount'`)
      .run(JSON.stringify(CAP), Date.now());
    console.log(`[migrate] deposit_amount ${v} → ${CAP}`);
  }
})();

// 一次性把历史保存的过长提现审核 / 到账时长压到新策略：实时审核、≤2 小时到账
(function clampWithdrawTimes() {
  const targets = { withdraw_processing_hours: 1, withdraw_arrival_hours: 2 };
  for (const key of Object.keys(targets)) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    if (!row) continue;
    let v;
    try { v = JSON.parse(row.value); } catch (e) { continue; }
    if (typeof v === 'number' && v > targets[key]) {
      db.prepare(`UPDATE app_settings SET value=?, updated_at=? WHERE key=?`)
        .run(JSON.stringify(targets[key]), Date.now(), key);
      console.log(`[migrate] ${key} ${v} → ${targets[key]}`);
    }
  }
})();

// 一次性把异常低（< 1 元，多为早期测试残留 0 / 0.01）的保证金 / 服务费
// 拉到默认 500，避免订单完成时"扣 0 元服务费"的尴尬
(function bumpZeroFeeOrDeposit() {
  const DEFAULT = 500;
  for (const key of ['service_fee_amount', 'deposit_amount']) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    if (!row) continue;
    let v;
    try { v = JSON.parse(row.value); } catch (e) { continue; }
    if (typeof v === 'number' && v < 1) {
      db.prepare(`UPDATE app_settings SET value=?, updated_at=? WHERE key=?`)
        .run(JSON.stringify(DEFAULT), Date.now(), key);
      console.log(`[migrate] ${key} ${v} → ${DEFAULT}`);
    }
  }
})();

(function ensureDefaultAdmin() {
  const bcrypt = require('bcryptjs');
  const existing = db.prepare("SELECT id, username, password FROM users WHERE username='admin'").get();
  const hashed = bcrypt.hashSync('123456', 10);
  if (existing) {
    if (!existing.password) {
      db.prepare("UPDATE users SET password=? WHERE id=?").run(hashed, existing.id);
    }
    return;
  }
  const seeded = db.prepare("SELECT id FROM users WHERE role='admin' AND phone='13800000000'").get();
  if (seeded) {
    db.prepare("UPDATE users SET username='admin', password=? WHERE id=?").run(hashed, seeded.id);
    console.log('已为默认管理员设置 username=admin, password=123456');
  }
})();

module.exports = db;
