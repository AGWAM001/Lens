---
"lens": minor
---

**Breaking:** range endpoints now use half-open intervals — `[from, to)`, not
`[from, to]`. `from` is inclusive, `to` is exclusive.

`GET /candles/:assetA/:assetB` and `GET /prices/history` previously returned
samples with `timestamp` in `from..to` inclusive at both ends. A caller paging
back-to-back windows (`[T0, T1]`, then `[T1, T2]`) got every sample landing
exactly on `T1` **twice** — once in each response — so the two windows
together double-counted the boundary and inflated any total, average or VWAP
computed over them.

`to` is now exclusive. Adjacent windows `[T0, T1)` and `[T1, T2)` share no
boundary, and a sample landing exactly on `T1` appears in exactly one of the
two responses.

Callers that relied on the inclusive end must widen their `to` by one tick
(the smallest interval they query) to keep the same rows — e.g. `[T0, T1]` is
now `[T0, T1 + 1s)` at `interval=1m`.

Every `price_points` query now also carries the `network` predicate, so the
`(network, pair_key, timestamp)` index is usable and a pair's price is never a
blend of two chains. `GET /candles/:assetA/:assetB` and `GET /basket` were
reading both networks; `GET /benchmark/:asset` was computing its deviation
figures from both. They now default to the active network and honour
`?network=` / `x-network`.
