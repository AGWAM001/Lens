---
'lens': minor
---

DeFindex vault shares are now priced. A new `DeFindex` venue adapter
(`src/ingest/venues/defindex.ts`) enumerates every vault from the protocol's
on-chain factory registry, reads each vault's total managed assets and total
share supply straight from the chain, and derives the share price as
`totalAssets / totalShares` — never from a published figure that could be stale.
A vault with zero shares yields no point rather than dividing by zero. Rows are
written with `source = 'defindex_vault'` so a derived vault price is never
silently blended with a traded one, and each row carries the network it was read
from, so the ingester runs once per `ENABLED_NETWORKS` entry without merging
mainnet and testnet series. The factory contract ids are taken whole from DeFindex's
published `mainnet.contracts.json` / `testnet.contracts.json`.
