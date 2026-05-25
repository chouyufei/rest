const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sign, authRequired } = require('../middleware/auth');

const router = express.Router();

router.post('/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
  return res.json({ ok: true, otp: '123456', message: '验证码已发送（演示用：123456）' });
});

router.post('/login', (req, res) => {
  const { phone, otp, role, name } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: '缺少手机号或验证码' });
  if (otp !== '123456') return res.status(400).json({ error: '验证码错误（演示请输入 123456）' });

  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    const safeRole = ['farm', 'buyer', 'admin'].includes(role) ? role : 'buyer';
    const info = db.prepare(`
      INSERT INTO users (phone, role, name, license_status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(phone, safeRole, name || `用户${phone.slice(-4)}`, safeRole === 'farm' ? 'pending' : 'none', Date.now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  if (user.banned) return res.status(403).json({ error: '账户已被冻结' });

  const token = sign(user);
  res.json({ token, user });
});

router.get('/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

router.patch('/me', authRequired, (req, res) => {
  const { name, avatar, region, address } = req.body;
  db.prepare(`
    UPDATE users SET
      name = COALESCE(?, name),
      avatar = COALESCE(?, avatar),
      region = COALESCE(?, region),
      address = COALESCE(?, address)
    WHERE id = ?
  `).run(name, avatar, region, address, req.user.id);
  res.json({ user: db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id) });
});

router.post('/qualify', authRequired, (req, res) => {
  if (req.user.role !== 'farm') return res.status(403).json({ error: '只有养殖场需要资质认证' });
  const { business_license, name, region } = req.body;
  db.prepare(`UPDATE users SET business_license=?, name=COALESCE(?,name), region=COALESCE(?,region), license_status='pending' WHERE id=?`)
    .run(business_license, name, region, req.user.id);
  res.json({ ok: true, message: '资质已提交，等待审核' });
});

module.exports = router;
