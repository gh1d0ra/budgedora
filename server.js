// Local Node server for Budgedora (Node 22.13+, built-in node:sqlite, zero dependencies).
// Production runs on Cloudflare Workers (src/worker.js); both use the same API in src/api.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { handleApi, snapshot, SECURITY_HEADERS } from './src/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new DatabaseSync(path.join(DATA_DIR, 'budgedora.db'));
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
sqlite.exec(fs.readFileSync(path.join(__dirname, 'src', 'schema.sql'), 'utf8'));
// Apply migrations to older local databases (each statement is safe to retry).
for (const f of fs.readdirSync(path.join(__dirname, 'src', 'migrations')).sort()) {
  for (const stmt of fs.readFileSync(path.join(__dirname, 'src', 'migrations', f), 'utf8').replace(/--.*$/gm, '').split(';')) {
    if (!stmt.trim()) continue;
    try { sqlite.exec(stmt); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}
const ADMIN_EMAILS = process.env.ADMIN_EMAILS || '';

export const db = {
  all: async (sql, ...p) => sqlite.prepare(sql).all(...p),
  get: async (sql, ...p) => sqlite.prepare(sql).get(...p) ?? null,
  run: async (sql, ...p) => {
    const r = sqlite.prepare(sql).run(...p);
    return { lastId: Number(r.lastInsertRowid), changes: r.changes };
  },
  batch: async (stmts) => {
    sqlite.exec('BEGIN');
    try { stmts.forEach(([sql, ...p]) => sqlite.prepare(sql).run(...p)); sqlite.exec('COMMIT'); }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};

// Local equivalent of the Worker's KV snapshots: data/backups/manual-*.json.gz
async function localBackup() {
  const snap = await snapshot(db);
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const body = zlib.gzipSync(JSON.stringify(snap));
  const key = `manual-${snap.takenAt.slice(0, 19).replace(/:/g, '-')}.json.gz`;
  fs.writeFileSync(path.join(dir, key), body);
  return { key: `data/backups/${key}`, users: snap.users.length, expenses: snap.expenses.length, bytes: body.length, takenAt: snap.takenAt };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  return new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
    method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  try {
    const out = await handleApi(await toRequest(req), db, { ip: req.socket.remoteAddress, admins: ADMIN_EMAILS, backup: localBackup });
    const headers = Object.fromEntries(out.headers);
    res.writeHead(out.status, headers);
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"Server error"}');
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setInterval(() => sqlite.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();
  server.listen(PORT, () => console.log(`Budgedora running at http://localhost:${PORT}`));
}
