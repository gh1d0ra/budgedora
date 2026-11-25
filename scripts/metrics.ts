// Request metrics from Workers Analytics Engine (written by src/worker.ts), checked against the targets in
// docs/observability.md.
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/metrics.ts [hours=24]
//
// The token needs "Account Analytics: Read". Exits 1 if a target is missed, so it can run on a schedule.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const hours = Number(process.argv[2] || 24);
if (!account || !token) { console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.'); process.exit(1); }

export const TARGETS = { availability: 0.995, p95Ms: 300 }; // also in docs/observability.md

async function sql<T>(query: string): Promise<T[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: query,
  });
  if (!res.ok) throw new Error(`Analytics Engine answered ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { data: T[] }).data;
}

// _sample_interval: Analytics Engine may sample at high volume; weighting by it gives true counts.
const window = `timestamp > NOW() - INTERVAL '${hours}' HOUR`;
type Row = { route: string; requests: number; errors: number; p50: number; p95: number; queries: number; rows: number };
const rows = await sql<Row>(`
  SELECT blob1 AS route,
         SUM(_sample_interval) AS requests,
         SUM(IF(blob3 = '5xx', _sample_interval, 0)) AS errors,
         quantileExactWeighted(0.5)(double1, _sample_interval) AS p50,
         quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,
         SUM(double3 * _sample_interval) / SUM(_sample_interval) AS queries,
         SUM(double4 * _sample_interval) / SUM(_sample_interval) AS rows
  FROM budgedora_requests WHERE ${window}
  GROUP BY route ORDER BY requests DESC
  FORMAT JSON`);

const total = rows.reduce((n, r) => n + Number(r.requests), 0);
const errors = rows.reduce((n, r) => n + Number(r.errors), 0);
const availability = total ? 1 - errors / total : 1;
const worstP95 = Math.max(0, ...rows.filter((r) => r.route !== '/api/demo' && r.route !== '/api/expenses/import').map((r) => Number(r.p95)));

console.log(`Last ${hours} h: ${total} API requests, ${errors} server errors\n`);
console.table(rows.map((r) => ({
  route: r.route, requests: Number(r.requests), '5xx': Number(r.errors),
  'p50 ms': Math.round(r.p50), 'p95 ms': Math.round(r.p95), 'D1 queries': Number(r.queries).toFixed(1), 'D1 rows': Math.round(r.rows),
})));
const ok = availability >= TARGETS.availability && worstP95 <= TARGETS.p95Ms;
console.log(`availability ${(availability * 100).toFixed(2)}% (target ${TARGETS.availability * 100}%) · worst p95 ${Math.round(worstP95)} ms (target ${TARGETS.p95Ms} ms) → ${ok ? 'OK' : 'MISSED'}`);
process.exit(ok ? 0 : 1);
