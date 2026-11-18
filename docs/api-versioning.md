# API versioning & deprecation policy

Lens serves every public route under a version segment:

```
GET https://<host>/v1/price/XLM/USDC
```

The versioned path is the **canonical** one. It is what [`openapi.yaml`](../openapi.yaml)
documents, and what new clients should integrate against.

The same routes also answer at their **unversioned** paths:

```
GET https://<host>/price/XLM/USDC
```

These are **deprecated aliases** kept so that every caller integrated before
`/v1` existed keeps working without a change. They are not a second
implementation: the version segment is stripped before routing
([`src/api/versioning.ts`](../src/api/versioning.ts)), so an alias request
resolves to the exact same route — same handler, same auth, same x402 gating,
same rate limit — and answers identically apart from the warning headers below.

## Why the aliases exist

Response shapes are changing. Decimals are becoming strings, a `network` field
is being added, and an empty result is getting a distinct convention from "no
data". Each of those is a breaking change for anyone already parsing the
response. A URL version is the only way to make them without breaking existing
callers: `/v1` can change, the unversioned alias cannot.

## How a caller is warned

Every response sent for an **unversioned** request to a public route carries two
headers:

| Header | Value | Meaning |
| --- | --- | --- |
| `Deprecation` | `true` | RFC 8594 signal that this resource is deprecated. |
| `Link` | `</v1/price/XLM/USDC>; rel="successor-version"` | The versioned path for the exact resource requested. |

```
$ curl -sD - -o /dev/null http://localhost:3002/price/XLM/USDC
HTTP/1.1 200 OK
deprecation: true
link: </v1/price/XLM/USDC>; rel="successor-version"
...
```

The versioned request does **not** carry these headers. The headers are
advisory: the alias still answers normally, so a caller that ignores them is not
broken — it is only told where to move.

Operator-only and non-HTTP routes (`/metrics`, `/ws`, `/admin/*`, `/graphiql*`)
are excluded. They are not part of the versioned public contract and were never
intended to move; a request to them is neither versioned nor warned.

## How long an alias lives

An unversioned alias lives for **at least two minor releases** after the
versioned path ships, and no longer than **twelve months**. Concretely:

1. **Announce.** The versioned path ships and the alias starts returning the
   `Deprecation` / `Link` headers. This document and the release notes record
   the date.
2. **Wait.** The alias stays in place, answering identically, for the full
   window. No alias is removed in a patch release.
3. **Retire.** After the window, removal is a `minor` (pre-1.0) or `major`
   change with the removal called out in `CHANGELOG.md` and the alias added to
   the coverage test's exclusion list in
   [`src/openapi/coverage.ts`](../src/openapi/coverage.ts) in the same change.

A removal can be deferred, but never accelerated.

## Adding a new version

1. Change `API_VERSION_PREFIX` in [`src/openapi/coverage.ts`](../src/openapi/coverage.ts)
   only when the *current* version's contract can no longer be extended — a
   response-shape change that is not additive.
2. Prefix the canonical paths in `openapi.yaml` with the new segment and run
   `npm run openapi:gen`.
3. Keep the previous version's paths as aliases (with the warning headers) for
   the window above; clients migrate on their own schedule.
4. `tests/openapi.test.ts` boots the app and asserts that every documented
   versioned path resolves to a registered alias, and that both answer
   identically — so a route that is added but not versioned, or an alias that
   drifts from its versioned path, fails CI.
