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

**Accounts** — each login has its own buckets and data (scrypt-hashed passwords, HttpOnly session cookies).
Default buckets: Groceries, Restaurants, Household + grass, Car/Gas, House insurance/tax + HOA, Utilities,
Education, Giving, Health/Beauty, Clothes, Entertainment, Vacation. Rename, recolor, reorder, budget or archive any of them.

**Data** — CSV export/import (`date,bucket,amount,note`).

## Run it

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`). No `npm install` needed — zero dependencies.

```bash
npm start            # http://localhost:3000
npm run seed         # optional: demo account demo@budgedora.test / demo1234 with 3 years of data
```

Environment variables: `PORT` (default 3000), `DATA_DIR` (default `./data`, where `budgedora.db` lives).

Put it behind HTTPS (e.g. Caddy/nginx, or any Node host) when exposing it to the internet; the session cookie
is marked `Secure` automatically when `X-Forwarded-Proto: https` is set.

## Structure

```
server.js            HTTP server + JSON API + SQLite schema
public/index.html    the single-page app
public/app.js        UI (entry, history, reports, settings)
public/smart.js      periods, natural-language questions, insights, suggestions
public/app.css       styles (light + dark)
scripts/seed-demo.js demo data
```
