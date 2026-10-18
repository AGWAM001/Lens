---
'lens': patch
---

Add a `network` label to the four ingest metrics — `trades_ingested_total`,
`amm_snapshots_total`, `price_snapshots_total` and `last_trade_timestamp` — so a
dual-network deployment (`ENABLED_NETWORKS=testnet,mainnet`) reports each
network separately instead of folding them together.

`last_trade_timestamp` is the one that mattered: it is a gauge, so the testnet
ingester's `set()` was overwriting mainnet's value for the same pair every poll
interval, making Lens's only staleness signal silently unusable — it still
looked like a plausible timestamp. The counters were less broken but equally
unqueryable per network, since the two loops summed into one series.

Cardinality is unchanged in character: `pairs x networks` (plus `pools` on
`amm_snapshots_total`), all bounded by `WATCHED_PAIRS` and `ENABLED_NETWORKS`.
No `issuer` or `pool` label was added. Existing queries that did not filter by
`network` keep working and now return one series per network instead of a
merged one, so a recording rule that aggregated across networks before will see
one additional series per pair.

Documented in [`docs/ingest-metrics.md`](docs/ingest-metrics.md).
