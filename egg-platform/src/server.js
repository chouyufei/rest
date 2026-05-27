const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { sweep } = require('./services/auction');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/resources', require('./routes/resources'));
app.use('/api/bids', require('./routes/bids'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/deposits', require('./routes/deposits'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/pay', require('./routes/pay'));

app.get('/api/health', (req, res) => {
  sweep();
  res.json({ ok: true, name: '蛋速达 API', time: Date.now() });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '服务器错误' });
});

const PORT = process.env.PORT || 3000;

if (process.env.SEED === '1' || !db.prepare('SELECT COUNT(*) c FROM users').get().c) {
  require('./seed');
}

setInterval(() => {
  try { sweep(); } catch (e) { console.error('sweep error', e); }
}, 5000);

app.listen(PORT, () => {
  console.log(`蛋速达 API running on http://localhost:${PORT}`);
});
