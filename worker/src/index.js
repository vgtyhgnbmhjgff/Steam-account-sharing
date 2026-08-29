// ============================================================
// Steam 账号共享 · Cloudflare Worker 后端
// 技术栈：Cloudflare Workers + D1（主数据）+ KV（验证码/会话）+ Resend（邮件）
//
// 账号体系：无密码。邮箱验证码注册 / 邮箱验证码登录
//          （登录时若邮箱未注册，自动创建账号）
// 领取规则：每日免费 N 次（配额），共享账号池，每次随机看 1 个号，账号不消耗
// 提交规则：用户提交游戏 → 管理员审核通过 → 上架 + 提交者获得 VIP
// ============================================================

// ========= 可配置项（部署后直接在 wrangler.toml 的 [vars] 里改）=========
// DAILY_QUOTA     每日免费领取次数（默认 1）
// ADMIN_EMAIL     管理员邮箱（首次部署自动创建 is_admin 账号）
// SESSION_TTL_DAYS 登录会话有效天数（默认 30）
// ========================================================================

export default {
  async fetch(request, env, ctx) {
    return handle(request, env);
  }
};

// ===== 基础工具 =====
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

function now() { return Date.now(); }

// 北京时间日期 YYYY-MM-DD（用于每日配额重置）
function bjDate() {
  return new Date(now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function randomHex(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}


// 6 位数字验证码
function genCode(length) {
  let s = '';
  for (let i = 0; i < length; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// 从邮箱生成唯一用户名
function genUsername(email) {
  const base = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '').slice(0, 20) || 'user';
  return base + '_' + randomHex(3);
}

function getConfig(env) {
  return {
    dailyQuota: parseInt(env.DAILY_QUOTA || '1', 10) || 1,
    codeLen: 6,
    codeTtl: 300,           // 邮箱验证码 5 分钟
    rateLimit: 60,          // 同一邮箱 60 秒内只能发一次
    sessionTtl: (parseInt(env.SESSION_TTL_DAYS || '30', 10) || 30) * 24 * 3600
  };
}

// ===== 邮件发送（Resend）=====
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return { ok: false, error: '邮件服务未配置：请设置 RESEND_API_KEY' };
  const from = env.EMAIL_FROM || 'Steam 账号共享 <no-reply@steam-share.workers.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, html })
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: '邮件发送失败：' + (await res.text()).slice(0, 120) };
  } catch {
    return { ok: false, error: '邮件服务异常' };
  }
}

// ===== 邮箱验证码（KV）=====
async function saveCode(env, email, mode, code, ttl) {
  await env.KV.put(`code:${mode}:${email}`, JSON.stringify({ code, exp: now() + ttl * 1000 }), { expirationTtl: ttl });
}

async function verifyCode(env, email, mode, code) {
  const raw = await env.KV.get(`code:${mode}:${email}`);
  if (!raw) return false;
  const data = JSON.parse(raw);
  if (data.code !== String(code) || data.exp < now()) return false;
  await env.KV.delete(`code:${mode}:${email}`);
  return true;
}

// ===== 会话（KV）=====
async function createSession(env, uid, ttlSeconds) {
  const token = randomHex(32);
  await env.KV.put(`session:${token}`, String(uid), { expirationTtl: ttlSeconds });
  return token;
}

async function getSessionUid(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const uid = await env.KV.get(`session:${token}`);
  return uid ? parseInt(uid, 10) : null;
}

async function destroySession(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) await env.KV.delete(`session:${auth.slice(7)}`);
}

// ===== 首次部署：创建管理员 =====
async function ensureAdmin(env) {
  const email = env.ADMIN_EMAIL;
  if (!email) return;
  const exist = await env.D1.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exist) return;
  await env.D1.prepare('INSERT INTO users (username, email, is_admin, is_vip, created_at) VALUES (?, ?, 1, 1, ?)')
    .bind('admin', email, now()).run();
}

