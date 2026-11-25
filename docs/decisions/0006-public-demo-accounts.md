# 0006 — A public demo: a private, throw-away account per visitor

**Status:** accepted

## Context
Visitors (and reviewers) can't judge an expense tracker without data in it. Asking them to sign up and type in
three years of spending doesn't work, and one shared demo login would let visitors see and vandalise each other's changes.

## Decision
`POST /api/demo` creates a new account flagged `is_demo`, fills it with ~3 years of made-up expenses and month plans
(`src/demo.ts`, deterministic), and signs the visitor in for 24 hours.
- **Isolation by construction:** each visitor gets their own account, so the normal per-user scoping applies.
- **Locked down:**
  - demo accounts have no usable password, so they can't be signed into by password;
  - they can't change their password, delete themselves or be admins;
  - they're excluded from backups and from the family admin's list.
- **Cleaned up:** accounts older than a day are deleted, with all their rows. This runs whenever a demo is created
  and in the daily cron.
- **Cheap to create:** the whole data set goes in with 2 SQL statements (`INSERT … SELECT … FROM json_each(?)`), not 1,300.
  That matters on Workers Free, which limits queries per request.
- **Limited:** 10 demos per IP per day and 100 overall. Each demo writes about 1,300 rows and reads about 17,000
  (measured with the per-request D1 counters, see [observability](../observability.md)), which keeps a busy day well
  inside the D1 free tier.

## Consequences
- The live site doubles as a demo without exposing anyone's data.
- Demo rows share the production database. They're excluded from backups and admin views by a single `is_demo` flag,
  which every new admin or backup query must also respect (the tests check both).
