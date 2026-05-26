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

module.exports = db;
