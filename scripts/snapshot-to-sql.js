// Turns a daily/monthly KV snapshot (.json.gz or .json) into SQL that restores it.
//   wrangler kv key get --binding BACKUPS "daily/2026-11-24.json.gz" --remote > snap.json.gz
//   node scripts/snapshot-to-sql.js snap.json.gz restore.sql [--user someone@example.com]
//   wrangler d1 execute budgedora --remote --file=restore.sql
// Rows are upserted (INSERT OR REPLACE), so restoring never deletes newer data.
// With --user, only that account's rows are restored.
import fs from 'node:fs';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const [input, out = 'restore.sql'] = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--user');
const only = args.includes('--user') ? args[args.indexOf('--user') + 1].toLowerCase() : null;
if (!input) { console.error('Usage: node scripts/snapshot-to-sql.js <snapshot.json[.gz]> [out.sql] [--user email]'); process.exit(1); }

let raw = fs.readFileSync(input);
if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
const snap = JSON.parse(raw.toString('utf8'));

const users = only ? snap.users.filter((u) => u.email.toLowerCase() === only) : snap.users;
if (!users.length) { console.error('No matching users in snapshot.'); process.exit(1); }
const ids = new Set(users.map((u) => u.id));
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const insert = (table, rows) => rows.map((r) => {
  const cols = Object.keys(r);
  return `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => q(r[c])).join(', ')});`;
});
const lines = [
  ...insert('users', users),
  ...insert('buckets', snap.buckets.filter((b) => ids.has(b.user_id))),
  ...insert('expenses', snap.expenses.filter((e) => ids.has(e.user_id))),
];
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`Snapshot ${snap.takenAt}: wrote ${lines.length} statements for ${users.length} user(s) to ${out}`);
