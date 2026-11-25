# Releasing Budgedora

Every push to `main` that passes the tests is released by CI (`.github/workflows/ci.yml` → `scripts/release.ts`):

1. **Migrate.** `wrangler d1 migrations apply budgedora --remote` runs any new file in `src/migrations/`.
   Migrations must be *additive* (new tables, new columns with defaults), because the version still serving
   traffic runs against the migrated database until the new one takes over.
2. **Upload** the new version with no traffic (`wrangler versions upload`).
3. **Smoke-test that exact version** at its own preview URL. The checks are:
   - `/api/health`: the database answers, the schema has every column the code needs, and the version id matches;
   - the page and its security headers;
   - signed-out API calls.
4. **Canary:** 10% of traffic for two minutes, checked every 20 seconds.
5. **Promote** to 100%, or **roll back** to the previous version if any check failed.

Pull requests from this repository get a **preview link** (`pr-<n>-budgedora-preview.<subdomain>.workers.dev`). It runs on a separate
Worker, `budgedora-preview`, with its own database, so a preview can never read or change real data.

## One-time setup

Add two repository secrets: `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers" template plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID`.
Without them, CI still runs every test but skips the release and preview jobs.

Production started using Wrangler's migration tracking in v1.4. Before that, migrations were applied by hand,
so the first time, the database has to be told which migrations it already has:

```sh
node scripts/d1-baseline.ts 0004_household.sql > baseline.sql
npx wrangler d1 execute budgedora --remote --file=baseline.sql
```

Preview database:

```sh
npx wrangler d1 create budgedora-preview      # put its id in wrangler.toml under [env.preview]
npx wrangler d1 execute budgedora-preview --env preview --remote --file=src/schema.sql
node scripts/d1-baseline.ts 0005_demo.sql > baseline.sql   # schema.sql already contains every migration
npx wrangler d1 execute budgedora-preview --env preview --remote --file=baseline.sql
```

## Adding a migration

1. Add `src/migrations/NNNN_name.sql`, and make the same change in `src/schema.sql` (new databases start from it).
2. Keep the migration additive.
3. If the new code needs the new column, add it to the `/api/health` check. Then a missed migration fails the
   smoke test instead of a user's request.

## By hand

```sh
node scripts/release.ts                      # same steps as CI, using your `wrangler login`
node scripts/release.ts --canary-percent 25 --watch-seconds 300
```
