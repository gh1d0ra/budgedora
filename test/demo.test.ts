// "Try the demo": a private account full of made-up data per visitor, limited, and cleaned up after a day.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { client, signedUp, freshDb } from './helpers.ts';
import { cleanupDemos, snapshot } from '../src/api.ts';
import type { Db } from '../src/api.ts';

let db: Db;
beforeEach(() => { db = freshDb(); });

test('a demo signs you in to your own account with ~3 years of made-up data', async () => {
  const call = client(db);
  const r = await call('POST', '/api/demo');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie')!, /Max-Age=86400/);
  const data = await call('GET', '/api/data');
  assert.equal(data.body.user.isDemo, true);
  assert.equal(data.body.user.isAdmin, false);
  assert.equal(data.body.buckets.length, 12);
  assert.ok(data.body.expenses.length > 1000, `only ${data.body.expenses.length} expenses`);
  const groceries = data.body.buckets.find((b: any) => b.name === 'Groceries');
  assert.equal(groceries.monthlyBudget, 900);
  assert.ok(data.body.expenses.every((e: any) => data.body.buckets.some((b: any) => b.id === e.bucketId)));
});

test('two visitors get separate demos and cannot see each other', async () => {
  const a = client(db, { ip: '10.0.0.1' }); const b = client(db, { ip: '10.0.0.2' });
  await a('POST', '/api/demo'); await b('POST', '/api/demo');
  const added = await a('POST', '/api/expenses', { amount: 12.34, date: '2026-01-02', bucketId: (await a('GET', '/api/data')).body.buckets[0].id, note: 'only in A' });
  assert.equal(added.status, 200);
  assert.ok(!JSON.stringify((await b('GET', '/api/data')).body).includes('only in A'));
  assert.equal((await b('DELETE', `/api/expenses/${added.body.id}`)).status, 404);
});

test("demo accounts can't change their password or delete themselves, and can't sign in by password", async () => {
  const call = client(db);
  await call('POST', '/api/demo');
  assert.equal((await call('PUT', '/api/me', { name: 'x', currentPassword: '', newPassword: 'hacked123' })).status, 403);
  assert.equal((await call('POST', '/api/account/delete', { confirm: 'DELETE', password: '' })).status, 403);
  const { email } = (await call('GET', '/api/me')).body;
  assert.equal((await client(db)('POST', '/api/login', { email, password: '!demo-no-password' })).status, 401);
});

test('limited per network per day', async () => {
  const call = client(db, { ip: '10.9.9.9' });
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/demo')).status, 200);
  assert.equal((await call('POST', '/api/demo')).status, 429);
  assert.equal((await client(db, { ip: '10.9.9.10' })('POST', '/api/demo')).status, 200); // other networks are fine
});

test('demo accounts are deleted after a day; real accounts are untouched', async () => {
  const real = await signedUp(db, 'real@example.test');
  await real('POST', '/api/expenses', { amount: 5, date: '2026-01-02', bucketId: (await real('GET', '/api/data')).body.buckets[0].id });
  const demo = client(db);
  await demo('POST', '/api/demo');

  await cleanupDemos(db, Date.now()); // not a day old yet
  assert.equal((await demo('GET', '/api/me')).status, 200);

  await cleanupDemos(db, Date.now() + 25 * 3600e3);
  assert.equal((await demo('GET', '/api/me')).status, 401);
  const left = await db.get<{ users: number; expenses: number; buckets: number }>(`SELECT
    (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM expenses) AS expenses, (SELECT COUNT(*) FROM buckets) AS buckets`);
  assert.deepEqual({ ...left }, { users: 1, expenses: 1, buckets: 12 });
  assert.equal((await real('GET', '/api/data')).body.expenses.length, 1);
});

test('backups and the admin list leave demo accounts out', async () => {
  await signedUp(db, 'admin@example.test');
  const demo = client(db);
  await demo('POST', '/api/demo');
  const snap = await snapshot(db);
  assert.deepEqual(snap.users.map((u) => u.email), ['admin@example.test']);
  assert.equal(snap.expenses.length, 0);
  const admin = client(db);
  await admin('POST', '/api/login', { email: 'admin@example.test', password: 'secret123' });
  const users = await admin('GET', '/api/admin/users');
  assert.deepEqual(users.body.map((u: any) => u.email), ['admin@example.test']);
});
