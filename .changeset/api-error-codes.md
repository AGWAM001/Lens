---
'lens': minor
---

Add a single enumerated set of stable, machine-readable error codes. Every JSON
error response now carries a `code` beside its existing `error` string: `error`
stays human-readable and may be reworded at any time, while `code` is a contract
a client can branch on instead of matching on sentences.

The codes are declared once in `src/errors.ts`, emitted through a shared
`apiError` helper, and mirrored in `openapi.yaml`. A guard test fails the build
if the spec and the enum drift apart, or if any route emits a code outside the
set — so a typo cannot ship as a new code.
