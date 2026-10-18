---
'lens': patch
---

Document the full public route surface in `openapi.yaml` (params, the shared
`?network=` query, and response schemas) and add `tests/openapi.test.ts`, which
boots the app, enumerates every registered route and fails when a non-internal
route is missing from the spec. Operator-only and non-HTTP routes are excluded
through an explicit, commented allow-list in `src/openapi/coverage.ts`. The
generator is now importable and deterministic, and a test asserts the committed
`openapi.json` matches it.
