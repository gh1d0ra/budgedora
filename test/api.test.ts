// The JSON API (src/api.ts) against a real SQLite database in memory: accounts, security, data isolation, CRUD.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { client, signedUp, freshDb } from './helpers.ts';
import { snapshot } from '../src/api.ts';
import type { Db } from '../src/api.ts';

let db: Db;
beforeEach(() => { db = freshDb(); });

describe('accounts and sessions', () => {
  test('sign up creates the default buckets and signs you in', async () => {
    const call = await signedUp(db, 'ana@example.test');
    const me = await call('GET', '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.email, 'ana@example.test');
    const data = await call('GET', '/api/data');
    assert.equal(data.body.buckets.length, 12);
    assert.equal(data.body.buckets[0].name, 'Groceries');
  });

  test('sign-up validation', async () => {
    const call = client(db);
    assert.equal((await call('POST', '/api/signup', { email: 'not-an-email', password: 'secret123' })).status, 400);
    assert.equal((await call('POST', '/api/signup', { email: 'a@example.test', password: '123' })).status, 400);
    await signedUp(db, 'taken@example.test');
    const dup = await client(db)('POST', '/api/signup', { email: 'TAKEN@example.test', password: 'secret123' });
    assert.equal(dup.status, 409);
  });

  test('session cookie is HttpOnly and SameSite', async () => {
    const r = await client(db)('POST', '/api/signup', { email: 'c@example.test', password: 'secret123' });
    const cookie = r.headers.get('set-cookie')!;
    assert.match(cookie, /^sid=[0-9a-f]{64};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  test('log out ends the session', async () => {
    const call = await signedUp(db, 'out@example.test');
    await call('POST', '/api/logout', {});
    assert.equal((await call('GET', '/api/me')).status, 401);
  });

  test('changing the password signs out other devices but keeps this one', async () => {
    const phone = await signedUp(db, 'pw@example.test');
    const laptop = client(db);
    await laptop('POST', '/api/login', { email: 'pw@example.test', password: 'secret123' });
    const r = await phone('PUT', '/api/me', { currentPassword: 'secret123', newPassword: 'newsecret1' });
    assert.equal(r.status, 200);
    assert.equal((await phone('GET', '/api/me')).status, 200);
    assert.equal((await laptop('GET', '/api/me')).status, 401);
    assert.equal((await client(db)('POST', '/api/login', { email: 'pw@example.test', password: 'newsecret1' })).status, 200);
  });
});

describe('security', () => {
  test('every response carries the security headers', async () => {
    const r = await client(db)('GET', '/api/me');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  test('state-changing requests must be JSON (CSRF guard)', async () => {
    const req = new Request('http://localhost/api/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    const { handleApi } = await import('../src/api.ts');
    assert.equal((await handleApi(req, db)).status, 415);
  });

  test('5 wrong passwords lock the account, with a warning before', async () => {
    await signedUp(db, 'lock@example.test');
    const call = client(db);
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push(await call('POST', '/api/login', { email: 'lock@example.test', password: 'wrong' }));
    assert.deepEqual(tries.map((t) => t.status), [401, 401, 401, 401, 423]);
    assert.match(tries[3].body.error, /1 attempt\(s\) left/);
    // even the right password is refused while locked
    assert.equal((await call('POST', '/api/login', { email: 'lock@example.test', password: 'secret123' })).status, 423);
  });

  test('an unknown email gets the same answer as a wrong password', async () => {
    const r = await client(db)('POST', '/api/login', { email: 'nobody@example.test', password: 'x' });
    assert.deepEqual([r.status, r.body.error], [401, 'Wrong email or password.']);
  });

  test('one network is limited to 30 sign-in attempts per 15 minutes', async () => {
    const call = client(db, { ip: '203.0.113.9' });
    let last;
    for (let i = 0; i < 31; i++) last = await call('POST', '/api/login', { email: `x${i}@example.test`, password: 'x' });
    assert.equal(last!.status, 429);
    // another network is unaffected
    assert.equal((await client(db, { ip: '198.51.100.1' })('POST', '/api/login', { email: 'x@example.test', password: 'x' })).status, 401);
  });
});

describe('expenses, buckets and budgets', () => {
  const groceries = async (call: Awaited<ReturnType<typeof signedUp>>) =>
    (await call('GET', '/api/data')).body.buckets.find((b: any) => b.name === 'Groceries').id;

  test('add, edit and delete an expense', async () => {
    const call = await signedUp(db, 'e@example.test');
    const bucketId = await groceries(call);
    const add = await call('POST', '/api/expenses', { amount: 45.2, date: '2026-11-20', bucketId, note: 'Costco' });
    assert.equal(add.status, 200);
    assert.deepEqual({ ...add.body, id: 0 }, { id: 0, bucketId, amount: 45.2, date: '2026-11-20', note: 'Costco' });
    const edit = await call('PUT', `/api/expenses/${add.body.id}`, { amount: -10 }); // a refund
    assert.equal(edit.body.amount, -10);
    assert.equal((await call('DELETE', `/api/expenses/${add.body.id}`)).body.deleted, true);
    assert.equal((await call('GET', '/api/data')).body.expenses.length, 0);
  });

  test('rejects bad amounts and dates', async () => {
    const call = await signedUp(db, 'v@example.test');
    const bucketId = await groceries(call);
    assert.equal((await call('POST', '/api/expenses', { amount: 0, date: '2026-11-20', bucketId })).status, 400);
    assert.equal((await call('POST', '/api/expenses', { amount: 5, date: '2026-13-45', bucketId })).status, 400);
    assert.equal((await call('POST', '/api/expenses', { amount: 5, date: '20/11/2026', bucketId })).status, 400);
  });

  test("accounts can't see or touch each other's data", async () => {
    const ana = await signedUp(db, 'ana@example.test');
    const bob = await signedUp(db, 'bob@example.test');
    const anaBucket = await groceries(ana);
    const exp = (await ana('POST', '/api/expenses', { amount: 9, date: '2026-11-20', bucketId: anaBucket, note: 'private' })).body;
    assert.equal((await bob('GET', '/api/data')).body.expenses.length, 0);
    assert.equal((await bob('PUT', `/api/expenses/${exp.id}`, { amount: 1 })).status, 404);
    assert.equal((await bob('DELETE', `/api/expenses/${exp.id}`)).status, 404);
    assert.equal((await bob('POST', '/api/expenses', { amount: 1, date: '2026-11-20', bucketId: anaBucket })).status, 400);
    assert.equal((await bob('PUT', `/api/buckets/${anaBucket}`, { name: 'Hacked' })).status, 404);
    assert.equal((await ana('GET', '/api/data')).body.expenses[0].amount, 9);
  });

  test('bulk import creates missing buckets and skips bad rows', async () => {
    const call = await signedUp(db, 'imp@example.test');
    const r = await call('POST', '/api/expenses/import', { rows: [
      { date: '2026-11-01', bucket: 'groceries', amount: 10, note: 'matches case-insensitively' },
      { date: '2026-11-02', bucket: 'Pets', amount: 25.5, note: 'new bucket' },
      { date: 'nope', bucket: 'Pets', amount: 1 },
      { date: '2026-11-03', bucket: 'Pets', amount: 0 },
    ] });
    assert.deepEqual(r.body, { added: 2, skipped: 2 });
    const data = (await call('GET', '/api/data')).body;
    assert.equal(data.buckets.length, 13);
    assert.ok(data.buckets.some((b: any) => b.name === 'Pets'));
  });

  test('deleting a bucket that has expenses archives it instead', async () => {
    const call = await signedUp(db, 'arch@example.test');
    const bucketId = await groceries(call);
    await call('POST', '/api/expenses', { amount: 5, date: '2026-11-20', bucketId });
    assert.deepEqual((await call('DELETE', `/api/buckets/${bucketId}`)).body, { archived: true });
    const empty = (await call('POST', '/api/buckets', { name: 'Temp', color: '#123456' })).body;
    assert.deepEqual((await call('DELETE', `/api/buckets/${empty.id}`)).body, { deleted: true });
  });

  test('month plan: set, override and clear expected amounts', async () => {
    const call = await signedUp(db, 'plan@example.test');
    const bucketId = await groceries(call);
    const set = await call('PUT', '/api/budgets', { month: '2026-07', items: [{ bucketId, amount: 900 }] });
    assert.deepEqual(set.body, [{ bucketId, month: '2026-07', amount: 900 }]);
    const cleared = await call('PUT', '/api/budgets', { month: '2026-07', items: [{ bucketId, amount: null }] });
    assert.deepEqual(cleared.body, []);
    assert.equal((await call('PUT', '/api/budgets', { month: '2026-13', items: [{ bucketId, amount: 1 }] })).status, 400);
    assert.equal((await call('PUT', '/api/budgets', { month: '2026-07', items: [{ bucketId, amount: -5 }] })).status, 400);
  });

  test('CSV export quotes text safely', async () => {
    const call = await signedUp(db, 'csv@example.test');
    const bucketId = await groceries(call);
    await call('POST', '/api/expenses', { amount: 12.5, date: '2026-11-20', bucketId, note: 'Say "hi", ok' });
    const r = await call('GET', '/api/export.csv');
    assert.match(r.headers.get('content-type')!, /text\/csv/);
    assert.equal(r.body, 'date,bucket,amount,note\n2026-11-20,"Groceries",12.50,"Say ""hi"", ok"');
  });
});

describe('family admin', () => {
  test('only admins see the admin endpoints', async () => {
    const user = await signedUp(db, 'user@example.test');
    assert.equal((await user('GET', '/api/admin/users')).status, 403);
  });

  test('reset link → new password → old sessions signed out; link works once', async () => {
    const admin = await signedUp(db, 'admin@example.test');
    const user = await signedUp(db, 'forgot@example.test');
    const users = (await admin('GET', '/api/admin/users')).body;
    const target = users.find((u: any) => u.email === 'forgot@example.test');
    assert.equal(users.find((u: any) => u.email === 'admin@example.test').isAdmin, true);
    const { link } = (await admin('POST', `/api/admin/users/${target.id}/reset-link`, {})).body;
    const token = link.split('#reset=')[1];
    const reset = await client(db)('POST', '/api/reset', { token, password: 'brandnew1' });
    assert.deepEqual([reset.status, reset.body.email], [200, 'forgot@example.test']);
    assert.equal((await user('GET', '/api/me')).status, 401);
    assert.equal((await client(db)('POST', '/api/reset', { token, password: 'again123' })).status, 400);
  });

  test('deleted accounts keep their data and can be restored', async () => {
    const admin = await signedUp(db, 'admin@example.test');
    const user = await signedUp(db, 'leaving@example.test');
    const bucketId = (await user('GET', '/api/data')).body.buckets[0].id;
    await user('POST', '/api/expenses', { amount: 7, date: '2026-11-20', bucketId });
    assert.equal((await user('POST', '/api/account/delete', { confirm: 'DELETE', password: 'secret123' })).status, 200);
    const login = () => client(db)('POST', '/api/login', { email: 'leaving@example.test', password: 'secret123' });
    assert.equal((await login()).status, 403);
    const id = (await admin('GET', '/api/admin/users')).body.find((u: any) => u.email === 'leaving@example.test').id;
    await admin('POST', `/api/admin/users/${id}/restore`, {});
    const back = client(db);
    await back('POST', '/api/login', { email: 'leaving@example.test', password: 'secret123' });
    assert.equal((await back('GET', '/api/data')).body.expenses.length, 1);
  });
});

test('snapshot contains everything needed to restore, but no sessions', async () => {
  const call = await signedUp(db, 'snap@example.test');
  const bucketId = (await call('GET', '/api/data')).body.buckets[0].id;
  await call('POST', '/api/expenses', { amount: 3, date: '2026-11-20', bucketId });
  const snap = await snapshot(db);
  assert.equal(snap.version, 3);
  assert.deepEqual([snap.users.length, snap.buckets.length, snap.expenses.length], [1, 12, 1]);
  assert.equal('sessions' in snap, false);
});
