---
'lens': patch
---

`GET /spreads/:asset`, `GET /rates/:asset` and `GET /snapshot` now honour the
`x-network` header, not just `?network=`, by using the network the request
selector resolved (the query parameter still wins when both are sent).
`computeSpreads()` takes an optional `requestNetwork`, so the GraphQL `spreads`
caller is unchanged. `/snapshot` now sends `Vary: x-network` with its own
`Cache-Control`, and its Redis cache is keyed by the resolved network.
