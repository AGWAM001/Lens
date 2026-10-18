---
'lens': patch
---

Snapshot retention now prunes `price_snapshots` for every network in
`ENABLED_NETWORKS`, not just the active one, so the second network of a
dual-network process no longer grows unbounded. The startup prune, the BullMQ
worker and the in-process fallback timer all use the new `pruneAllNetworks()`,
and the pruned row count is logged per network. `pruneOldSnapshots()` gains an
optional `network` argument (defaulting to the active network).
