// Creates (or recreates) a LOCAL demo account with ~3 years of made-up expenses.
// Usage: npm run seed  [-- email password name]   (default demo@budgedora.test / demo1234)
import { db } from '../server.ts';
import { DEFAULT_BUCKETS, hashPassword } from '../src/api.ts';
import { demoExpenses, DEMO_BUDGETS } from '../src/demo.ts';

const [email = 'demo@budgedora.test', password = 'demo1234', name = 'Demo'] = process.argv.slice(2);

const old = await db.get<{ id: number }>('SELECT id FROM users WHERE email = ?', email);
if (old) {
  await db.batch([
    ['DELETE FROM expenses WHERE user_id = ?', old.id],
    ['DELETE FROM buckets WHERE user_id = ?', old.id],
    ['DELETE FROM sessions WHERE user_id = ?', old.id],
    ['DELETE FROM users WHERE id = ?', old.id],
  ]);
}
const { lastId: uid } = await db.run('INSERT INTO users (email, name, pass_hash) VALUES (?, ?, ?)', email, name, await hashPassword(password));
const ids: Record<string, number> = {};
for (const [idx, [n, i, c]] of DEFAULT_BUCKETS.entries()) {
  ids[n] = (await db.run('INSERT INTO buckets (user_id, name, icon, color, sort, monthly_budget) VALUES (?, ?, ?, ?, ?, ?)', uid, n, i, c, idx, DEMO_BUDGETS[n] ?? null)).lastId;
}
const rows = demoExpenses();
await db.batch(rows.map(([b, amt, date, note]) => ['INSERT INTO expenses (user_id, bucket_id, amount, date, note) VALUES (?, ?, ?, ?, ?)', uid, ids[b], amt, date, note]));
console.log(`Seeded ${rows.length} expenses for ${email}`);
