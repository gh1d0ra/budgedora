// Local Node server for Budgedora (Node 22.18+, which runs TypeScript directly; built-in node:sqlite; no runtime dependencies).
// Production runs on Cloudflare Workers (src/worker.ts); both use the same API in src/api.ts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi, snapshot, SECURITY_HEADERS } from './src/api.ts';
import type { BackupResult } from './src/api.ts';
import { openSqlite } from './src/sqlite-db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const { sqlite, db } = openSqlite(path.join(DATA_DIR, 'budgedora.db'));
export { db };
const ADMIN_EMAILS = process.env.ADMIN_EMAILS || '';

// Local equivalent of the Worker's KV snapshots: data/backups/manual-*.json.gz
async function localBackup(): Promise<BackupResult> {
  const snap = await snapshot(db);
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const body = zlib.gzipSync(JSON.stringify(snap));
  const key = `manual-${snap.takenAt.slice(0, 19).replace(/:/g, '-')}.json.gz`;
  fs.writeFileSync(path.join(dir, key), body);
  return { key: `data/backups/${key}`, users: snap.users.length, expenses: snap.expenses.length, bytes: body.length, takenAt: snap.takenAt };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res: ServerResponse, pathname: string): void {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  return new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
    method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
  try {
    const out = await handleApi(await toRequest(req), db, { ip: req.socket.remoteAddress ?? 'unknown', admins: ADMIN_EMAILS, backup: localBackup });
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
