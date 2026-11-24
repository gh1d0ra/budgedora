// Budgedora — a tiny multi-account expense tracker.
// Zero dependencies: Node 22.13+ (built-in node:sqlite), plain http server.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 60;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'budgedora.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS buckets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#64748b',
    monthly_budget INTEGER,            -- cents, optional
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bucket_id INTEGER NOT NULL REFERENCES buckets(id),
    amount INTEGER NOT NULL,           -- cents
    date TEXT NOT NULL,                -- YYYY-MM-DD
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_exp_user_date ON expenses(user_id, date);
`);

const DEFAULT_BUCKETS = [
  ['Groceries', '🛒', '#16a34a'],
  ['Restaurants', '🍽️', '#ea580c'],
  ['Household + grass', '🏡', '#65a30d'],
  ['Car/Gas', '⛽', '#2563eb'],
  ['House insurance/tax + HOA', '🧾', '#7c3aed'],
  ['Utilities', '💡', '#ca8a04'],
  ['Education', '🎓', '#0891b2'],
  ['Giving', '🎁', '#db2777'],
  ['Health/Beauty', '💊', '#dc2626'],
  ['Clothes', '👕', '#9333ea'],
  ['Entertainment', '🎬', '#0d9488'],
  ['Vacation', '✈️', '#0284c7'],
];

// ---------- helpers ----------
const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
};
const verifyPassword = (pw, stored) => {
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
const fail = (res, status, error) => send(res, status, { error });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('Body too large')); req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const parseCookies = (req) =>
  Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));

function sessionCookie(token, maxAgeSec, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_DAYS * 864e5);
  return token;
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.email, u.name, u.currency, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, currency: row.currency };
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const toCents = (v) => {
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) && n > 0 && n < 1e12 ? n : null;
};
const cleanStr = (s, max) => String(s ?? '').trim().slice(0, max);

const bucketOut = (b) => ({
  id: b.id, name: b.name, icon: b.icon, color: b.color, sort: b.sort,
  archived: !!b.archived,
  monthlyBudget: b.monthly_budget == null ? null : b.monthly_budget / 100,
});
const expenseOut = (e) => ({
  id: e.id, bucketId: e.bucket_id, amount: e.amount / 100, date: e.date, note: e.note,
});

function ownsBucket(userId, bucketId) {
  return !!db.prepare('SELECT 1 FROM buckets WHERE id = ? AND user_id = ?').get(bucketId, userId);
}

// Simple in-memory login throttle (per IP).
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, a);
  return a.length >= 20;
}
const noteAttempt = (ip) => attempts.get(ip).push(Date.now());

// ---------- API ----------
async function api(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const ip = req.socket.remoteAddress;

  if (pathname === '/api/signup' && method === 'POST') {
    if (throttled(ip)) return fail(res, 429, 'Too many attempts. Try again later.');
    noteAttempt(ip);
    const b = await readBody(req);
    const email = cleanStr(b.email, 200).toLowerCase();
    const name = cleanStr(b.name, 80) || email.split('@')[0];
    const password = String(b.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'Enter a valid email.');
    if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail(res, 409, 'An account with that email already exists.');
    const { lastInsertRowid: uid } = db.prepare('INSERT INTO users (email, name, pass_hash) VALUES (?, ?, ?)')
      .run(email, name, hashPassword(password));
    const ins = db.prepare('INSERT INTO buckets (user_id, name, icon, color, sort) VALUES (?, ?, ?, ?, ?)');
    DEFAULT_BUCKETS.forEach(([n, i, c], idx) => ins.run(uid, n, i, c, idx));
    const token = createSession(uid);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400, req) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (throttled(ip)) return fail(res, 429, 'Too many attempts. Try again later.');
    noteAttempt(ip);
    const b = await readBody(req);
    const u = db.prepare('SELECT id, pass_hash FROM users WHERE email = ?').get(cleanStr(b.email, 200));
    if (!u || !verifyPassword(String(b.password || ''), u.pass_hash)) return fail(res, 401, 'Wrong email or password.');
    const token = createSession(u.id);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400, req) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = parseCookies(req).sid;
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, req) });
  }

  // Everything below requires a session.
  const user = currentUser(req);
  if (!user) return fail(res, 401, 'Not signed in.');

  if (pathname === '/api/me' && method === 'GET') return send(res, 200, user);

  if (pathname === '/api/me' && method === 'PUT') {
    const b = await readBody(req);
    const name = cleanStr(b.name, 80) || user.name;
    const currency = /^[A-Z]{3}$/.test(b.currency) ? b.currency : user.currency;
    db.prepare('UPDATE users SET name = ?, currency = ? WHERE id = ?').run(name, currency, user.id);
    if (b.newPassword) {
      const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
      if (!verifyPassword(String(b.currentPassword || ''), row.pass_hash)) return fail(res, 400, 'Current password is wrong.');
      if (String(b.newPassword).length < 6) return fail(res, 400, 'New password must be at least 6 characters.');
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(b.newPassword)), user.id);
    }
    return send(res, 200, { ...user, name, currency });
  }

  // Everything the app needs in one call.
  if (pathname === '/api/data' && method === 'GET') {
    const buckets = db.prepare('SELECT * FROM buckets WHERE user_id = ? ORDER BY sort, id').all(user.id).map(bucketOut);
    const expenses = db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC, id DESC').all(user.id).map(expenseOut);
    return send(res, 200, { user, buckets, expenses });
  }

  // ----- buckets -----
  if (pathname === '/api/buckets' && method === 'POST') {
    const b = await readBody(req);
    const name = cleanStr(b.name, 60);
    if (!name) return fail(res, 400, 'Bucket needs a name.');
    const sort = (db.prepare('SELECT MAX(sort) m FROM buckets WHERE user_id = ?').get(user.id).m ?? -1) + 1;
    const budget = b.monthlyBudget ? toCents(b.monthlyBudget) : null;
    const { lastInsertRowid } = db.prepare('INSERT INTO buckets (user_id, name, icon, color, monthly_budget, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, name, cleanStr(b.icon, 8), /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#64748b', budget, sort);
    return send(res, 200, bucketOut(db.prepare('SELECT * FROM buckets WHERE id = ?').get(lastInsertRowid)));
  }

  if (pathname === '/api/buckets/order' && method === 'PUT') {
    const b = await readBody(req);
    if (!Array.isArray(b.ids)) return fail(res, 400, 'ids required');
    const upd = db.prepare('UPDATE buckets SET sort = ? WHERE id = ? AND user_id = ?');
    b.ids.forEach((id, i) => upd.run(i, Number(id), user.id));
    return send(res, 200, { ok: true });
  }

  let m = pathname.match(/^\/api\/buckets\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const cur = db.prepare('SELECT * FROM buckets WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!cur) return fail(res, 404, 'Bucket not found.');
    if (method === 'PUT') {
      const b = await readBody(req);
      const name = b.name !== undefined ? cleanStr(b.name, 60) || cur.name : cur.name;
      const icon = b.icon !== undefined ? cleanStr(b.icon, 8) : cur.icon;
      const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : cur.color;
      const budget = b.monthlyBudget === undefined ? cur.monthly_budget : (b.monthlyBudget ? toCents(b.monthlyBudget) : null);
      const archived = b.archived === undefined ? cur.archived : (b.archived ? 1 : 0);
      db.prepare('UPDATE buckets SET name=?, icon=?, color=?, monthly_budget=?, archived=? WHERE id=?')
        .run(name, icon, color, budget, archived, id);
      return send(res, 200, bucketOut(db.prepare('SELECT * FROM buckets WHERE id = ?').get(id)));
    }
    if (method === 'DELETE') {
      const used = db.prepare('SELECT COUNT(*) c FROM expenses WHERE bucket_id = ?').get(id).c;
      if (used) {
        // Keep history intact: archive instead of deleting.
        db.prepare('UPDATE buckets SET archived = 1 WHERE id = ?').run(id);
        return send(res, 200, { archived: true });
      }
      db.prepare('DELETE FROM buckets WHERE id = ?').run(id);
      return send(res, 200, { deleted: true });
    }
  }

  // ----- expenses -----
  if (pathname === '/api/expenses' && method === 'POST') {
    const b = await readBody(req);
    const amount = toCents(b.amount);
    if (!amount) return fail(res, 400, 'Enter an amount greater than 0.');
    if (!isDate(b.date)) return fail(res, 400, 'Pick a valid date.');
    if (!ownsBucket(user.id, Number(b.bucketId))) return fail(res, 400, 'Pick a bucket.');
    const { lastInsertRowid } = db.prepare('INSERT INTO expenses (user_id, bucket_id, amount, date, note) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, Number(b.bucketId), amount, b.date, cleanStr(b.note, 200));
    return send(res, 200, expenseOut(db.prepare('SELECT * FROM expenses WHERE id = ?').get(lastInsertRowid)));
  }

  if (pathname === '/api/expenses/import' && method === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.rows)) return fail(res, 400, 'rows required');
    const buckets = db.prepare('SELECT id, name FROM buckets WHERE user_id = ?').all(user.id);
    const byName = new Map(buckets.map((x) => [x.name.toLowerCase(), x.id]));
    const insB = db.prepare('INSERT INTO buckets (user_id, name, sort) VALUES (?, ?, 999)');
    const insE = db.prepare('INSERT INTO expenses (user_id, bucket_id, amount, date, note) VALUES (?, ?, ?, ?, ?)');
    let added = 0, skipped = 0;
    db.exec('BEGIN');
    try {
      for (const r of b.rows.slice(0, 50000)) {
        const amount = toCents(r.amount);
        const name = cleanStr(r.bucket, 60);
        if (!amount || !isDate(r.date) || !name) { skipped++; continue; }
        let bid = byName.get(name.toLowerCase());
        if (!bid) { bid = Number(insB.run(user.id, name).lastInsertRowid); byName.set(name.toLowerCase(), bid); }
        insE.run(user.id, bid, amount, r.date, cleanStr(r.note, 200));
        added++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return send(res, 200, { added, skipped });
  }

  m = pathname.match(/^\/api\/expenses\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const cur = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!cur) return fail(res, 404, 'Expense not found.');
    if (method === 'PUT') {
      const b = await readBody(req);
      const amount = b.amount !== undefined ? toCents(b.amount) : cur.amount;
      if (!amount) return fail(res, 400, 'Enter an amount greater than 0.');
      const date = b.date !== undefined ? b.date : cur.date;
      if (!isDate(date)) return fail(res, 400, 'Pick a valid date.');
      const bucketId = b.bucketId !== undefined ? Number(b.bucketId) : cur.bucket_id;
      if (!ownsBucket(user.id, bucketId)) return fail(res, 400, 'Pick a bucket.');
      const note = b.note !== undefined ? cleanStr(b.note, 200) : cur.note;
      db.prepare('UPDATE expenses SET amount=?, date=?, bucket_id=?, note=? WHERE id=?').run(amount, date, bucketId, note, id);
      return send(res, 200, expenseOut(db.prepare('SELECT * FROM expenses WHERE id = ?').get(id)));
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
      return send(res, 200, { deleted: true });
    }
  }

  if (pathname === '/api/export.csv' && method === 'GET') {
    const rows = db.prepare(`SELECT e.date, b.name bucket, e.amount, e.note FROM expenses e
      JOIN buckets b ON b.id = e.bucket_id WHERE e.user_id = ? ORDER BY e.date`).all(user.id);
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const csv = ['date,bucket,amount,note', ...rows.map((r) => [r.date, q(r.bucket), (r.amount / 100).toFixed(2), q(r.note)].join(','))].join('\n');
    return send(res, 200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="expenses.csv"',
    });
  }

  return fail(res, 404, 'Not found.');
}

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) =>
        e2 ? fail(res, 404, 'Not found') : send(res, 200, html, { 'Content-Type': MIME['.html'] }));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      // Basic CSRF guard: state-changing requests must be JSON from our own pages.
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
        return fail(res, 415, 'Use application/json');
      }
      return await api(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    return fail(res, 500, err.message === 'Invalid JSON' ? err.message : 'Server error');
  }
});

// Clean up expired sessions hourly.
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Budgedora running at http://localhost:${PORT}`));
}

module.exports = { db, DEFAULT_BUCKETS, hashPassword };
