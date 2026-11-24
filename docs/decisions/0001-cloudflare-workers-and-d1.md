# 0001 — Host on Cloudflare Workers with D1

**Status:** accepted

## Context
A family expense tracker has a handful of users and tiny data volumes, but it should be always on, fast on a phone,
and cost nothing to run. Running a VM or container means patching, uptime and paying for it.

## Decision
Run the API as a Cloudflare Worker, store data in D1 (managed SQLite), serve the front end as Worker static assets,
and keep backups in Workers KV, written by a cron trigger.

## Consequences
- Free tier, no servers to maintain, and the app runs close to the user.
- D1 is SQLite, so local development can use the same SQL with Node's built-in `node:sqlite` (see 0002).
- Workers limits shape the code. For example, PBKDF2 is capped at 100k iterations, so that is the hashing cost used.
- Vendor lock-in is low: the API only uses web-standard `Request`, `Response` and WebCrypto.
