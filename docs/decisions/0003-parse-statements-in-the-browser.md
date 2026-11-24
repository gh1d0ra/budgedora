# 0003 — Parse bank statements in the browser

**Status:** accepted

## Context
Users import bank and credit-card statements (CSV, Excel, OFX, PDF) and Amazon order history. These files contain
account numbers, names and addresses that the app does not need.

## Decision
Parse every file client-side (`public/statements.js`, with a self-hosted pdf.js for PDFs). Show a review table, and send only
the approved rows (date, bucket, amount, short description) to `POST /api/expenses/import`.

## Consequences
- Statements never reach the server, so there's less sensitive data to protect and nothing to delete later.
- The parser is a set of pure functions that are easy to unit test with made-up fixtures.
- PDF parsing depends on each bank's layout. To catch a misread line, a totals check compares the parsed sum with the
  statement's own balances.
- The browser has to load pdf.js (about 1.4 MB), but only when the user picks a PDF.
