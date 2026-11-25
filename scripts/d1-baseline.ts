// Marks migrations as already applied in a D1 database, so `wrangler d1 migrations apply` only runs newer ones.
// Needed once for a database whose migrations were applied by hand (production before v1.4), and for any
// new database created from src/schema.sql (which already contains every migration).
//
//   node scripts/d1-baseline.ts <last-applied-migration> > baseline.sql
//   npx wrangler d1 execute budgedora --remote --file=baseline.sql
//
// Production (v1.4 rollout): node scripts/d1-baseline.ts 0004_household.sql
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'migrations');
const last = process.argv[2];
const all = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
if (!last || !all.includes(last)) {
  console.error(`Usage: node scripts/d1-baseline.ts <migration>\nOne of: ${all.join(', ')}`);
  process.exit(1);
}
const applied = all.slice(0, all.indexOf(last) + 1);
console.log(`-- Marks ${applied.length} migration(s) as applied (same table wrangler uses).
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
${applied.map((f) => `INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${f}');`).join('\n')}`);
