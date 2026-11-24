// Cloudflare Worker entry: /api/* → shared API on D1, everything else → static assets in /public.
import { handleApi } from './api.js';

const d1 = (D1) => ({
  all: async (sql, ...p) => (await D1.prepare(sql).bind(...p).all()).results,
  get: async (sql, ...p) => (await D1.prepare(sql).bind(...p).first()) ?? null,
  run: async (sql, ...p) => {
    const r = await D1.prepare(sql).bind(...p).run();
    return { lastId: r.meta.last_row_id, changes: r.meta.changes };
  },
  batch: async (stmts) => (stmts.length ? D1.batch(stmts.map(([sql, ...p]) => D1.prepare(sql).bind(...p))) : []),
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, d1(env.DB), { ip: request.headers.get('cf-connecting-ip') || 'unknown' });
    }
    return env.ASSETS.fetch(request);
  },

  // Daily cleanup of expired sessions.
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  },
};
