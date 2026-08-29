-- 星慕畅玩 · D1 数据库结构（steam-share）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  is_vip INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT DEFAULT '其他',
  cover TEXT DEFAULT '',
  sort INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS game_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  account TEXT NOT NULL,
  password TEXT NOT NULL
);

-- 用户提交的游戏（待审核）
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT DEFAULT '其他',
  account TEXT NOT NULL,
  password TEXT NOT NULL,
  status TEXT DEFAULT 'pending',   -- pending / approved / rejected
  created_at INTEGER
);

-- 每日领取配额
CREATE TABLE IF NOT EXISTS quotas (
  user_id INTEGER,
  date TEXT,
  used INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, date)
);