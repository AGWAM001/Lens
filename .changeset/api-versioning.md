---
'lens': minor
---

Serve every public route under a `/v1` version segment, keeping the
unversioned paths as deprecated aliases that answer identically.

`src/api/versioning.ts` strips the segment in a Fastify `rewriteUrl` hook before
the request is routed, so `/v1/price/XLM/USDC` and `/price/XLM/USDC` resolve to
the same route definition — same handler, same auth, same x402 gating and rate
limits — rather than being mounted twice and drifting. Existing callers are not
broken: the unversioned form keeps working, and every response to it now carries
`Deprecation: true` and a `Link: </v1/...>; rel="successor-version"` header
pointing at the versioned path. The versioned response carries neither.

`openapi.yaml` (and the generated `openapi.json`) now document the `/v1` paths;
`tests/openapi.test.ts` asserts that every documented versioned path maps onto a
registered route, that the unversioned alias exists for each, and that the two
forms answer identically. Operator-only and non-HTTP routes (`/metrics`, `/ws`,
`/admin/*`, `/graphiql*`) are excluded and remain unversioned.

The warning contract and the alias-retirement window — at least two minor
releases, no more than twelve months — are written down in
[`docs/api-versioning.md`](docs/api-versioning.md).
