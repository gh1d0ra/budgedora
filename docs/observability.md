# Observability

## What is recorded

Every API request produces two records, written by `src/worker.ts`.

**A data point in Workers Analytics Engine** (dataset `budgedora_requests`):

| Field | Value |
|---|---|
| `index1`, `blob1` | Route, with ids folded (`/api/expenses/:id`) |
| `blob2` | Method |
| `blob3` | Status class (`2xx`, `4xx`, `5xx`) |
| `blob4` | Worker version (first 8 characters, so canary and stable can be compared) |
| `blob5` | Cloudflare data center |
| `double1` | Duration in ms |
| `double2` | Status code |
| `double3` | D1 queries in the request |
| `double4` | D1 rows read |

**A structured log line in Workers Logs** (`[observability] enabled = true`), for example:
`{"event":"api","route":"/api/data","status":200,"ms":27,"d1Queries":4,"d1Rows":1265,"version":"666f4df7","colo":"ATL"}`.
Server errors log at `error` level and client errors at `warn`, so the dashboard can filter by level.

The D1 counts make cost visible per route. That is how the demo's ~17,000 rows read per account was found, and why
there is a daily cap on demos (`DEMO_PER_DAY` in `src/api.ts`).

## Targets

| Objective | Target | Measured as |
|---|---|---|
| Availability | **99.5%** of API requests are not 5xx | `1 − Σ 5xx / Σ requests` over 24 h |
| Latency | **p95 ≤ 300 ms** for every route | Weighted p95 of `double1` per route; bulk routes (`/api/demo`, `/api/expenses/import`) excluded |

```sh
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/metrics.ts 24
```

This prints a table per route and exits with status 1 if a target was missed. The token needs "Account Analytics: Read".

## Useful queries (Analytics Engine SQL API)

```sql
-- Canary vs stable during a release
SELECT blob4 AS version, SUM(_sample_interval) AS requests,
       SUM(IF(blob3 = '5xx', _sample_interval, 0)) AS errors,
       quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms
FROM budgedora_requests WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY version

-- Most expensive routes by rows read
SELECT blob1 AS route, SUM(double4 * _sample_interval) AS rows_read
FROM budgedora_requests WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY route ORDER BY rows_read DESC
```

## Health

`GET /api/health` checks that the database answers and that the schema has the columns the code needs. It also reports
the running version id. The release script uses it before and during a canary (see [release.md](release.md)).

## Load test

`load/api.k6.js` (k6) runs 25 people at once for a minute against a **local** server (`node server.ts`). Each signs up,
then loads their data, adds expenses and edits some. Last run (Windows laptop, Node 24, `node:sqlite`): 2,957 requests,
0 failures, and p95 of 8.8 ms (`/api/data`), 8.7 ms (add) and 7.7 ms (edit). That's well inside the 300 ms target, which
is set for D1 over the network rather than local SQLite. Never point it at production: it creates accounts.
