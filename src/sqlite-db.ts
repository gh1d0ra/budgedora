// SQLite implementation of the API's Db adapter, on Node's built-in node:sqlite.
// Used by the local server (a file) and by the tests (':memory:'). Production uses D1 (src/worker.ts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './api.ts';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Opens (or creates) a database, applies the schema and every migration, and wraps it as a Db. */
export function openSqlite(file: string): { sqlite: DatabaseSync; db: Db } {
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  sqlite.exec(fs.readFileSync(path.join(SRC_DIR, 'schema.sql'), 'utf8'));
  // Apply migrations to older databases (each statement is safe to retry).
  for (const f of fs.readdirSync(path.join(SRC_DIR, 'migrations')).sort()) {
    for (const stmt of fs.readFileSync(path.join(SRC_DIR, 'migrations', f), 'utf8').replace(/--.*$/gm, '').split(';')) {
      if (!stmt.trim()) continue;
      try { sqlite.exec(stmt); } catch (e) { if (!/duplicate column/i.test((e as Error).message)) throw e; }
    }
  }

  const db: Db = {
    all: async (sql, ...p) => sqlite.prepare(sql).all(...p) as any[],
    get: async (sql, ...p) => (sqlite.prepare(sql).get(...p) as any) ?? null,
    run: async (sql, ...p) => {
      const r = sqlite.prepare(sql).run(...p);
      return { lastId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    // All-or-nothing, like D1's batch.
    batch: async (stmts) => {
      sqlite.exec('BEGIN');
      try { stmts.forEach(([sql, ...p]) => sqlite.prepare(sql).run(...p)); sqlite.exec('COMMIT'); }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
  return { sqlite, db };
}
