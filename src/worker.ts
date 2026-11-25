// Cloudflare Worker entry: /api/* → shared API on D1, everything else → static assets in /public.
import { handleApi, snapshot, cleanupDemos, SECURITY_HEADERS } from './api.ts';
import type { Db, Stmt, BackupKind, BackupResult } from './api.ts';

interface Env {
  DB: D1Database;
  BACKUPS?: KVNamespace;
  ASSETS: Fetcher;
  ADMIN_EMAILS?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  METRICS?: AnalyticsEngineDataset;
}

const d1 = (D1: D1Database): Db => ({
  all: async (sql, ...p) => (await D1.prepare(sql).bind(...p).all<any>()).results,
  get: async (sql, ...p) => (await D1.prepare(sql).bind(...p).first<any>()) ?? null,
  run: async (sql, ...p) => {
    const r = await D1.prepare(sql).bind(...p).run();
    return { lastId: r.meta.last_row_id, changes: r.meta.changes };
  },
  batch: async (stmts: Stmt[]) => (stmts.length ? D1.batch(stmts.map(([sql, ...p]) => D1.prepare(sql).bind(...p))) : []),
});

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * Stores a compressed snapshot in KV.
 *   daily/YYYY-MM-DD.json.gz            kept 35 days
 *   monthly/YYYY-MM.json.gz             kept forever (written on the 1st)
 *   manual/YYYY-MM-DDTHH-MM-SS.json.gz  kept 180 days ("Back up now")
 */
async function backupToKv(env: Env, kind: BackupKind): Promise<BackupResult> {
  if (!env.BACKUPS) throw new Error('KV binding BACKUPS missing');
  const snap = await snapshot(d1(env.DB));
  const body = await gzip(JSON.stringify(snap));
  const meta = { metadata: { users: snap.users.length, expenses: snap.expenses.length, takenAt: snap.takenAt } };
  const day = snap.takenAt.slice(0, 10);
  let key: string;
  if (kind === 'manual') {
    key = `manual/${snap.takenAt.slice(0, 19).replace(/:/g, '-')}.json.gz`;
    await env.BACKUPS.put(key, body, { ...meta, expirationTtl: 180 * 86400 });
  } else {
    key = `daily/${day}.json.gz`;
    await env.BACKUPS.put(key, body, { ...meta, expirationTtl: 35 * 86400 });
    if (day.endsWith('-01')) await env.BACKUPS.put(`monthly/${day.slice(0, 7)}.json.gz`, body, meta);
  }
  return { key, users: snap.users.length, expenses: snap.expenses.length, bytes: body.byteLength, takenAt: snap.takenAt };
}

// ---------- observability ----------
// One data point per API request in Workers Analytics Engine (dataset budgedora_requests), queried with SQL
// (scripts/metrics.ts, docs/observability.md), plus one structured JSON log line that Workers Logs indexes.
//   blobs:   route, method, status class, version, colo        doubles: ms, status, D1 queries, D1 rows read
/** /api/expenses/123 → /api/expenses/:id, so routes group together. */
const routeOf = (path: string): string => path.replace(/\/\d+(?=\/|$)/g, '/:id');

/** The D1 adapter, counting queries and rows read for this request. */
function counted(D1: D1Database, stats: { queries: number; rows: number }): Db {
  const meta = async <T>(p: Promise<D1Result<T>>) => { const r = await p; stats.queries++; stats.rows += r.meta?.rows_read ?? 0; return r; };
  return {
    all: async (sql, ...p) => (await meta(D1.prepare(sql).bind(...p).all<any>())).results,
    get: async (sql, ...p) => { const r = await meta(D1.prepare(sql).bind(...p).all<any>()); return r.results[0] ?? null; },
    run: async (sql, ...p) => { const r = await meta(D1.prepare(sql).bind(...p).run()); return { lastId: r.meta.last_row_id, changes: r.meta.changes }; },
    batch: async (stmts: Stmt[]) => {
      if (!stmts.length) return [];
      const rs = await D1.batch(stmts.map(([sql, ...p]) => D1.prepare(sql).bind(...p)));
      stats.queries += rs.length; stats.rows += rs.reduce((n, r) => n + (r.meta?.rows_read ?? 0), 0);
      return rs;
    },
  };
}

function record(env: Env, request: Request, route: string, status: number, ms: number, stats: { queries: number; rows: number }): void {
  const version = env.CF_VERSION_METADATA?.id?.slice(0, 8) ?? 'local';
  const colo = String((request as { cf?: { colo?: string } }).cf?.colo ?? '');
  try {
    env.METRICS?.writeDataPoint({
      indexes: [route],
      blobs: [route, request.method, `${Math.floor(status / 100)}xx`, version, colo],
      doubles: [ms, status, stats.queries, stats.rows],
    });
  } catch { /* metrics must never break a request */ }
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  console[level](JSON.stringify({ event: 'api', route, method: request.method, status, ms, d1Queries: stats.queries, d1Rows: stats.rows, version, colo }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const started = Date.now();
      const stats = { queries: 0, rows: 0 };
      const res = await handleApi(request, counted(env.DB, stats), {
        ip: request.headers.get('cf-connecting-ip') || 'unknown',
        admins: env.ADMIN_EMAILS || '',
        backup: (kind) => backupToKv(env, kind),
        version: env.CF_VERSION_METADATA?.id ?? 'unknown',
      });
      record(env, request, routeOf(url.pathname), res.status, Date.now() - started, stats);
      return res;
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },

  // Daily at 04:17 UTC: clean up (expired sessions, old demo accounts), then snapshot.
  async scheduled(_event, env) {
    await d1(env.DB).batch([
      ['DELETE FROM sessions WHERE expires_at < ?', Date.now()],
      ['DELETE FROM reset_tokens WHERE expires_at < ?', Date.now() - 7 * 864e5],
    ]);
    await cleanupDemos(d1(env.DB));
    await backupToKv(env, 'daily');
  },
} satisfies ExportedHandler<Env>;
