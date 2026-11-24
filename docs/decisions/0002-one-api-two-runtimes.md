# 0002 — One API for Workers and Node, behind a tiny DB adapter

**Status:** accepted

## Context
Production runs on Cloudflare (D1). Local development and tests should work offline with no extra services or mocks.

## Decision
`handleApi(request, db, options)` in `src/api.ts` is the whole API. It takes a web `Request` and returns a `Response`.
It reaches the database only through a four-method `Db` interface (`all`, `get`, `run`, `batch`), implemented twice:
for D1 in `src/worker.ts`, and for `node:sqlite` in `src/sqlite-db.ts`.

## Consequences
- The same code and SQL run in production, locally and in tests. API tests run against a real in-memory database in milliseconds.
- SQL must stay in the shared SQLite dialect. That's easy, because both sides are SQLite.
- There is no ORM. Queries are hand-written and parameterised, and typed through generics (`db.get<UserRow>(...)`).
