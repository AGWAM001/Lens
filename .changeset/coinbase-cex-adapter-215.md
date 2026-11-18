---
"lens": minor
---

Ship the first real centralized-exchange adapter in `src/ingest/cex/` (issue #215). The directory previously held only the `CexAdapter` interface and a mock, so every cross-venue comparison compared Stellar venues against nothing. `CoinbaseAdapter` implements `CexAdapter` in full — `fetchTicker` and `fetchOrderBook` against Coinbase Exchange's public market-data endpoints — and is built and registered through a new exchange-agnostic `createCexAdapter(name)` factory (`registerCexAdapterFactory` wires concrete exchanges in).

It normalises pairs in both directions, mapping the Lens canonical form (`XLM/USD`) to the identifier the exchange actually uses (`XLM-USD`) and back, since a slash-form request 404s. Requests are throttled to Coinbase's published public limit (10 req/s per IP, burst up to 15) with a token bucket; a `429` honours `Retry-After` when present and otherwise backs off exponentially. Any outage, timeout, non-2xx, or malformed body degrades to a `null` return — the adapter never throws, so a dead exchange cannot take down the process or surface an error response. Prices carry a distinct `source` (`coinbase_cex`) and take the `network` from the caller rather than hard-coding it, so a CEX number is never mistaken for, or silently blended with, an on-chain one.
