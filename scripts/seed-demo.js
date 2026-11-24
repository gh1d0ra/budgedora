// Creates (or recreates) a LOCAL demo account with ~3 years of made-up expenses.
// Usage: npm run seed  [-- email password name]   (default demo@budgedora.test / demo1234)
import { db } from '../server.js';
import { DEFAULT_BUCKETS, hashPassword } from '../src/api.js';
import { demoExpenses, DEMO_BUDGETS } from './demo-data.js';

const [email = 'demo@budgedora.test', password = 'demo1234', name = 'Demo'] = process.argv.slice(2);

const old = await db.get('SELECT id FROM users WHERE email = ?', email);
if (old) {
  await db.batch([
    ['DELETE FROM expenses WHERE user_id = ?', old.id],
    ['DELETE FROM buckets WHERE user_id = ?', old.id],
    ['DELETE FROM sessions WHERE user_id = ?', old.id],
    ['DELETE FROM users WHERE id = ?', old.id],
  ]);
}
const { lastId: uid } = await db.run('INSERT INTO users (email, name, pass_hash) VALUES (?, ?, ?)', email, name, await hashPassword(password));
const ids = {};
for (const [idx, [n, i, c]] of DEFAULT_BUCKETS.entries()) {
  ids[n] = (await db.run('INSERT INTO buckets (user_id, name, icon, color, sort, monthly_budget) VALUES (?, ?, ?, ?, ?, ?)', uid, n, i, c, idx, DEMO_BUDGETS[n] ?? null)).lastId;
}
const rows = demoExpenses();
await db.batch(rows.map(([b, amt, date, note]) => ['INSERT INTO expenses (user_id, bucket_id, amount, date, note) VALUES (?, ?, ?, ?, ?)', uid, ids[b], amt, date, note]));
console.log(`Seeded ${rows.length} expenses for ${email}`);
