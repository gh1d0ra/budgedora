// Cloudflare Worker entry: /api/* → shared API on D1, everything else → static assets in /public.
import { handleApi, snapshot, SECURITY_HEADERS } from './api.js';

const d1 = (D1) => ({
  all: async (sql, ...p) => (await D1.prepare(sql).bind(...p).all()).results,
  get: async (sql, ...p) => (await D1.prepare(sql).bind(...p).first()) ?? null,
  run: async (sql, ...p) => {
    const r = await D1.prepare(sql).bind(...p).run();
    return { lastId: r.meta.last_row_id, changes: r.meta.changes };
  },
  batch: async (stmts) => (stmts.length ? D1.batch(stmts.map(([sql, ...p]) => D1.prepare(sql).bind(...p))) : []),
});

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * Stores a compressed snapshot in KV.
 *   daily/YYYY-MM-DD.json.gz            kept 35 days
 *   monthly/YYYY-MM.json.gz             kept forever (written on the 1st)
 *   manual/YYYY-MM-DDTHH-MM-SS.json.gz  kept 180 days ("Back up now")
 */
async function backupToKv(env, kind) {
  if (!env.BACKUPS) throw new Error('KV binding BACKUPS missing');
  const snap = await snapshot(d1(env.DB));
  const body = await gzip(JSON.stringify(snap));
  const meta = { metadata: { users: snap.users.length, expenses: snap.expenses.length, takenAt: snap.takenAt } };
  const day = snap.takenAt.slice(0, 10);
  let key;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, d1(env.DB), {
        ip: request.headers.get('cf-connecting-ip') || 'unknown',
        admins: env.ADMIN_EMAILS || '',
        backup: (kind) => backupToKv(env, kind),
      });
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },

  // Daily at 04:17 UTC: clean up, then snapshot.
  async scheduled(_event, env) {
    await d1(env.DB).batch([
      ['DELETE FROM sessions WHERE expires_at < ?', Date.now()],
      ['DELETE FROM reset_tokens WHERE expires_at < ?', Date.now() - 7 * 864e5],
    ]);
    await backupToKv(env, 'daily');
  },
};
