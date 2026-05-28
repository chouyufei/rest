const otps = new Map();
const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function set(phone, code) {
  otps.set(phone, { code, expiresAt: Date.now() + TTL_MS, attempts: 0 });
}

function verify(phone, code) {
  const e = otps.get(phone);
  if (!e) return { ok: false, reason: '请先获取验证码' };
  if (Date.now() > e.expiresAt) { otps.delete(phone); return { ok: false, reason: '验证码已过期' }; }
  e.attempts += 1;
  if (e.attempts > MAX_ATTEMPTS) { otps.delete(phone); return { ok: false, reason: '尝试次数过多，请重新获取' }; }
  if (String(e.code) !== String(code)) return { ok: false, reason: '验证码错误' };
  otps.delete(phone);
  return { ok: true };
}

function cooldownLeft(phone) {
  const e = otps.get(phone);
  if (!e) return 0;
  const elapsed = TTL_MS - (e.expiresAt - Date.now());
  const COOLDOWN = 60 * 1000;
  return Math.max(0, COOLDOWN - elapsed);
}

module.exports = { set, verify, cooldownLeft };
