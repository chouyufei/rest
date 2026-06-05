const db = require('../db');

const DEFAULTS = {
  notify_seller_sms: true,                // 卖方短信通知 开/关
  notify_buyer_sms: true,                 // 买方短信通知 开/关
  notify_platform_sms: false,             // 平台方短信通知 开/关
  platform_phones: [],                    // 平台方接收短信手机号（多个）
  wecom_webhook_url: '',                  // 企业微信群机器人 webhook（运行时可改）
};

function get(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row) return DEFAULTS[key];
  try { return JSON.parse(row.value); } catch (e) { return DEFAULTS[key]; }
}

function set(key, value) {
  if (!(key in DEFAULTS)) throw new Error('未知设置项: ' + key);
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, JSON.stringify(value), Date.now());
}

function getAll() {
  const out = { ...DEFAULTS };
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch (e) {}
  }
  return out;
}

module.exports = { get, set, getAll, DEFAULTS };
