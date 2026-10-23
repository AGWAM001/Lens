---
'lens': minor
---

Add Phoenix, a Soroban AMM venue, as a price source. `src/ingest/venues/phoenix.ts`
enumerates pools from Phoenix's own factory contract (`query_pools`) — never from a
list kept in this repo — reads each pool's reserves with `query_pool_info`, derives
the constant-product spot price, and writes `price_points` rows tagged
`source: 'phoenix_amm'` with the pool's contract id in `poolId`. A watched pair is
matched to a pool by deriving the Stellar Asset Contract id from its `{code, issuer}`
and the network passphrase, so two assets sharing a code but not an issuer can never
blend into one series.

The discovered pool list is cached per network for `PHOENIX_POOL_CACHE_TTL_MS`
(default 10 minutes) with single-flight refreshing, and a refresh that fails keeps the
previous list and leaves the TTL un-advanced so the next cycle retries. The adapter is
registered in `venueAdapters`, so `ENABLED_NETWORKS` starts one independently
fault-isolated Phoenix instance per network, each writing rows stamped with its own
network. An unreachable Phoenix RPC degrades this venue to "no Phoenix price today" —
it logs and returns empty rather than throwing.

Config: `PHOENIX_FACTORY_ADDRESS_MAINNET` defaults to Phoenix's published mainnet
factory, `CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI`, taken verbatim
from the protocol's own repository. Phoenix publishes no testnet deployment, so testnet
has no built-in id: the venue stays disabled there until an operator sets
`PHOENIX_FACTORY_ADDRESS_TESTNET`. `PHOENIX_ENABLED_<NETWORK>`,
`PHOENIX_POLL_INTERVAL_MS` and `PHOENIX_POOL_CACHE_TTL_MS` round out the surface, all
documented in `.env.example`.
