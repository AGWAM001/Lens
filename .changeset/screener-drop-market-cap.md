---
"lens": patch
---

`/screener` no longer reports `market_cap`. It was a copy of `liquidity` under another name, so sorting or filtering by market cap silently sorted or filtered liquidity. Lens has no circulating-supply data to compute a real one, so the field is removed from the response and the sort allowlist, and `?market_cap=` and `?sortBy=market_cap` now return a 400 instead of being ignored. The three CTEs behind `/screener` are also now scoped to one network (`?network=` / `x-network`, defaulting to the active network) instead of pooling testnet and mainnet rows.
