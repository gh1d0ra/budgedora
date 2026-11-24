# 0005 — TypeScript on the server without a compile step

**Status:** accepted

## Context
The API, Worker, scripts and tests benefit from types (database rows, request options, bindings). The project
should still run with a single `node server.ts` and no build output to manage.

## Decision
Write the server side in TypeScript, using only syntax that can be erased (enforced by `erasableSyntaxOnly`). Node 22.18+
runs `.ts` files directly by stripping types, and wrangler bundles `src/worker.ts`. `tsc` is used only to check types (`npm run check`),
with separate configs for the Node and Worker type environments.

## Consequences
- No `dist/` folder and no source maps to manage. The code that runs is the code you read.
- Enums, namespaces and parameter properties are not allowed. Plain unions and interfaces cover what the code needs.
- Browser code stays JavaScript (0004).
