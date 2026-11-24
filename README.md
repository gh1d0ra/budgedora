# 🐉 Budgedora

A super simple, multi-account expense tracker. Type an amount, tap a bucket, done.

Inspired by the best parts of YNAB / Goodbudget (envelope-style **buckets** with optional monthly budgets),
Monarch / Copilot (clean reports, month-to-date pace) — minus the bank syncing and complexity.

## Features

**Fast entry**
- Big amount field with math (`45.20+12` → $57.20)
- One-tap bucket grid showing this month's spend and budget bar per bucket
- Today / Yesterday chips or any date
- ✨ Auto-picks the bucket from your note (learns from your history: “Costco” → Groceries)
- ✨ Typing an amount you've used before (e.g. 15.49) offers “Netflix · Entertainment” in one tap
- Undo after every save

**Reports** (any period: this/last month, 3/12 months, this/last year, any year or month, all time)
- KPIs with a fair “vs same point last period” comparison
- ✨ Insights: month-end projection, biggest movers, over-budget alerts, unusual expenses, recurring charges
- Donut by bucket, monthly stacked bars, cumulative month-vs-last-month line
- Year-over-year chart, **years × months** heatmap (click to drill in), **buckets × months** grid
- Biggest expenses, spending by weekday

**Ask in plain English** — e.g.
`groceries last year` · `restaurants vs groceries 2025` · `car/gas 2025 vs 2024` · `top expenses in march` ·
`average monthly utilities` · `how many times restaurants last 3 months` · `netflix` · `costco since 2024` · `over 200 this year` · `q2 2025`

**Accounts** — each login has its own buckets and data (PBKDF2-hashed passwords, HttpOnly session cookies).
Default buckets: Groceries, Restaurants, Household + grass, Car/Gas, House insurance/tax + HOA, Utilities,
Education, Giving, Health/Beauty, Clothes, Entertainment, Vacation. Rename, recolor, reorder, budget or archive any of them.

**Data** — CSV export/import (`date,bucket,amount,note`).

## Run it

Requires **Node.js 22.13+** (built-in `node:sqlite`) for local runs — no `npm install` needed.

```bash
npm start            # http://localhost:3000
npm run seed         # optional: demo account demo@budgedora.test / demo1234 with 3 years of data
```

Environment variables: `PORT` (default 3000), `DATA_DIR` (default `./data`, where `budgedora.db` lives).

## Production: Cloudflare Workers + D1

Live at **https://budgedora.igorrash.workers.dev** (free tier is plenty for a family).

```bash
npm i -g wrangler && wrangler login      # once
wrangler d1 create budgedora             # once — put the id in wrangler.toml
npm run cf:db:init                       # once — creates the tables (safe to re-run)
npm run deploy                           # every update
```

Add a demo account with ~3 years of made-up expenses to the live site (re-running resets it):

```bash
node scripts/demo-sql.js someone@example.com theirpassword "Name" demo.sql
wrangler d1 execute budgedora --remote --file=demo.sql
```

Back up the live data any time: `wrangler d1 export budgedora --remote --output backup.sql`.

## Structure

```
src/api.js           the JSON API (shared by Workers and Node)
src/worker.js        Cloudflare Worker entry (D1 + static assets)
src/schema.sql       database schema
server.js            local Node server (node:sqlite)
wrangler.toml        Cloudflare config
public/index.html    the single-page app
public/app.js        UI (entry, history, reports, settings)
public/smart.js      periods, natural-language questions, insights, suggestions
public/app.css       styles (light + dark)
scripts/seed-demo.js local demo data
```