// ===== 路由处理 =====
async function handle(request, env) {
  if (request.method === 'OPTIONS') return json({});
  await ensureAdmin(env);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  const route = path.startsWith('api/') ? path.slice(4) : '';

  try {
    // ---- 公开接口 ----
    if (route === 'games' && request.method === 'GET') return apiGames(env);
    if (route === 'auth/send-code' && request.method === 'POST') return apiSendCode(env, request);
    if (route === 'auth/register' && request.method === 'POST') return apiRegister(env, request);
    if (route === 'auth/login' && request.method === 'POST') return apiLogin(env, request);
    if (route === 'auth/logout' && request.method === 'POST') return apiLogout(env, request);

    // ---- 需登录 ----
    const uid = await getSessionUid(env, request);
    if (route === 'auth/me' && request.method === 'GET') return apiMe(env, uid);
    if (route === 'account' && request.method === 'POST') return apiAccount(env, uid, request);
    if (route === 'submit' && request.method === 'POST') return apiSubmit(env, uid, request);

    // ---- 管理后台（需管理员）----
    if (route === 'admin/data' && request.method === 'GET') return apiAdminData(env, uid);
    if (route === 'admin/review' && request.method === 'POST') return apiAdminReview(env, uid, request);
    if (route === 'admin/game' && request.method === 'POST') return apiAdminGame(env, uid, request);
    if (route === 'admin/game/delete' && request.method === 'POST') return apiAdminGameDelete(env, uid, request);
    if (route === 'admin/account' && request.method === 'POST') return apiAdminAccount(env, uid, request);
    if (route === 'admin/account/delete' && request.method === 'POST') return apiAdminAccountDelete(env, uid, request);

    return json({ error: '接口不存在' }, 404);
  } catch (e) {
    return json({ error: '服务器错误：' + (e.message || '') }, 500);
  }
}

// ===================== 公开接口 =====================

async function apiGames(env) {
  const rows = await env.D1.prepare('SELECT * FROM games ORDER BY sort DESC, id ASC').all();
  const games = [];
  for (const g of rows.results) {
    const c = await env.D1.prepare('SELECT COUNT(*) c FROM game_accounts WHERE game_id = ?').bind(g.id).first();
    games.push({
      id: g.id,
      title: g.title,
      category: g.category,
      cover: g.cover || '',
      accountCount: c ? c.c : 0,
      createdAt: g.created_at
    });
  }
  return json({ games });
}

async function apiSendCode(env, request) {
  const conf = getConfig(env);
  const { email, mode } = await readBody(request);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return json({ error: '请输入有效的邮箱地址' });
  if (mode !== 'register' && mode !== 'login') return json({ error: '参数错误' });

  // 注册模式校验邮箱未被占用
  if (mode === 'register') {
    const dup = await env.D1.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (dup) return json({ error: '该邮箱已注册，请直接登录' });
  }

  // 60 秒限流
  const sent = await env.KV.get(`rl:${email}`);
  if (sent) return json({ error: '发送过于频繁，请稍后再试' });

  // TODO: Cloudflare Turnstile 校验（等用户提供接入代码与 API 后再植入）
  // 此处预留 turnstile token 校验位

  const code = genCode(conf.codeLen);
  await saveCode(env, email, mode, code, conf.codeTtl);
  await env.KV.put(`rl:${email}`, '1', { expirationTtl: conf.rateLimit });

  const subject = mode === 'register' ? '【Steam 账号共享】注册验证码' : '【Steam 账号共享】登录验证码';
  const html = `<div style="font-family:sans-serif;padding:20px">` +
    `<h2>Steam 账号共享</h2><p>你的验证码是：</p>` +
    `<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>` +
    `<p style="color:#999;font-size:13px">5 分钟内有效，请勿泄露给他人。</p></div>`;
  const r = await sendEmail(env, email, subject, html);
  if (!r.ok) return json({ error: r.error });
  return json({ success: true });
}

