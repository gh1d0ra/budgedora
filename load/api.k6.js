// Load test for the Budgedora API: many family members signing in, opening the app and logging expenses.
// Runs against a LOCAL server; never point it at production (it creates accounts).
//
//   PORT=3999 DATA_DIR=$(mktemp -d) node server.ts &
//   k6 run -e BASE_URL=http://localhost:3999 load/api.k6.js
//
// Results are summarized in docs/observability.md.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3999';
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };
const added = new Counter('expenses_added');

export const options = {
  noCookiesReset: true, // each virtual user stays signed in across iterations, like a real browser
  scenarios: {
    family: {
      executor: 'ramping-vus',
      stages: [
        { duration: '10s', target: 25 }, // 25 people at once (sign-ups are limited to 30 per IP per 15 min)
        { duration: '40s', target: 25 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:data}': ['p(95)<300'],
    'http_req_duration{name:add}': ['p(95)<150'],
    'http_req_duration{name:edit}': ['p(95)<150'],
    checks: ['rate>0.99'],
  },
};

const BUCKET = {};
export default function () {
  if (__ITER === 0) {
    const r = http.post(`${BASE}/api/signup`, JSON.stringify({ email: `vu${__VU}-${Date.now()}@load.test`, password: 'load-test-1', name: `VU ${__VU}` }), { ...JSON_HEADERS, tags: { name: 'signup' } });
    check(r, { 'signed up': (x) => x.status === 200 });
  }

  const data = http.get(`${BASE}/api/data`, { tags: { name: 'data' } });
  check(data, { 'data loads': (x) => x.status === 200 });
  if (data.status !== 200) { sleep(1); return; }
  BUCKET[__VU] ??= data.json('buckets.0.id');

  const day = `2026-${String(1 + (__ITER % 12)).padStart(2, '0')}-${String(1 + (__ITER % 28)).padStart(2, '0')}`;
  const add = http.post(`${BASE}/api/expenses`, JSON.stringify({ amount: (10 + (__ITER % 90)).toFixed(2), date: day, bucketId: BUCKET[__VU], note: 'k6' }), { ...JSON_HEADERS, tags: { name: 'add' } });
  if (check(add, { 'expense added': (x) => x.status === 200 })) added.add(1);

  if (add.status === 200 && __ITER % 3 === 0) {
    const edit = http.put(`${BASE}/api/expenses/${add.json('id')}`, JSON.stringify({ note: 'k6 edited' }), { ...JSON_HEADERS, tags: { name: 'edit' } });
    check(edit, { 'expense edited': (x) => x.status === 200 });
  }
  sleep(0.5 + Math.random());
}
