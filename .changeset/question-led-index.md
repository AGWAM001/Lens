---
'lens': minor
---

Build a question-led API route index (#305) generated directly from the OpenAPI specification to prevent documentation drift:
- Annotate every documented route in `openapi.yaml` with `x-question`, `x-example`, `x-order`, and `x-category`.
- Order routes by newcomer exploration journey rather than HTTP URL or method, with detailed rationale documented across 7 stages.
- Provide concrete, non-elided examples without shortened addresses or contract IDs, echoing network parameter where supported.
- Introduce `scripts/generate-question-index.ts` and `npm run index:gen` to compile `docs/what-lens-knows.md` and keep the `README.md` endpoint table synchronized.
- Extend `tests/openapi.test.ts` to assert every Fastify registered route has a plain-English question, fail when a route lacks a question, verify contiguous newcomer ordering, and guard against drift in `README.md` and `docs/what-lens-knows.md`.