async function apiRegister(env, request) {
  const { email, code, username } = await readBody(request);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return json({ error: '请输入有效的邮箱地址' });
  if (!code) return json({ error: '请输入验证码' });
  if (!username || String(username).trim().length < 2) return json({ error: '用户名至少 2 个字符' });

  const dup = await env.D1.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (dup) return json({ error: '该邮箱已注册，请直接登录' });
  const unameDup = await env.D1.prepare('SELECT id FROM users WHERE username = ?').bind(String(username).trim()).first();
  if (unameDup) return json({ error: '用户名已被占用' });

  const ok = await verifyCode(env, email, 'register', String(code));
  if (!ok) return json({ error: '验证码错误或已过期' });

  await env.D1.prepare('INSERT INTO users (username, email, created_at) VALUES (?, ?, ?)')
    .bind(String(username).trim(), email, now()).run();

  const u = await env.D1.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const token = await createSession(env, u.id, getConfig(env).sessionTtl);
  return json({ success: true, token, user: userJson(u) });
}

async function apiLogin(env, request) {
  const { email, code } = await readBody(request);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return json({ error: '请输入有效的邮箱地址' });
  if (!code) return json({ error: '请输入验证码' });

  const ok = await verifyCode(env, email, 'login', String(code));
  if (!ok) return json({ error: '验证码错误或已过期' });

  let u = await env.D1.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u) {
    // 自动创建账号
    await env.D1.prepare('INSERT INTO users (username, email, created_at) VALUES (?, ?, ?)')
      .bind(genUsername(email), email, now()).run();
    u = await env.D1.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  }

  const token = await createSession(env, u.id, getConfig(env).sessionTtl);
  return json({ success: true, token, user: userJson(u) });
}

async function apiLogout(env, request) {
  await destroySession(env, request);
  return json({ success: true });
}

// ===================== 需登录接口 =====================

function userJson(u) {
  return { id: u.id, username: u.username, email: u.email, isVip: !!u.is_vip, isAdmin: !!u.is_admin, createdAt: u.created_at };
}

async function getQuota(env, uid) {
  const conf = getConfig(env);
  const date = bjDate();
  const row = await env.D1.prepare('SELECT used FROM quotas WHERE user_id = ? AND date = ?').bind(uid, date).first();
  const used = row ? row.used : 0;
  return { total: conf.dailyQuota, used, remaining: Math.max(0, conf.dailyQuota - used) };
}

async function apiMe(env, uid) {
  if (!uid) return json({ error: '未登录' }, 401);
  const u = await env.D1.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
  if (!u) return json({ error: '用户不存在' }, 401);
  const quota = await getQuota(env, uid);
  return json({ user: userJson(u), quota });
}

async function apiAccount(env, uid, request) {
  if (!uid) return json({ error: '请先登录' }, 401);
  const { gameId } = await readBody(request);

  const game = await env.D1.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first();
  if (!game) return json({ error: '游戏不存在' });

  const quota = await getQuota(env, uid);
  if (quota.remaining <= 0) return json({ error: '今日领取次数已用完，明天再来' });

  const acc = await env.D1.prepare('SELECT * FROM game_accounts WHERE game_id = ? ORDER BY RANDOM() LIMIT 1').bind(gameId).first();
  if (!acc) return json({ error: '该游戏暂无可用账号' });

  // 扣 1 次额度
  const date = bjDate();
  await env.D1.prepare('INSERT INTO quotas (user_id, date, used) VALUES (?, ?, 1) ON CONFLICT(user_id, date) DO UPDATE SET used = used + 1')
    .bind(uid, date).run();

  const newQuota = await getQuota(env, uid);
  return json({
    success: true,
    account: { account: acc.account, password: acc.password },
    game: { title: game.title, category: game.category, cover: game.cover || '' },
    quota: newQuota
  });
}

