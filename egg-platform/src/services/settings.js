const db = require('../db');

const DEFAULTS = {
  notify_seller_sms: true,                // 卖方短信通知 开/关
  notify_buyer_sms: true,                 // 买方短信通知 开/关
  notify_platform_sms: false,             // 平台方短信通知 开/关
  platform_phones: [],                    // 平台方接收短信手机号（多个）
  wecom_webhook_url: '',                  // 企业微信群机器人 webhook（运行时可改）

  // 保证金金额规则：每"档"金额，档位为 deposit_step_qty 辆车
  // amount = ceil(qty / deposit_step_qty) * deposit_xxx_per_step
  deposit_step_qty: 2,                    // 几辆车一档（旧档位制，保留兼容）
  deposit_supply_per_step: 2000,          // 旧档位制保证金（保留兼容）
  deposit_demand_per_step: 1000,
  deposit_bid_per_step: 1000,

  // 新统一保证金机制：发布货源 / 发起求购 / 参与竞价，统一冻结同一额度。来自钱包余额。
  deposit_amount: 1000,                   // 统一保证金额度（元）
  service_fee_amount: 50,                 // 订单完成时平台从每一方扣除的服务费（元）

  // 企业微信服务二维码：成交后下发给买卖双方扫码加好友
  service_qr_url: '',                     // 图片 URL（管理员上传后保存）
  service_qr_owner: '凤伯乐 · 客服',       // 二维码归属人/部门名

  // 「审核模式」总开关：提交微信审核时打开，藏起所有金融 / 复杂功能，
  // 审核员只看简化版（浏览货源 + 文字咨询）。审核通过后再关。
  review_mode: false,
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
