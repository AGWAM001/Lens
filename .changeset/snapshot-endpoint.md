---
'lens': minor
---

Add `GET /snapshot`: one cached, network-scoped summary of a network's venues
(liveness), AMM liquidity (TVL, per-asset reserves and per-pool detail), 24h
traded volume (per venue, with a single-unit total only when the pairs share a
unit), the busiest pairs with their price direction, stablecoin peg readings,
and data freshness. All figures come from a single database statement with one
`as_of` clock, and unknowns are reported as `null` with a reason rather than
invented. The endpoint is public and never 404s.
