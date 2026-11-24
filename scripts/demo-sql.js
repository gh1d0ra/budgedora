// Writes a SQL file that (re)creates a demo account with ~3 years of made-up expenses,
// for loading into the live Cloudflare D1 database:
//   node scripts/demo-sql.js <email> <password> <name> <out.sql>
//   wrangler d1 execute budgedora --remote --file=<out.sql>
import fs from 'node:fs';
import { DEFAULT_BUCKETS, hashPassword } from '../src/api.js';
import { demoExpenses, DEMO_BUDGETS } from './demo-data.js';

const [email, password, name = 'Demo', out = 'demo.sql'] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/demo-sql.js <email> <password> [name] [out.sql]');
  process.exit(1);
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const U = `(SELECT id FROM users WHERE email = ${q(email)})`;
const lines = [
  `DELETE FROM expenses WHERE user_id = ${U};`,
  `DELETE FROM buckets WHERE user_id = ${U};`,
  `DELETE FROM sessions WHERE user_id = ${U};`,
  `DELETE FROM users WHERE email = ${q(email)};`,
  `INSERT INTO users (email, name, pass_hash) VALUES (${q(email)}, ${q(name)}, ${q(await hashPassword(password))});`,
  ...DEFAULT_BUCKETS.map(([n, i, c], idx) =>
    `INSERT INTO buckets (user_id, name, icon, color, sort, monthly_budget) VALUES (${U}, ${q(n)}, ${q(i)}, ${q(c)}, ${idx}, ${DEMO_BUDGETS[n] ?? 'NULL'});`),
];
// Group expenses per bucket into multi-row INSERT … SELECT statements (fast to import).
const byBucket = new Map();
for (const [b, amt, date, note] of demoExpenses()) {
  if (!byBucket.has(b)) byBucket.set(b, []);
  byBucket.get(b).push(`(${amt}, ${q(date)}, ${q(note)})`);
}
for (const [b, vals] of byBucket) {
  const B = `(SELECT id FROM buckets WHERE user_id = ${U} AND name = ${q(b)})`;
  for (let i = 0; i < vals.length; i += 200) {
    lines.push(`INSERT INTO expenses (user_id, bucket_id, amount, date, note) SELECT ${U}, ${B}, v.column1, v.column2, v.column3 FROM (VALUES ${vals.slice(i, i + 200).join(', ')}) AS v;`);
  }
}
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`Wrote ${out}: ${[...byBucket.values()].reduce((s, v) => s + v.length, 0)} expenses for ${email}`);