async function apiSubmit(env, uid, request) {
  if (!uid) return json({ error: '请先登录' }, 401);
  const { title, category, account, password } = await readBody(request);
  if (!title || !String(title).trim()) return json({ error: '请填写游戏名称' });
  if (!account || !String(account).trim()) return json({ error: '请填写账号' });
  if (!password) return json({ error: '请填写密码' });

  await env.D1.prepare('INSERT INTO submissions (user_id, title, category, account, password, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(uid, String(title).trim(), (category || '其他').trim(), String(account).trim(), String(password), 'pending', now()).run();
  return json({ success: true });
}

// ===================== 管理后台 =====================

async function isAdmin(env, uid) {
  if (!uid) return false;
  const u = await env.D1.prepare('SELECT is_admin FROM users WHERE id = ?').bind(uid).first();
  return !!(u && u.is_admin);
}

async function apiAdminData(env, uid) {
  if (!(await isAdmin(env, uid))) return json({ error: '无权限' }, 403);

  const games = await env.D1.prepare('SELECT * FROM games ORDER BY id DESC').all();
  const gamesOut = [];
  for (const g of games.results) {
    const acs = await env.D1.prepare('SELECT * FROM game_accounts WHERE game_id = ? ORDER BY id ASC').bind(g.id).all();
    gamesOut.push({ ...g, accounts: acs.results });
  }
  const submissions = await env.D1.prepare('SELECT * FROM submissions ORDER BY id DESC').all();
  const userCount = await env.D1.prepare('SELECT COUNT(*) c FROM users').first();
  return json({ games: gamesOut, submissions: submissions.results, userCount: userCount ? userCount.c : 0 });
}

async function apiAdminReview(env, uid, request) {
  if (!(await isAdmin(env, uid))) return json({ error: '无权限' }, 403);
  const { id, approved } = await readBody(request);
  const sub = await env.D1.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
  if (!sub) return json({ error: '提交记录不存在' });
  if (sub.status !== 'pending') return json({ error: '该提交已处理' });

  if (approved) {
    await env.D1.prepare('INSERT INTO games (title, category, created_at) VALUES (?, ?, ?)')
      .bind(sub.title, sub.category, now()).run();
    const g = await env.D1.prepare('SELECT id FROM games ORDER BY id DESC LIMIT 1').first();
    if (g) {
      await env.D1.prepare('INSERT INTO game_accounts (game_id, account, password) VALUES (?, ?, ?)')
        .bind(g.id, sub.account, sub.password).run();
    }
    await env.D1.prepare('UPDATE submissions SET status = ? WHERE id = ?').bind('approved', sub.id).run();
    await env.D1.prepare('UPDATE users SET is_vip = 1 WHERE id = ?').bind(sub.user_id).run();
  } else {
    await env.D1.prepare('UPDATE submissions SET status = ? WHERE id = ?').bind('rejected', sub.id).run();
  }
  return json({ success: true });
}

async function apiAdminGame(env, uid, request) {
  if (!(await isAdmin(env, uid))) return json({ error: '无权限' }, 403);
  const { id, title, category, cover } = await readBody(request);
  if (!title || !String(title).trim()) return json({ error: '请填写游戏名称' });
  if (id) {
    await env.D1.prepare('UPDATE games SET title = ?, category = ?, cover = ? WHERE id = ?')
      .bind(String(title).trim(), (category || '其他').trim(), (cover || '').trim(), id).run();
    return json({ success: true, id });
  }
  await env.D1.prepare('INSERT INTO games (title, category, cover, created_at) VALUES (?, ?, ?, ?)')
    .bind(String(title).trim(), (category || '其他').trim(), (cover || '').trim(), now()).run();
  return json({ success: true });
}

async function apiAdminGameDelete(env, uid, request) {
  if (!(await isAdmin(env, uid))) return json({ error: '无权限' }, 403);
  const { id } = await readBody(request);
  await env.D1.prepare('DELETE FROM game_accounts WHERE game_id = ?').bind(id).run();
  await env.D1.prepare('DELETE FROM games WHERE id = ?').bind(id).run();
  return json({ success: true });
}

async function apiAdminAccount(env, uid, request) {
  if (!(await isAdmin(env, uid))) return json({ error: '无权限' }, 403);
  const { gameId, account, password } = await readBody(request);
  if (!gameId || !account || !password) return json({ error: '参数不完整' });
  await env.D1.prepare('INSERT INTO game_accounts (game_id, account, password) VALUES (?, ?, ?)')
    .bind(gameId, String(account).trim(), String(password)).run();
  return json({ success: true });
}

async function apiAdminAccountDelete(env, uid, request) {
  if (!(await isAdmin(env, uid))) return json({ error: '无权限' }, 403);
  const { id } = await readBody(request);
  await env.D1.prepare('DELETE FROM game_accounts WHERE id = ?').bind(id).run();
  return json({ success: true });
}