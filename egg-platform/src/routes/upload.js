const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg').toLowerCase() || '.jpg';
    cb(null, nanoid() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 60 * 1024 * 1024 },  // 60MB，支持短视频介绍
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpe?g|png|gif|webp|heic|bmp|mp4|mov|m4v|webm)$/i.test(file.originalname || '') ||
               /^image\/|^video\//.test(file.mimetype || '');
    cb(ok ? null : new Error('仅支持图片或视频'), ok);
  },
});

router.post('/', authRequired, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = req.get('host');
  const url = `${proto}://${host}/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename, size: req.file.size });
});

module.exports = router;
