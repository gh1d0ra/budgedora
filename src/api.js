// Budgedora JSON API — platform neutral (Web Request/Response + WebCrypto).
// Runs on Cloudflare Workers (D1) and on Node (node:sqlite) through a tiny async DB adapter:
//   db.all(sql, ...params) → rows    db.get(sql, ...params) → row | null
//   db.run(sql, ...params) → { lastId, changes }    db.batch([[sql, ...params], ...])

export const DEFAULT_BUCKETS = [
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

const SESSION_DAYS = 60;
const PBKDF2_ITER = 100000; // Workers' maximum for PBKDF2

// ---------- crypto ----------
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

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
const randomToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

// ---------- helpers ----------
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const fail = (status, error) => json(status, { error });

async function readBody(req) {
  const text = await req.text();
  if (text.length > 5e6) throw new HttpError(413, 'Body too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

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
  return Number.isFinite(n) && n > 0 && n < 1e12 ? n : null;
};
const cleanStr = (s, max) => String(s ?? '').trim().slice(0, max);
const isColor = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));

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

async function currentUser(db, req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = await db.get(`SELECT u.id, u.email, u.name, u.currency, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { await db.run('DELETE FROM sessions WHERE token = ?', token); return null; }
  return { id: row.id, email: row.email, name: row.name, currency: row.currency };
}

/** Max 20 sign-in/sign-up attempts per IP per 15 minutes. */
async function throttle(db, ip) {
  const since = Date.now() - 15 * 60e3;
  const { n } = await db.get('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?', ip, since);
  if (n >= 20) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  await db.batch([
    ['INSERT INTO login_attempts (ip, at) VALUES (?, ?)', ip, Date.now()],
    ['DELETE FROM login_attempts WHERE at < ?', since],
  ]);
}

// ---------- API ----------
export async function handleApi(req, db, { ip = 'unknown' } = {}) {
  try {
    // Basic CSRF guard: state-changing requests must be JSON (forces a CORS preflight cross-site).
    if (req.method !== 'GET' && !String(req.headers.get('content-type') || '').includes('application/json')) {
      return fail(415, 'Use application/json');
    }
    return await route(req, db, ip);
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message);
    console.error(err);
    return fail(500, 'Server error');
  }
}

async function route(req, db, ip) {
  const { pathname } = new URL(req.url);
  const method = req.method;

  if (pathname === '/api/signup' && method === 'POST') {
    await throttle(db, ip);
    const b = await readBody(req);
    const email = cleanStr(b.email, 200).toLowerCase();
    const name = cleanStr(b.name, 80) || email.split('@')[0];
    const password = String(b.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, 'Enter a valid email.');
    if (password.length < 6) return fail(400, 'Password must be at least 6 characters.');
    if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) return fail(409, 'An account with that email already exists.');
    const { lastId: uid } = await db.run('INSERT INTO users (email, name, pass_hash) VALUES (?, ?, ?)', email, name, await hashPassword(password));
    await db.batch(DEFAULT_BUCKETS.map(([n, i, c], idx) => ['INSERT INTO buckets (user_id, name, icon, color, sort) VALUES (?, ?, ?, ?, ?)', uid, n, i, c, idx]));
    const token = await createSession(db, uid);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400, req) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    await throttle(db, ip);
    const b = await readBody(req);
    const u = await db.get('SELECT id, pass_hash FROM users WHERE email = ?', cleanStr(b.email, 200));
    if (!u || !(await verifyPassword(String(b.password || ''), u.pass_hash))) return fail(401, 'Wrong email or password.');
    const token = await createSession(db, u.id);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400, req) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = parseCookies(req).sid;
    if (token) await db.run('DELETE FROM sessions WHERE token = ?', token);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, req) });
  }

  // Everything below requires a session.
  const user = await currentUser(db, req);
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
      if (String(b.newPassword).length < 6) return fail(400, 'New password must be at least 6 characters.');
      await db.run('UPDATE users SET pass_hash = ? WHERE id = ?', await hashPassword(String(b.newPassword)), uid);
    }
    await db.run('UPDATE users SET name = ?, currency = ? WHERE id = ?', name, currency, uid);
    return json(200, { ...user, name, currency });
  }

  if (pathname === '/api/data' && method === 'GET') {
    const [buckets, expenses] = await Promise.all([
      db.all('SELECT * FROM buckets WHERE user_id = ? ORDER BY sort, id', uid),
      db.all('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC, id DESC', uid),
    ]);
    return json(200, { user, buckets: buckets.map(bucketOut), expenses: expenses.map(expenseOut) });
  }

  // ----- buckets -----
  if (pathname === '/api/buckets' && method === 'POST') {
    const b = await readBody(req);
    const name = cleanStr(b.name, 60);
    if (!name) return fail(400, 'Bucket needs a name.');
    const { m } = await db.get('SELECT MAX(sort) AS m FROM buckets WHERE user_id = ?', uid);
    const { lastId } = await db.run('INSERT INTO buckets (user_id, name, icon, color, monthly_budget, sort) VALUES (?, ?, ?, ?, ?, ?)',
      uid, name, cleanStr(b.icon, 8), isColor(b.color) ? b.color : '#64748b', b.monthlyBudget ? toCents(b.monthlyBudget) : null, (m ?? -1) + 1);
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
      const budget = b.monthlyBudget === undefined ? cur.monthly_budget : (b.monthlyBudget ? toCents(b.monthlyBudget) : null);
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
    if (!amount) return fail(400, 'Enter an amount greater than 0.');
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
      if (!amount) return fail(400, 'Enter an amount greater than 0.');
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
