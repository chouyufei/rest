const db = require('./db');

function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) {
    console.log('已有数据，跳过 seed');
    return;
  }
  const now = Date.now();

  const admin = db.prepare(`INSERT INTO users (phone, role, name, license_status, created_at) VALUES (?, 'admin', ?, 'none', ?)`)
    .run('13800000000', '平台管理员', now);
  const farm1 = db.prepare(`INSERT INTO users (phone, role, name, region, license_status, created_at) VALUES (?, 'farm', ?, ?, 'approved', ?)`)
    .run('13800000001', '阳光散养鸡场', '山东青州', now);
  const farm2 = db.prepare(`INSERT INTO users (phone, role, name, region, license_status, created_at) VALUES (?, 'farm', ?, ?, 'approved', ?)`)
    .run('13800000002', '绿野谷物饲鸡场', '河南信阳', now);
  const farm3 = db.prepare(`INSERT INTO users (phone, role, name, region, license_status, created_at) VALUES (?, 'farm', ?, ?, 'pending', ?)`)
    .run('13800000003', '田园柴鸡合作社', '湖北襄阳', now);
  const buyer1 = db.prepare(`INSERT INTO users (phone, role, name, region, license_status, created_at) VALUES (?, 'buyer', ?, ?, 'none', ?)`)
    .run('13900000001', '北京盒马采购', '北京', now);
  const buyer2 = db.prepare(`INSERT INTO users (phone, role, name, region, license_status, created_at) VALUES (?, 'buyer', ?, ?, 'none', ?)`)
    .run('13900000002', '济南早餐连锁', '山东济南', now);
  const buyer3 = db.prepare(`INSERT INTO users (phone, role, name, region, license_status, created_at) VALUES (?, 'buyer', ?, ?, 'none', ?)`)
    .run('13900000003', '上海蛋品贸易', '上海', now);

  const dep = db.prepare(`INSERT INTO deposits (user_id, type, amount, status, paid_at) VALUES (?, ?, ?, 'available', ?)`);
  dep.run(farm1.lastInsertRowid, 'farm_quality', 1000, now);
  dep.run(farm2.lastInsertRowid, 'farm_quality', 1000, now);
  dep.run(buyer1.lastInsertRowid, 'buyer_bid', 200, now);
  dep.run(buyer2.lastInsertRowid, 'buyer_bid', 200, now);
  dep.run(buyer3.lastInsertRowid, 'buyer_bid', 200, now);

  const r = db.prepare(`
    INSERT INTO resources (
      farm_id, title, region, chicken_breed, farm_size, egg_color, weight_spec, shell_quality,
      freshness_days, quantity, photos, description, start_price, min_increment, current_price,
      start_at, end_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  r.run(farm1.lastInsertRowid, '青州散养土鸡蛋·1万枚整批', '山东青州', '海兰褐', 8000, '红壳', '55-65g/枚', '硬壳-无裂纹',
    3, 10000,
    JSON.stringify(['https://images.unsplash.com/photo-1582722872445-44dc5f7e3c8f?w=800','https://images.unsplash.com/photo-1569288063643-5d29ad6b7d56?w=800']),
    '青州山区散养 180 天蛋鸡，玉米+豆粕+青菜饲养，蛋黄橙黄，蛋清浓厚，已检疫合格。整批 1 万枚一次出。',
    8500, 2, 8500, now, now + 2 * 60 * 60 * 1000, 'auctioning', now);

  r.run(farm2.lastInsertRowid, '信阳谷物饲养鸡蛋·5000枚整批', '河南信阳', '罗曼粉', 5000, '粉壳', '50-60g/枚', '硬壳',
    5, 5000,
    JSON.stringify(['https://images.unsplash.com/photo-1607690424560-35d967d6ad7f?w=800']),
    '日产 5000 枚，统一规格，统一时间收集打包，48 小时内发货。',
    3900, 2, 3900, now, now + 3 * 60 * 60 * 1000, 'auctioning', now);

  r.run(farm1.lastInsertRowid, '青州笨鸡蛋·1500枚精选', '山东青州', '本地笨鸡', 800, '杂色', '40-50g/枚', '硬壳-小巧',
    2, 1500,
    JSON.stringify(['https://images.unsplash.com/photo-1518569656558-1f25e69d93d7?w=800']),
    '林下散养笨鸡蛋，蛋小但浓郁，适合高端餐饮。',
    2250, 2, 2250, now - 10 * 60 * 1000, now + 50 * 60 * 1000, 'auctioning', now - 10 * 60 * 1000);

  console.log('Seed 完成。账号：');
  console.log('  管理员: 13800000000 / 验证码 123456');
  console.log('  养殖场: 13800000001、13800000002（资质已通过+保证金已缴）');
  console.log('  养殖场: 13800000003（资质待审核）');
  console.log('  采购商: 13900000001、13900000002、13900000003（保证金已缴）');
}

seed();

module.exports = { seed };
