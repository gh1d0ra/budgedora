# Budgedora architecture

Budgedora is a small, multi-account expense tracker. It is built to be cheap to run (Cloudflare's free tier),
quick to use on a phone, and easy to reason about: one TypeScript API, one SQL schema, and a framework-free front end.

## System overview

```mermaid
flowchart LR
  subgraph Browser
    UI["index.html + app.js<br/>(vanilla JS SPA)"]
    Smart["smart.js<br/>questions, insights"]
    Stmt["statements.js<br/>CSV / OFX / PDF parsing"]
    PDF["pdf.js (self-hosted)"]
    UI --> Smart
    UI --> Stmt --> PDF
  end

  subgraph Cloudflare["Cloudflare (production)"]
    Worker["Worker<br/>src/worker.ts"]
    API["API<br/>src/api.ts"]
    D1[("D1<br/>SQLite")]
    KV[("KV<br/>backups")]
    Assets["Static assets"]
    Cron(["Cron 04:17 UTC"])
    Worker -->|/api/*| API --> D1
    Worker -->|everything else| Assets
    Cron --> Worker -->|gzip snapshot| KV
  end

  subgraph Local["Local development"]
    Node["Node server<br/>server.ts"]
    SQLite[("node:sqlite<br/>data/budgedora.db")]
    Node --> API2["same API<br/>src/api.ts"] --> SQLite
  end

  UI -->|JSON over HTTPS, session cookie| Worker
  UI -.->|npm start| Node
```

The same `handleApi(request, db)` function runs in both places. It only uses web-standard `Request`, `Response`
and WebCrypto, and talks to the database through a four-method adapter:

```ts
interface Db {
  all<T>(sql, ...params): Promise<T[]>;
  get<T>(sql, ...params): Promise<T | null>;
  run(sql, ...params): Promise<{ lastId; changes }>;
  batch(stmts): Promise<unknown>;   // all-or-nothing
}
```

| Adapter | Where | File |
|---|---|---|
| D1 | Cloudflare Worker | `src/worker.ts` |
| node:sqlite | Local server and tests (in memory) | `src/sqlite-db.ts` |

Because the API is a pure function of `(Request, Db) → Response`, the tests call it directly against an in-memory
database, with no HTTP server or mocks.

## Request flow

```mermaid
sequenceDiagram
  participant B as Browser
  participant W as Worker
  participant A as handleApi
  participant D as D1
  B->>W: POST /api/expenses (JSON, sid cookie)
  W->>A: Request + D1 adapter + client IP
  A->>A: content-type must be JSON (CSRF guard)
  A->>D: look up session → user
  A->>D: check bucket belongs to user, INSERT expense
  A-->>W: JSON + security headers
  W-->>B: 200 { id, bucketId, amount, date, note }
```

Every query that touches user data is scoped by `user_id`. Accounts cannot see each other's rows, and the API tests check this.

## Data model

```mermaid
erDiagram
  users ||--o{ sessions : has
  users ||--o{ buckets : owns
  users ||--o{ expenses : owns
  users ||--o{ budgets : plans
  users ||--o{ reset_tokens : "may have"
  buckets ||--o{ expenses : groups
  buckets ||--o{ budgets : "expected per month"
  users {
    int id PK
    text email UK
    text pass_hash "PBKDF2-SHA256"
    int failed_logins
    int locked_until
    text deleted_at "soft delete"
  }
  buckets {
    int id PK
    int user_id FK
    text name
    int monthly_budget "cents"
    int archived
  }
  expenses {
    int id PK
    int user_id FK
    int bucket_id FK
    int amount "cents; negative = refund"
    text date "YYYY-MM-DD"
    text note
  }
  budgets {
    int bucket_id FK
    text month "YYYY-MM"
    int amount "cents"
  }
```

Money is stored as integer cents and converted to dollars only at the API boundary.
`login_attempts` (per-IP throttling) is a standalone table. Schema changes ship as numbered files in `src/migrations/`.

## Statement import pipeline

Bank and card statements are parsed **in the browser**. The file never leaves the device; only the
rows the user approves are sent to the API.

```mermaid
flowchart LR
  F["Files<br/>CSV · Excel · OFX/QFX · PDF · Amazon zip"] --> P["parseFile<br/>detect bank & format"]
  P --> T["Transactions<br/>date · description · spend"]
  T --> C["Totals check<br/>vs statement balances"]
  T --> PL["plan()<br/>skip payments / income<br/>find duplicates<br/>guess bucket"]
  A["Amazon orders"] --> E["enrichAmazon<br/>match by order # or amount+date"]
  PL --> E --> R["Review dialog<br/>user edits / unticks"] --> I["POST /api/expenses/import"]
```

- **Format detection:** AMEX, Chase card and checking, and Wells Fargo are detected from their column headers, the
  headerless WF layout, or the PDF text. Any other bank's CSV or OFX works through a generic path.
- **PDFs:** pdf.js (self-hosted, because the CSP blocks third-party scripts) returns positioned text. The parser groups it
  into lines. Where a statement has separate deposit and withdrawal columns, it tells them apart by column position.
- **Safety nets:**
  - a **totals check** compares the parsed sum with the statement's own beginning and ending balances;
  - **duplicate detection** matches on date, cents and merchant, so re-importing a statement adds nothing.
- **Bucket guesses** are made in this order: the user's own history for that merchant, then merchant patterns, then the
  bank's category.

## Security

| Concern | Approach |
|---|---|
| Passwords | PBKDF2-SHA256, 100k iterations, random salt, constant-time compare; dummy hash for unknown emails |
| Brute force | Per-account lockout (5 tries, escalating up to 24 h) and per-IP limit (30 / 15 min) |
| Sessions | 256-bit random token, `HttpOnly; SameSite=Lax; Secure`, 60 days; password change revokes other sessions |
| CSRF | State-changing requests must be `application/json`, which forces a CORS preflight |
| XSS | All user text escaped on render; CSP without inline scripts or `eval` (the amount calculator is a small parser) |
| Account recovery | One-time reset links created by the family admin, stored only as a SHA-256 hash, valid for 24 h |
| Data loss | Soft-deleted accounts; D1 Time Travel; daily and monthly gzip snapshots in KV; weekly local export |

## Testing and delivery

```mermaid
flowchart LR
  PR["Push / PR"] --> TC["Type check<br/>tsc, Node + Worker"]
  PR --> UT["Unit + API tests<br/>node:test, Node 22 & 24"]
  PR --> WB["Worker bundle<br/>wrangler --dry-run"]
  PR --> E2E["Browser tests<br/>Playwright, desktop + phone"]
  PR --> API["Spec check<br/>openapi.json ↔ api-types.ts"]
  TC & UT & WB & E2E & API --> D{"main?"}
  D -->|yes| MIG["D1 migrations"] --> UP["Upload version<br/>(0% traffic)"] --> SMK["Smoke test<br/>its preview URL"] --> CAN["Canary 10%<br/>2 min"] --> PRO["100%"]
  CAN -->|check fails| RB["Roll back"]
  D -->|PR| PRV["Preview Worker<br/>own database"]
```

- **Unit tests** (`test/statements.test.ts`, `test/smart.test.ts`) cover parsing, bucket guessing, duplicate detection,
  Amazon matching, plain-English questions and the calculator. They use made-up fixtures only.
- **API tests** (`test/api.test.ts`) run the real API against in-memory SQLite. They cover sign-up, lockout, throttling,
  password reset, isolation between accounts, CRUD, import and export.
- **Contract tests** (`test/contract.test.ts`) validate every API response against `public/openapi.json` with Ajv, and
  require every documented operation to be exercised. The server code is also typed against types generated from the spec.
- **Demo tests** (`test/demo.test.ts`) cover the public demo's isolation, limits and clean-up.
- **Load test** (`load/api.k6.js`, k6) runs 25 people at once against a local server. In the last run, p95 was under 10 ms for every route.
- **Browser tests** (`e2e/`) run the full flow in Chromium at desktop and phone sizes: sign up, add an expense, import an
  AMEX statement, and ask a question.

Releases: [release.md](release.md). Metrics, logs and targets: [observability.md](observability.md). Threats and controls:
[threat-model.md](threat-model.md). Design decisions and their trade-offs: [`docs/decisions/`](decisions/).
