# 0007 — The API contract lives in OpenAPI; types and tests are derived from it

**Status:** accepted

## Context
The API's shape was defined only by the code in `src/api.ts` and the way `public/app.js` happened to use it. Nothing
stopped a refactor from renaming a field the front end reads, or leaking a database column such as `user_id` into a response.

## Decision
- `public/openapi.json` (OpenAPI 3.1) is the contract. It's served at `/openapi.json`, so it is also the API's documentation.
- `npm run api:types` generates `src/api-types.ts` with openapi-typescript. The server's response builders are typed
  against it (`Schemas['Expense']`, `satisfies Schemas['Data']`), so `tsc` fails if the code drifts from the spec.
  CI regenerates the file and fails if it changed (`npm run api:check`).
- `test/contract.test.ts` drives a full session through the real API and validates **every** response against the
  spec with Ajv:
  - status code, content type and body;
  - `additionalProperties: false` everywhere, so leaked fields fail;
  - every documented operation must be exercised.

  A negative test proves the checker rejects drift.
- openapi-typescript is run through a pinned `npx` because it requires TypeScript 5 as a peer, while the project
  uses TypeScript 7. Installing it would mean forcing the peer dependency.

## Consequences
- Changing the API means changing the spec first. The type checker and the contract tests point at everything that must follow.
- The front end is still plain JavaScript and isn't type-checked against the spec. The contract tests cover the
  server side of the boundary.
