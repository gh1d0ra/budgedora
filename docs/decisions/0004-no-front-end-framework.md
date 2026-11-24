# 0004 — No front-end framework or build step

**Status:** accepted

## Context
The UI is a handful of views (add, history, budget, reports, settings) used mostly on phones.

## Decision
Write the front end in plain JavaScript files served as-is, with no framework, bundler or transpiler. Logic that matters
(`smart.js`, `statements.js`) is kept free of the DOM so it can be tested in Node.

## Consequences
- Fast first load, nothing to upgrade, and a strict CSP (`script-src 'self'`, no `eval`) is easy to keep.
- Rendering is done by hand with escaped template strings, which needs discipline. All user text goes through `esc()`.
- If the UI grows much larger, a component framework would pay for itself. This record should then be revisited.
