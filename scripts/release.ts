// Gradual, self-checking production release (run by CI on every push to main; can be run by hand too).
//
//   node scripts/release.ts [--message "…"] [--canary-percent 10] [--watch-seconds 120] [--dry-run]
//
// 1. Apply D1 migrations (additive only, so the version still serving traffic keeps working).
// 2. Upload the new version without sending it any traffic.
// 3. Smoke-test that exact version at its own preview URL: health, schema, pages, security headers, auth.
// 4. Send it a small share of traffic; keep checking it and the live site for a while.
// 5. Promote it to 100%. If any check fails after step 4, roll back to the previous version.
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (CI secrets), or `wrangler login`.
import { execFileSync } from 'node:child_process';

const BASE_URL = process.env.RELEASE_URL || 'https://budgedora.igorrash.workers.dev';
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const message = opt('--message', process.env.GITHUB_SHA ? `CI ${process.env.GITHUB_SHA.slice(0, 7)}` : 'manual release');
const canary = Number(opt('--canary-percent', '10'));
const watchSeconds = Number(opt('--watch-seconds', '120'));
const dryRun = args.includes('--dry-run');

const log = (msg: string): void => console.log(`[release] ${msg}`);
function wrangler(...a: string[]): string {
  log(`wrangler ${a.join(' ')}`);
  if (dryRun && !['deployments'].includes(a[0])) return '';
  return execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'wrangler@4', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });
}

/** Each version has its own preview URL (preview_urls = true), so it can be checked while it has 0% of traffic. */
const versionUrls = new Map<string, string>();
async function hit(version: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${versionUrls.get(version) ?? BASE_URL}${path}`, { ...init, redirect: 'manual' });
}

/** Throws with a clear message if the version isn't healthy. */
async function smoke(version: string): Promise<void> {
  const health = await hit(version, '/api/health');
  const body = await health.json().catch(() => null) as { ok?: boolean; version?: string } | null;
  if (health.status !== 200 || !body?.ok) throw new Error(`/api/health answered ${health.status}`);
  if (body.version !== version) throw new Error(`/api/health is served by ${body.version}, expected ${version}`);
  const page = await hit(version, '/');
  if (page.status !== 200 || !(await page.text()).includes('Budgedora')) throw new Error(`/ answered ${page.status}`);
  if (!page.headers.get('content-security-policy')) throw new Error('security headers are missing');
  const login = await hit(version, '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'release-check@example.invalid', password: 'x' }) });
  if (login.status !== 401) throw new Error(`a wrong sign-in answered ${login.status}, expected 401`);
  const me = await hit(version, '/api/me');
  if (me.status !== 401) throw new Error(`/api/me without a session answered ${me.status}, expected 401`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const status = JSON.parse(wrangler('deployments', 'status', '--json'));
const previous: string = status.versions.find((v: { percentage: number }) => v.percentage === 100)?.version_id ?? status.versions[0].version_id;
log(`live version: ${previous}`);

wrangler('d1', 'migrations', 'apply', 'budgedora', '--remote');

const uploaded = wrangler('versions', 'upload', '--message', message);
const version = dryRun ? previous : uploaded.match(/Worker Version ID:\s*([0-9a-f-]{36})/i)?.[1];
if (!version) throw new Error(`could not find the new version id in:\n${uploaded}`);
const previewUrl = uploaded.match(/Version Preview URL:\s*(https:\/\/\S+)/i)?.[1];
if (previewUrl) versionUrls.set(version, previewUrl.replace(/\/$/, ''));
else if (!dryRun) throw new Error('no Version Preview URL in the upload output (is preview_urls = true?)');
log(`uploaded ${version} (${previewUrl ?? 'dry run'}); smoke-testing it before it gets any traffic`);
await smoke(version);

wrangler('versions', 'deploy', `${version}@${canary}%`, `${previous}@${100 - canary}%`, '--message', `${message} (canary ${canary}%)`, '--yes');
log(`canary at ${canary}%; watching for ${watchSeconds}s`);
try {
  for (let t = 0; t < watchSeconds; t += 20) {
    await sleep(dryRun ? 0 : 20000);
    await smoke(version);
    const live = await fetch(`${BASE_URL}/api/health`); // whichever version the split picks
    if (live.status !== 200) throw new Error(`the live site's /api/health answered ${live.status}`);
  }
} catch (err) {
  log(`check failed: ${(err as Error).message}; rolling back to ${previous}`);
  wrangler('versions', 'deploy', `${previous}@100%`, '--message', `rollback: ${message}`, '--yes');
  process.exit(1);
}

wrangler('versions', 'deploy', `${version}@100%`, '--message', message, '--yes');
await smoke(version);
log(`released ${version} to 100%`);
