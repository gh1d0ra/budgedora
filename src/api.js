// Budgedora JSON API — platform neutral (Web Request/Response + WebCrypto).
// Runs on Cloudflare Workers (D1) and on Node (node:sqlite) through a tiny async DB adapter:
//   db.all(sql, ...params) → rows    db.get(sql, ...params) → row | null
//   db.run(sql, ...params) → { lastId, changes }    db.batch([[sql, ...params], ...])

export const DEFAULT_BUCKETS = [
  ['Groceries', '🛒', '#16a34a'],
  ['Restaurants', '🍽️', '#ea580c'],
  ['Household', '🏡', '#65a30d'],
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

const SESSION_DAYS = 60;
const PBKDF2_ITER = 100000; // Workers' maximum for PBKDF2
const RESET_HOURS = 24;

// Account lockout (NIST SP 800-63B / OWASP style): temporary, escalating, reset on success.
const LOCK_AFTER = 5;                 // consecutive failures before the first lock
const LOCK_BASE_MS = 15 * 60e3;       // first lock: 15 minutes, doubling after each further failure
const LOCK_MAX_MS = 24 * 3600e3;      // never longer than 24 hours

/** Security headers for every response (pages, files and API). */
export const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/ https://cdn.sheetjs.com/xlsx-0.20.3/",
    "style-src 'self' 'unsafe-inline'", // inline style attributes for bucket colors
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

// ---------- crypto ----------
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
const sha256 = async (s) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${toHex(salt)}$${toHex(await pbkdf2(pw, salt, PBKDF2_ITER))}`;
}
async function verifyPassword(pw, stored) {
  const [kind, iter, saltHex, hashHex] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const got = new Uint8Array(await pbkdf2(pw, fromHex(saltHex), Number(iter)));
  const want = fromHex(hashHex);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
// Run a hash even for unknown emails so response time doesn't reveal which accounts exist.
const DUMMY_HASH = 'pbkdf2$100000$00000000000000000000000000000000$' + '0'.repeat(64);
export const randomToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

/** Creates a one-time reset token for a user; returns the raw token (only its hash is stored). */
export async function createResetToken(db, userId) {
  const token = randomToken();
  await db.batch([
    ['DELETE FROM reset_tokens WHERE user_id = ? OR expires_at < ?', userId, Date.now()],
    ['INSERT INTO reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)', await sha256(token), userId, Date.now() + RESET_HOURS * 3600e3],
  ]);
  return token;
}

// ---------- helpers ----------
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const fail = (status, error, extra = {}) => json(status, { error, ...extra });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function readBody(req) {
  const text = await req.text();
  if (text.length > 5e6) throw new HttpError(413, 'Body too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const parseCookies = (req) =>
  Object.fromEntries((req.headers.get('cookie') || '').split(';').filter((c) => c.includes('=')).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));

function sessionCookie(token, maxAgeSec, req) {
  const https = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const toCents = (v) => {
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) && n !== 0 && Math.abs(n) < 1e12 ? n : null; // negative = refund/credit
};
const cleanStr = (s, max) => String(s ?? '').trim().slice(0, max);
const isColor = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60e3));
const checkNewPassword = (pw) => {
  if (String(pw || '').length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
  if (String(pw).length > 200) throw new HttpError(400, 'Password is too long.');
};

const bucketOut = (b) => ({
  id: b.id, name: b.name, icon: b.icon, color: b.color, sort: b.sort, archived: !!b.archived,
  monthlyBudget: b.monthly_budget == null ? null : b.monthly_budget / 100,
});
const expenseOut = (e) => ({ id: e.id, bucketId: e.bucket_id, amount: e.amount / 100, date: e.date, note: e.note });

// ---------- sessions & throttling ----------
async function createSession(db, userId) {
  const token = randomToken();
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, Date.now() + SESSION_DAYS * 864e5);
  return token;
}

async function currentUser(db, req, admins) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = await db.get(`SELECT u.id, u.email, u.name, u.currency, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.deleted_at IS NULL`, token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { await db.run('DELETE FROM sessions WHERE token = ?', token); return null; }
  return { id: row.id, email: row.email, name: row.name, currency: row.currency, isAdmin: admins.has(row.email.toLowerCase()) };
}

/** Per-IP limit across all accounts: 30 sign-in/sign-up/reset attempts per 15 minutes. */
async function throttleIp(db, ip) {
  const since = Date.now() - 15 * 60e3;
  const { n } = await db.get('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?', ip, since);
  if (n >= 30) throw new HttpError(429, 'Too many attempts from this network. Try again in a few minutes.');
  await db.batch([
    ['INSERT INTO login_attempts (ip, at) VALUES (?, ?)', ip, Date.now()],
    ['DELETE FROM login_attempts WHERE at < ?', since],
  ]);
}

// ---------- API ----------
/**
 * @param {Request} req
 * @param db  async DB adapter
 * @param {{ip?: string, admins?: string}} opts  admins: comma-separated admin emails
 */
export async function handleApi(req, db, { ip = 'unknown', admins = '', backup = null } = {}) {
  const adminSet = new Set(String(admins).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  let res;
  try {
    // Basic CSRF guard: state-changing requests must be JSON (forces a CORS preflight cross-site).
    if (req.method !== 'GET' && !String(req.headers.get('content-type') || '').includes('application/json')) {
      res = fail(415, 'Use application/json');
    } else {
      res = await route(req, db, ip, adminSet, backup);
    }
  } catch (err) {
    if (err instanceof HttpError) res = fail(err.status, err.message);
    else { console.error(err); res = fail(500, 'Server error'); }
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

async function route(req, db, ip, admins, backup) {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/signup' && method === 'POST') {
    await throttleIp(db, ip);
    const b = await readBody(req);
    const email = cleanStr(b.email, 200).toLowerCase();
    const name = cleanStr(b.name, 80) || email.split('@')[0];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, 'Enter a valid email.');
    checkNewPassword(b.password);
    const existing = await db.get('SELECT deleted_at FROM users WHERE email = ?', email);
    if (existing?.deleted_at) return fail(409, 'This email belongs to a deleted account. Ask the family admin to restore it.');
    if (existing) return fail(409, 'An account with that email already exists.');
    const { lastId: uid } = await db.run('INSERT INTO users (email, name, pass_hash) VALUES (?, ?, ?)', email, name, await hashPassword(String(b.password)));
    await db.batch(DEFAULT_BUCKETS.map(([n, i, c], idx) => ['INSERT INTO buckets (user_id, name, icon, color, sort) VALUES (?, ?, ?, ?, ?)', uid, n, i, c, idx]));
    const token = await createSession(db, uid);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400, req) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    await throttleIp(db, ip);
    const b = await readBody(req);
    const u = await db.get('SELECT id, pass_hash, failed_logins, locked_until, deleted_at FROM users WHERE email = ?', cleanStr(b.email, 200));
    const now = Date.now();
    if (u?.locked_until && u.locked_until > now) {
      return fail(423, `Too many wrong passwords. This account is locked for ${minutes(u.locked_until - now)} more minute(s). The family admin can unlock it.`, { lockedUntil: u.locked_until });
    }
    const ok = await verifyPassword(String(b.password || ''), u ? u.pass_hash : DUMMY_HASH);
    if (!u || !ok) {
      if (u) {
        const fails = u.failed_logins + 1;
        const lockMs = fails >= LOCK_AFTER ? Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (fails - LOCK_AFTER)) : 0;
        await db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', fails, lockMs ? now + lockMs : null, u.id);
        if (lockMs) return fail(423, `Too many wrong passwords. This account is locked for ${minutes(lockMs)} minute(s). The family admin can unlock it.`, { lockedUntil: now + lockMs });
        if (fails >= LOCK_AFTER - 2) return fail(401, `Wrong email or password. ${LOCK_AFTER - fails} attempt(s) left before the account is temporarily locked.`);
      }
      return fail(401, 'Wrong email or password.');
    }
    if (u.deleted_at) return fail(403, 'This account was deleted. Ask the family admin to restore it — all your data is still there.');
    await db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
    const token = await createSession(db, u.id);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400, req) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = parseCookies(req).sid;
    if (token) await db.run('DELETE FROM sessions WHERE token = ?', token);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, req) });
  }

  // Password reset with a one-time link (created by the family admin).
  if (pathname === '/api/reset' && method === 'POST') {
    await throttleIp(db, ip);
    const b = await readBody(req);
    const row = await db.get('SELECT t.user_id, t.expires_at, t.used_at, u.email FROM reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?',
      await sha256(String(b.token || '')));
    if (!row || row.used_at || row.expires_at < Date.now()) return fail(400, 'This reset link is invalid or has expired. Ask the family admin for a new one.');
    checkNewPassword(b.password);
    await db.batch([
      ['UPDATE users SET pass_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', await hashPassword(String(b.password)), row.user_id],
      ['UPDATE reset_tokens SET used_at = ? WHERE token_hash = ?', Date.now(), await sha256(String(b.token))],
      ['DELETE FROM sessions WHERE user_id = ?', row.user_id], // sign out everywhere else
    ]);
    const token = await createSession(db, row.user_id);
    return json(200, { ok: true, email: row.email }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400, req) });
  }

  // Everything below requires a session.
  const user = await currentUser(db, req, admins);
  if (!user) return fail(401, 'Not signed in.');
  const uid = user.id;

  if (pathname === '/api/me' && method === 'GET') return json(200, user);

  if (pathname === '/api/me' && method === 'PUT') {
    const b = await readBody(req);
    const name = cleanStr(b.name, 80) || user.name;
    const currency = /^[A-Z]{3}$/.test(b.currency) ? b.currency : user.currency;
    if (b.newPassword) {
      const row = await db.get('SELECT pass_hash FROM users WHERE id = ?', uid);
      if (!(await verifyPassword(String(b.currentPassword || ''), row.pass_hash))) return fail(400, 'Current password is wrong.');
      checkNewPassword(b.newPassword);
      const current = parseCookies(req).sid;
      await db.batch([
        ['UPDATE users SET pass_hash = ? WHERE id = ?', await hashPassword(String(b.newPassword)), uid],
        ['DELETE FROM sessions WHERE user_id = ? AND token <> ?', uid, current], // sign out other devices
      ]);
    }
    await db.run('UPDATE users SET name = ?, currency = ? WHERE id = ?', name, currency, uid);
    return json(200, { ...user, name, currency });
  }

  // Soft delete: hide the account but keep every row so it can be restored later.
  if (pathname === '/api/account/delete' && method === 'POST') {
    const b = await readBody(req);
    if (b.confirm !== 'DELETE') return fail(400, 'Type DELETE to confirm.');
    const row = await db.get('SELECT pass_hash FROM users WHERE id = ?', uid);
    if (!(await verifyPassword(String(b.password || ''), row.pass_hash))) return fail(400, 'Password is wrong.');
    await db.batch([
      ["UPDATE users SET deleted_at = datetime('now') WHERE id = ?", uid],
      ['DELETE FROM sessions WHERE user_id = ?', uid],
    ]);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, req) });
  }

  // ----- admin (family admin: emails listed in ADMIN_EMAILS) -----
  if (pathname.startsWith('/api/admin/')) {
    if (!user.isAdmin) return fail(403, 'Admins only.');
    if (pathname === '/api/admin/users' && method === 'GET') {
      const rows = await db.all(`SELECT u.id, u.email, u.name, u.created_at, u.deleted_at, u.locked_until, u.failed_logins,
        (SELECT COUNT(*) FROM expenses e WHERE e.user_id = u.id) AS expenses,
        (SELECT MAX(date) FROM expenses e WHERE e.user_id = u.id) AS last_expense
        FROM users u ORDER BY u.deleted_at IS NOT NULL, u.created_at`);
      const now = Date.now();
      return json(200, rows.map((r) => ({
        id: r.id, email: r.email, name: r.name, createdAt: r.created_at, deletedAt: r.deleted_at,
        locked: !!(r.locked_until && r.locked_until > now), failedLogins: r.failed_logins,
        expenses: r.expenses, lastExpense: r.last_expense, isAdmin: admins.has(r.email.toLowerCase()),
      })));
    }
    if (pathname === '/api/admin/backup' && method === 'POST') {
      if (!backup) return fail(501, 'Backups are not configured on this server.');
      return json(200, await backup('manual'));
    }
    const am = pathname.match(/^\/api\/admin\/users\/(\d+)\/(reset-link|restore|unlock)$/);
    if (am && method === 'POST') {
      const target = await db.get('SELECT id, email, deleted_at FROM users WHERE id = ?', Number(am[1]));
      if (!target) return fail(404, 'Account not found.');
      if (am[2] === 'reset-link') {
        const token = await createResetToken(db, target.id);
        return json(200, { link: `${url.origin}/#reset=${token}`, expiresInHours: RESET_HOURS, email: target.email });
      }
      if (am[2] === 'restore') {
        await db.run('UPDATE users SET deleted_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?', target.id);
        return json(200, { ok: true });
      }
      if (am[2] === 'unlock') {
        await db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', target.id);
        return json(200, { ok: true });
      }
    }
    return fail(404, 'Not found.');
  }

  if (pathname === '/api/data' && method === 'GET') {
    const [buckets, expenses, budgets] = await Promise.all([
      db.all('SELECT * FROM buckets WHERE user_id = ? ORDER BY sort, id', uid),
      db.all('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC, id DESC', uid),
      db.all('SELECT bucket_id, month, amount FROM budgets WHERE user_id = ? ORDER BY month', uid),
    ]);
    return json(200, {
      user, buckets: buckets.map(bucketOut), expenses: expenses.map(expenseOut),
      budgets: budgets.map((b) => ({ bucketId: b.bucket_id, month: b.month, amount: b.amount / 100 })),
    });
  }

  // ----- month plan: expected amount per bucket for one month -----
  // PUT { month: 'YYYY-MM', items: [{ bucketId, amount }] }   amount null → back to the bucket's default
  if (pathname === '/api/budgets' && method === 'PUT') {
    const b = await readBody(req);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.month))) return fail(400, 'Pick a month.');
    if (!Array.isArray(b.items) || !b.items.length) return fail(400, 'Nothing to save.');
    const owned = new Set((await db.all('SELECT id FROM buckets WHERE user_id = ?', uid)).map((x) => x.id));
    const stmts = [];
    for (const it of b.items.slice(0, 500)) {
      const bid = Number(it.bucketId);
      if (!owned.has(bid)) return fail(400, 'Unknown bucket.');
      if (it.amount === null || it.amount === '' || it.amount === undefined) {
        stmts.push(['DELETE FROM budgets WHERE user_id = ? AND bucket_id = ? AND month = ?', uid, bid, b.month]);
        continue;
      }
      const cents = Math.round(Number(it.amount) * 100);
      if (!Number.isFinite(cents) || cents < 0 || cents >= 1e12) return fail(400, 'Expected amounts must be 0 or more.');
      stmts.push(['INSERT INTO budgets (user_id, bucket_id, month, amount) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, bucket_id, month) DO UPDATE SET amount = excluded.amount', uid, bid, b.month, cents]);
    }
    await db.batch(stmts);
    const rows = await db.all('SELECT bucket_id, month, amount FROM budgets WHERE user_id = ? AND month = ?', uid, b.month);
    return json(200, rows.map((r) => ({ bucketId: r.bucket_id, month: r.month, amount: r.amount / 100 })));
  }

  // ----- buckets -----
  if (pathname === '/api/buckets' && method === 'POST') {
    const b = await readBody(req);
    const name = cleanStr(b.name, 60);
    if (!name) return fail(400, 'Bucket needs a name.');
    const { m } = await db.get('SELECT MAX(sort) AS m FROM buckets WHERE user_id = ?', uid);
    const { lastId } = await db.run('INSERT INTO buckets (user_id, name, icon, color, monthly_budget, sort) VALUES (?, ?, ?, ?, ?, ?)',
      uid, name, cleanStr(b.icon, 8), isColor(b.color) ? b.color : '#64748b', b.monthlyBudget && toCents(b.monthlyBudget) > 0 ? toCents(b.monthlyBudget) : null, (m ?? -1) + 1);
    return json(200, bucketOut(await db.get('SELECT * FROM buckets WHERE id = ?', lastId)));
  }

  if (pathname === '/api/buckets/order' && method === 'PUT') {
    const b = await readBody(req);
    if (!Array.isArray(b.ids)) return fail(400, 'ids required');
    await db.batch(b.ids.slice(0, 500).map((id, i) => ['UPDATE buckets SET sort = ? WHERE id = ? AND user_id = ?', i, Number(id), uid]));
    return json(200, { ok: true });
  }

  let m = pathname.match(/^\/api\/buckets\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const cur = await db.get('SELECT * FROM buckets WHERE id = ? AND user_id = ?', id, uid);
    if (!cur) return fail(404, 'Bucket not found.');
    if (method === 'PUT') {
      const b = await readBody(req);
      const name = b.name !== undefined ? cleanStr(b.name, 60) || cur.name : cur.name;
      const icon = b.icon !== undefined ? cleanStr(b.icon, 8) : cur.icon;
      const color = isColor(b.color) ? b.color : cur.color;
      const budget = b.monthlyBudget === undefined ? cur.monthly_budget : (b.monthlyBudget && toCents(b.monthlyBudget) > 0 ? toCents(b.monthlyBudget) : null);
      const archived = b.archived === undefined ? cur.archived : (b.archived ? 1 : 0);
      await db.run('UPDATE buckets SET name=?, icon=?, color=?, monthly_budget=?, archived=? WHERE id=?', name, icon, color, budget, archived, id);
      return json(200, bucketOut(await db.get('SELECT * FROM buckets WHERE id = ?', id)));
    }
    if (method === 'DELETE') {
      const { c } = await db.get('SELECT COUNT(*) AS c FROM expenses WHERE bucket_id = ?', id);
      if (c) { // keep history intact: archive instead of deleting
        await db.run('UPDATE buckets SET archived = 1 WHERE id = ?', id);
        return json(200, { archived: true });
      }
      await db.run('DELETE FROM buckets WHERE id = ?', id);
      return json(200, { deleted: true });
    }
  }

  // ----- expenses -----
  const ownsBucket = async (bid) => !!(await db.get('SELECT 1 AS x FROM buckets WHERE id = ? AND user_id = ?', bid, uid));

  if (pathname === '/api/expenses' && method === 'POST') {
    const b = await readBody(req);
    const amount = toCents(b.amount);
    if (!amount) return fail(400, 'Enter an amount (use a minus sign for refunds).');
    if (!isDate(b.date)) return fail(400, 'Pick a valid date.');
    if (!(await ownsBucket(Number(b.bucketId)))) return fail(400, 'Pick a bucket.');
    const { lastId } = await db.run('INSERT INTO expenses (user_id, bucket_id, amount, date, note) VALUES (?, ?, ?, ?, ?)',
      uid, Number(b.bucketId), amount, b.date, cleanStr(b.note, 200));
    return json(200, expenseOut(await db.get('SELECT * FROM expenses WHERE id = ?', lastId)));
  }

  if (pathname === '/api/expenses/import' && method === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.rows)) return fail(400, 'rows required');
    const byName = new Map((await db.all('SELECT id, name FROM buckets WHERE user_id = ?', uid)).map((x) => [x.name.toLowerCase(), x.id]));
    const stmts = [];
    let skipped = 0;
    for (const r of b.rows.slice(0, 20000)) {
      const amount = toCents(r.amount);
      const name = cleanStr(r.bucket, 60);
      if (!amount || !isDate(r.date) || !name) { skipped++; continue; }
      let bid = byName.get(name.toLowerCase());
      if (!bid) {
        bid = (await db.run('INSERT INTO buckets (user_id, name, sort) VALUES (?, ?, 999)', uid, name)).lastId;
        byName.set(name.toLowerCase(), bid);
      }
      stmts.push(['INSERT INTO expenses (user_id, bucket_id, amount, date, note) VALUES (?, ?, ?, ?, ?)', uid, bid, amount, r.date, cleanStr(r.note, 200)]);
    }
    for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));
    return json(200, { added: stmts.length, skipped });
  }

  m = pathname.match(/^\/api\/expenses\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const cur = await db.get('SELECT * FROM expenses WHERE id = ? AND user_id = ?', id, uid);
    if (!cur) return fail(404, 'Expense not found.');
    if (method === 'PUT') {
      const b = await readBody(req);
      const amount = b.amount !== undefined ? toCents(b.amount) : cur.amount;
      if (!amount) return fail(400, 'Enter an amount (use a minus sign for refunds).');
      const date = b.date !== undefined ? b.date : cur.date;
      if (!isDate(date)) return fail(400, 'Pick a valid date.');
      const bucketId = b.bucketId !== undefined ? Number(b.bucketId) : cur.bucket_id;
      if (!(await ownsBucket(bucketId))) return fail(400, 'Pick a bucket.');
      const note = b.note !== undefined ? cleanStr(b.note, 200) : cur.note;
      await db.run('UPDATE expenses SET amount=?, date=?, bucket_id=?, note=? WHERE id=?', amount, date, bucketId, note, id);
      return json(200, expenseOut(await db.get('SELECT * FROM expenses WHERE id = ?', id)));
    }
    if (method === 'DELETE') {
      await db.run('DELETE FROM expenses WHERE id = ?', id);
      return json(200, { deleted: true });
    }
  }

  if (pathname === '/api/export.csv' && method === 'GET') {
    const rows = await db.all(`SELECT e.date, b.name AS bucket, e.amount, e.note FROM expenses e
      JOIN buckets b ON b.id = e.bucket_id WHERE e.user_id = ? ORDER BY e.date`, uid);
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const csv = ['date,bucket,amount,note', ...rows.map((r) => [r.date, q(r.bucket), (r.amount / 100).toFixed(2), q(r.note)].join(','))].join('\n');
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="expenses.csv"', 'Cache-Control': 'no-store' } });
  }

  return fail(404, 'Not found.');
}

// ---------- backups ----------
/** Full snapshot of everything needed to restore accounts (not sessions/attempts/tokens). */
export async function snapshot(db) {
  const [users, buckets, expenses, budgets] = await Promise.all([
    db.all('SELECT * FROM users ORDER BY id'),
    db.all('SELECT * FROM buckets ORDER BY id'),
    db.all('SELECT * FROM expenses ORDER BY id'),
    db.all('SELECT * FROM budgets ORDER BY user_id, month'),
  ]);
  return { version: 3, takenAt: new Date().toISOString(), users, buckets, expenses, budgets };
}
