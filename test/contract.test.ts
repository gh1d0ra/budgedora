// Contract tests: every response the API gives must match public/openapi.json (status code, content
// type and body schema), and every documented operation must be exercised here at least once.
// Together with the generated types in src/api-types.ts this keeps the code and the published spec in step.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { handleApi } from '../src/api.ts';
import type { Db } from '../src/api.ts';
import { freshDb } from './helpers.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'openapi.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema({ $id: 'spec', components: spec.components });

/** Resolves a "#/components/..." reference inside the spec. */
const deref = (obj: any): any => (obj && obj.$ref ? deref(obj.$ref.slice(2).split('/').reduce((o: any, k: string) => o[k], spec)) : obj);
/** Points local refs at the registered spec so Ajv can follow them. */
const rebase = (schema: any): any => JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"spec#/components/'));

const operations = Object.entries<any>(spec.paths).flatMap(([template, item]) =>
  ['get', 'put', 'post', 'delete'].filter((m) => item[m]).map((m) => ({
    method: m.toUpperCase(), template, op: item[m],
    re: new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`),
  })));
const exercised = new Set<string>();

/** A client like test/helpers.ts, but every response is checked against the spec. */
function contractClient(db: Db, ip = '10.1.0.1') {
  let cookie = '';
  return async (method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const res = await handleApi(new Request(`http://localhost${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), db, { ip, admins: 'admin@example.test', backup: async () => ({ key: 'manual/x.json.gz', users: 1, expenses: 0, bytes: 10, takenAt: new Date().toISOString() }) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];

    const pathname = new URL(url, 'http://localhost').pathname;
    const match = operations.find((o) => o.method === method && o.re.test(pathname));
    assert.ok(match, `${method} ${pathname} is not in openapi.json (status ${res.status})`);
    const response = deref(match.op.responses[String(res.status)]);
    assert.ok(response, `${method} ${match.template} answered ${res.status}, which openapi.json doesn't list`);
    const [type, media] = Object.entries<any>(response.content)[0];
    assert.ok((res.headers.get('content-type') || '').startsWith(type), `${method} ${match.template}: content type ${res.headers.get('content-type')}, spec says ${type}`);
    const text = await res.text();
    const data: any = type === 'application/json' ? JSON.parse(text) : text;
    const validate = ajv.compile(rebase(media.schema));
    assert.ok(validate(data), `${method} ${match.template} ${res.status} doesn't match the spec: ${ajv.errorsText(validate.errors)}\n${text.slice(0, 300)}`);
    if (res.status < 300) exercised.add(`${method} ${match.template}`);
    return { status: res.status, body: data };
  };
}

let db: Db;
before(() => { db = freshDb(); });

test('every response matches openapi.json, across a full session', async () => {
  const anon = contractClient(db);
  assert.equal((await anon('GET', '/api/health')).body.ok, true);
  assert.equal((await anon('GET', '/api/me')).status, 401);
  assert.equal((await anon('POST', '/api/signup', { email: 'bad', password: 'secret123' })).status, 400);

  const admin = contractClient(db);
  assert.equal((await admin('POST', '/api/signup', { email: 'admin@example.test', password: 'secret123', name: 'Admin' })).status, 200);
  const ana = contractClient(db, '10.1.0.2');
  await ana('POST', '/api/signup', { email: 'ana@example.test', password: 'secret123' });
  await ana('POST', '/api/logout');
  assert.equal((await ana('POST', '/api/login', { email: 'ana@example.test', password: 'nope' })).status, 401);
  await ana('POST', '/api/login', { email: 'ana@example.test', password: 'secret123' });

  await ana('GET', '/api/me');
  await ana('PUT', '/api/me', { name: 'Ana', currency: 'EUR' });
  const data = (await ana('GET', '/api/data')).body;
  const groceries = data.buckets[0].id;

  const bucket = (await ana('POST', '/api/buckets', { name: 'Pets', icon: '🐾', color: '#123456', monthlyBudget: 50 })).body;
  await ana('PUT', `/api/buckets/${bucket.id}`, { monthlyBudget: null });
  await ana('PUT', '/api/buckets/order', { ids: [bucket.id, groceries] });
  assert.equal((await ana('PUT', '/api/buckets/999999', { name: 'x' })).status, 404);

  const e = (await ana('POST', '/api/expenses', { amount: 12.5, date: '2026-03-04', bucketId: groceries, note: 'Aldi' })).body;
  assert.equal((await ana('POST', '/api/expenses', { amount: 0, date: '2026-03-04', bucketId: groceries })).status, 400);
  await ana('PUT', `/api/expenses/${e.id}`, { amount: -3 });
  await ana('POST', '/api/expenses/import', { rows: [{ date: '2026-03-05', bucket: 'Groceries', amount: 9 }, { date: 'bad' }] });
  await ana('PUT', '/api/budgets', { month: '2026-03', items: [{ bucketId: groceries, amount: 400 }] });
  await ana('GET', '/api/export.csv');
  await ana('DELETE', `/api/expenses/${e.id}`);
  await ana('POST', '/api/expenses', { amount: 1, date: '2026-03-04', bucketId: bucket.id });
  assert.deepEqual((await ana('DELETE', `/api/buckets/${bucket.id}`)).body, { archived: true });
  const empty = (await ana('POST', '/api/buckets', { name: 'Empty' })).body;
  assert.deepEqual((await ana('DELETE', `/api/buckets/${empty.id}`)).body, { deleted: true });

  assert.equal((await ana('GET', '/api/admin/users')).status, 403);
  const users = (await admin('GET', '/api/admin/users')).body;
  const anaId = users.find((u: any) => u.email === 'ana@example.test').id;
  await admin('POST', '/api/admin/backup');
  await admin('POST', `/api/admin/users/${anaId}/unlock`);
  const { link } = (await admin('POST', `/api/admin/users/${anaId}/reset-link`)).body;
  await contractClient(db, '10.1.0.3')('POST', '/api/reset', { token: link.split('#reset=')[1], password: 'newpass123' });

  const fresh = contractClient(db, '10.1.0.4');
  await fresh('POST', '/api/login', { email: 'ana@example.test', password: 'newpass123' });
  await fresh('POST', '/api/account/delete', { confirm: 'DELETE', password: 'newpass123' });
  await admin('POST', `/api/admin/users/${anaId}/restore`);

  const demo = contractClient(db, '10.1.0.5');
  await demo('POST', '/api/demo');
  assert.equal((await demo('PUT', '/api/me', { newPassword: 'x23456', currentPassword: '' })).status, 403);
  await demo('GET', '/api/data');
});

test('every operation in openapi.json was exercised with a successful response', () => {
  const documented = operations.map((o) => `${o.method} ${o.template}`);
  const missing = documented.filter((k) => !exercised.has(k));
  assert.deepEqual(missing, [], `not covered: ${missing.join(', ')}`);
});

test('the checker itself rejects responses that drift from the spec', () => {
  const expense = ajv.compile(rebase(spec.components.schemas.Expense));
  assert.ok(expense({ id: 1, bucketId: 2, amount: 3.5, date: '2026-01-02', note: '' }));
  assert.ok(!expense({ id: 1, bucketId: 2, amount: '3.50', date: '2026-01-02', note: '' }), 'amount as a string');
  assert.ok(!expense({ id: 1, bucketId: 2, amount: 3.5, date: '2026-01-02' }), 'missing note');
  assert.ok(!expense({ id: 1, bucketId: 2, amount: 3.5, date: '2026-01-02', note: '', user_id: 7 }), 'leaks an extra field');
  const data = ajv.compile(rebase(spec.components.schemas.Data));
  assert.ok(!data({ user: {}, buckets: [], expenses: [], budgets: [] }), 'nested $ref is checked too');
});
