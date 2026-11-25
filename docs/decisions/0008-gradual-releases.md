# 0008 — Gradual releases with smoke tests, a canary and automatic rollback

**Status:** accepted

## Context
`wrangler deploy` moved 100% of traffic to new code at once, and database changes were applied by hand. A bad version,
or code that needed a column a migration hadn't added yet, would have broken every request until someone noticed.

## Decision
`scripts/release.ts`, run by CI after the tests pass on `main`:
1. **`wrangler d1 migrations apply --remote`.** Migrations must be additive, so the version still serving traffic keeps
   working on the new schema. Production was baselined once (`scripts/d1-baseline.ts`), because its earlier migrations
   had been applied by hand.
2. **`wrangler versions upload`.** The new version gets no traffic.
3. **Smoke test that exact version at its preview URL.** `/api/health` must report *this* version id
   (`CF_VERSION_METADATA`), and its schema check must pass: it selects every column the code depends on. Pages need their
   security headers, and signed-out calls must answer 401.
4. **Canary:** `wrangler versions deploy new@10% old@90%`, re-checked every 20 seconds for two minutes, along with the live site.
5. **Promote to 100%,** or roll back to the previous version if any check failed.

Pull requests get a **preview link** on a separate Worker (`budgedora-preview`) with its own database. Previews of the
main Worker would share production bindings, and a PR should never touch real data.

## Consequences
- **A missed migration fails a smoke test instead of a user's request.** The health check names the columns, so adding
  a column-dependent feature means updating it (documented in [release.md](../release.md)).
- **The canary watch is a smoke loop, not error-rate analysis.** Per-version error rates are recorded in Analytics
  Engine (`blob4` = version) and can be compared by hand ([observability](../observability.md)), but the script
  doesn't gate on them yet.
- **Needs secrets** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). Without them, CI runs every test and skips the release.
