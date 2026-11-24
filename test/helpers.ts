// Shared test helpers. Tests run with Node's built-in runner: `npm test`.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { handleApi } from '../src/api.ts';
import type { Db } from '../src/api.ts';
import { openSqlite } from '../src/sqlite-db.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const fixture = (name: string): string => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8');

/**
 * Loads a browser script from public/ (they attach themselves to `window`) into this realm,
 * so Dates and arrays it returns are ordinary objects here.
 */
export function loadBrowserScript<T = any>(file: string, globalName: string): T {
  const g = globalThis as any;
  g.window ??= g;
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'), { filename: file });
  return g[globalName];
}

/** A fresh, empty in-memory database with the real schema and migrations. */
export const freshDb = (): Db => openSqlite(':memory:').db;

export interface ApiResult { status: number; body: any; headers: Headers }

/**
 * A tiny API client with its own cookie jar, calling handleApi directly (no HTTP server needed).
 * Every client is a separate "browser"; `ip` lets tests act like different networks.
 */
export function client(db: Db, { ip = '10.0.0.1', admins = 'admin@example.test' } = {}) {
  let cookie = '';
  return async function call(method: string, url: string, body?: unknown): Promise<ApiResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const req = new Request(`http://localhost${url}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handleApi(req, db, { ip, admins });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* CSV and other text */ }
    return { status: res.status, body: parsed, headers: res.headers };
  };
}

/** Signs up a new account and returns its client. */
export async function signedUp(db: Db, email: string, password = 'secret123', opts = {}) {
  const call = client(db, opts);
  const r = await call('POST', '/api/signup', { email, password, name: email.split('@')[0] });
  if (r.status !== 200) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
  return call;
}
