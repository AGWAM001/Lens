# What Lens Knows: A Question-Led API Index

Lens is a unified price and market analytics engine for the Stellar network. It aggregates order-book depth from the Stellar Decentralized Exchange (SDEX), automated market maker (AMM) liquidity pools, and external decentralized oracles.

Instead of an arbitrary alphabetized URL list, this page organizes what Lens knows around **real questions developers ask**, sequenced in the order a newcomer explores the protocol.

---

## Why This Order? (Newcomer Rationale)

A developer arriving at Lens does not browse by HTTP verb or path parameter. Their exploration follows a natural progression:

1. **Core Pricing & Trade Execution (Steps 1–6)**:
   The universal entry question: *"What is an asset trading at right now?"* (`/price/:assetA/:assetB`). Once price is known, the immediate follow-up is execution: *"Where do I get the best return for my trade size?"* (`/price/:assetA/:assetB/route`), *"What does combined order-book depth look like?"* (`/book/:assetA/:assetB`), *"How much slippage will I incur?"* (`/price/:assetA/:assetB/depth`), and how that slippage grows with size (`/impact/:assetA/:assetB`). Pricing in a local currency rather than dollars lives here too (`/price/:asset/fiat`).

2. **Market Overview & Liquidity Pools (Steps 7–17)**:
   Having evaluated immediate execution, the developer surveys market breadth: *"Which trading pairs are tracked?"* (`/pairs`), *"How do I track a new asset?"* (`POST /pairs`), *"Which AMM pools exist and what are their reserves?"* (`/pools`), and *"Where is cross-venue volume concentrated?"* (`/volumes/:asset`, `/venues`). Totals and one-request overviews answer the same question at the level of the whole network (`/tvl`, `/snapshot`), and lending venues answer what capital earns or costs (`/rates`, `/rates/:asset`).

3. **Comparative Analytics & Market Quality (Steps 18–32)**:
   Here Lens answers analytical questions that raw Horizon endpoints cannot: *"Which venue has the tightest bid-ask spread?"* (`/spreads/:asset`), *"Which pairs are top gainers or most liquid today?"* (`/screener`, `/movers`), *"Is a pegged stablecoin holding its target price?"* (`/benchmark/:asset`, `/pegs`), and *"How do Lens prices compare to external oracles?"* (`/compare/:asset`, plus its window statistics and history). Then the questions about trust in the data itself: whether venues disagree and which is the outlier (`/dispersion`), whether on-chain trades rich or cheap to the centralised market (`/premium/:assetA/:assetB`), how much of the market is actually observed (`/coverage`), and whether a basket is genuinely diversified (`/basket`, `/correlation`).

4. **Historical Trends & Robust Averages (Steps 33–37)**:
   Developers building charting UIs, backtesting trading models, or writing smart contracts need temporal data: *"Can I get OHLCV candlesticks?"* (`/candles/:assetA/:assetB`), *"What were recent rolling price buckets?"* (`/price/:assetA/:assetB/history`), *"Where can I query raw 1-minute historical snapshots or export CSV?"* (`/prices/history`), and *"What is the manipulation-resistant TWAP or VWAP for on-chain settlement?"* (`/price/twap/...`, `/price/vwap/...`).

5. **Multi-Query & Streaming (Steps 38–39)**:
   For complex web apps and trading bots: *"How do I fetch multiple prices and routes in a single request or initiate WebSocket subscriptions?"* (`GET /graphql`, `POST /graphql`).

6. **System Health & Venue Infrastructure (Steps 40–45)**:
   Operational confidence before going live: *"Is the indexer lagging and what is the latest ledger?"* (`/status`), *"Which venue adapters are active and healthy?"* (`/venues/registry`), the two probes an orchestrator needs to tell a live process from a ready one (`/live`, `/ready`), and *"What is my API key quota?"* (`/usage`, `/usage/me`).

7. **Automation, Discovery & Payments (Steps 46–52)**:
   Production integration and economic rails: *"What payable resources are discoverable via x402 Bazaar?"* (`/discovery/resources`), *"Can I find the right endpoint by describing what I want?"* (`/discovery/search`), *"How can my application receive push alerts on price thresholds?"* (`POST /webhooks`, `DELETE /webhooks/:id`), and *"How do x402 micro-payments verify and settle?"* (`/supported`, `/verify`, `/settle`).

---

## Complete Question-Led Index

| # | Question | Route | Example | Category |
|---|---|---|---|---|
| 1 | What is the current market price and 24-hour volume for an asset pair? | `GET /v1/price/:assetA/:assetB` | `GET /price/XLM/USDC?network=testnet` | Core Pricing & Trade Execution |
| 2 | Where can I execute a swap for the best return at a given trade size? | `GET /v1/price/:assetA/:assetB/route` | `GET /price/XLM/USDC/route?amount=1000&network=testnet` | Core Pricing & Trade Execution |
| 3 | What does the combined order book look like across SDEX and AMM liquidity pools? | `GET /v1/book/:assetA/:assetB` | `GET /book/XLM/USDC?depth=0.1&step=0.01&network=testnet` | Core Pricing & Trade Execution |
| 4 | What is the simulated order-book depth and expected slippage for a trade size? | `GET /v1/price/:assetA/:assetB/depth` | `GET /price/XLM/USDC/depth?amount=1000&network=testnet` | Core Pricing & Trade Execution |
| 5 | How does slippage grow as my trade size increases? | `GET /v1/impact/:assetA/:assetB` | `GET /impact/XLM/USDC?network=testnet` | Core Pricing & Trade Execution |
| 6 | What is this asset worth in my local currency, such as naira? | `GET /v1/price/:asset/fiat` | `GET /price/XLM/fiat?currency=NGN&network=testnet` | Core Pricing & Trade Execution |
| 7 | Which trading pairs are currently tracked by Lens on the active network? | `GET /v1/pairs` | `GET /pairs?network=testnet` | Market Overview & Liquidity Pools |
| 8 | How do I configure Lens to track a new trading pair? | `POST /v1/pairs` | `POST /pairs` | Market Overview & Liquidity Pools |
| 9 | Which AMM liquidity pools are being watched, and what are their reserves? | `GET /v1/pools` | `GET /pools?network=testnet` | Market Overview & Liquidity Pools |
| 10 | Which assets does Lens track, and which issuers are verified? | `GET /v1/assets` | `GET /assets?network=testnet` | Market Overview & Liquidity Pools |
| 11 | Who issues this asset, and can I trust that issuer? | `GET /v1/assets/:code` | `GET /assets/USDC?network=testnet` | Market Overview & Liquidity Pools |
| 12 | What is the total cross-venue trading volume for an asset over time? | `GET /v1/volumes/:asset` | `GET /volumes/XLM?window=24h&network=testnet` | Market Overview & Liquidity Pools |
| 13 | How much value is locked across Stellar DeFi, and in which venues? | `GET /v1/tvl` | `GET /tvl?network=testnet` | Market Overview & Liquidity Pools |
| 14 | Which venue is actually carrying the trading volume? | `GET /v1/venues` | `GET /venues?window=24h&network=testnet` | Market Overview & Liquidity Pools |
| 15 | Can I get the whole market in one request instead of ten? | `GET /v1/snapshot` | `GET /snapshot?network=testnet` | Market Overview & Liquidity Pools |
| 16 | What can I earn lending, and what does borrowing cost, across venues? | `GET /v1/rates` | `GET /rates?network=testnet` | Market Overview & Liquidity Pools |
| 17 | What are the supply and borrow rates for one asset on each lending venue? | `GET /v1/rates/:asset` | `GET /rates/USDC?network=testnet` | Market Overview & Liquidity Pools |
| 18 | Which venues offer the tightest bid/ask spread for an asset right now? | `GET /v1/spreads/:asset` | `GET /spreads/XLM?window=5m&network=testnet` | Comparative Analytics & Market Quality |
| 19 | Which pairs currently have the highest volume, price changes, or liquidity? | `GET /v1/screener` | `GET /screener?sortBy=volume&order=desc&limit=20&network=testnet` | Comparative Analytics & Market Quality |
| 20 | What moved most today, up, down, or by volume? | `GET /v1/movers` | `GET /movers?window=24h&limit=10&network=testnet` | Comparative Analytics & Market Quality |
| 21 | How closely is a pegged or wrapped asset tracking its peg target? | `GET /v1/benchmark/:asset` | `GET /benchmark/USDC?target=USD&network=testnet` | Comparative Analytics & Market Quality |
| 22 | How do Lens aggregated prices compare against external oracles? | `GET /v1/compare/:asset` | `GET /compare/XLM?network=testnet` | Comparative Analytics & Market Quality |
| 23 | Over the past week, which oracle tracked the market most closely? | `GET /v1/compare/:asset/summary` | `GET /compare/XLM/summary?window=7d&network=testnet` | Comparative Analytics & Market Quality |
| 24 | How has the gap between an oracle and the market moved over time? | `GET /v1/compare/:asset/history` | `GET /compare/XLM/history?window=7d&network=testnet` | Comparative Analytics & Market Quality |
| 25 | What is the weighted price of a custom portfolio basket of assets? | `GET /v1/basket` | `GET /basket?asset=XLM&asset=USDC&weight=0.6&weight=0.4&network=testnet` | Comparative Analytics & Market Quality |
| 26 | Do these assets move together, or are they genuinely diversified? | `GET /v1/correlation` | `GET /correlation?asset=XLM&asset=USDC&window=30d&network=testnet` | Comparative Analytics & Market Quality |
| 27 | Which pairs disagree most across venues right now? | `GET /v1/dispersion` | `GET /dispersion?network=testnet` | Comparative Analytics & Market Quality |
| 28 | The venues disagree on this pair — which one is the outlier? | `GET /v1/dispersion/:assetA/:assetB` | `GET /dispersion/XLM/USDC?network=testnet` | Comparative Analytics & Market Quality |
| 29 | Is this pair trading above or below the centralised exchanges? | `GET /v1/premium/:assetA/:assetB` | `GET /premium/XLM/USDC?network=testnet` | Comparative Analytics & Market Quality |
| 30 | Is this stablecoin still holding its peg? | `GET /v1/pegs` | `GET /pegs?network=testnet` | Comparative Analytics & Market Quality |
| 31 | How much of the market can Lens actually see? | `GET /v1/coverage` | `GET /coverage?network=testnet` | Comparative Analytics & Market Quality |
| 32 | For one asset, which venues is Lens watching and how much do they cover? | `GET /v1/coverage/:asset` | `GET /coverage/XLM?network=testnet` | Comparative Analytics & Market Quality |
| 33 | What are the historical OHLCV candlestick bars for a trading pair? | `GET /v1/candles/:assetA/:assetB` | `GET /candles/XLM/USDC?interval=1h&network=testnet` | Historical Trends & Robust Averages |
| 34 | What were the historical price buckets for a pair over a recent window? | `GET /v1/price/:assetA/:assetB/history` | `GET /price/XLM/USDC/history?window=1h&network=testnet` | Historical Trends & Robust Averages |
| 35 | Where can I query raw 1-minute historical snapshots or export them as CSV? | `GET /v1/prices/history` | `GET /prices/history?pair=XLM/USDC&interval=1m&network=testnet` | Historical Trends & Robust Averages |
| 36 | What is the manipulation-resistant time-weighted average price (TWAP) for settlement? | `GET /v1/price/twap/:assetA/:assetB` | `GET /price/twap/XLM/USDC?window=60&sampleInterval=60&method=iqr&network=testnet` | Historical Trends & Robust Averages |
| 37 | What is the volume-weighted average price (VWAP) across venues for a pair? | `GET /v1/price/vwap/:assetA/:assetB` | `GET /price/vwap/XLM/USDC?window=60&source=SDEX&method=iqr&network=testnet` | Historical Trends & Robust Averages |
| 38 | How do I query multiple prices, routes, and analytics in a single GET request? | `GET /v1/graphql` | `GET /graphql?query=%7Bprice%28assetA%3A%22XLM%22%2CassetB%3A%22USDC%22%29%7Bprice%7D%7D` | Multi-Query & Streaming |
| 39 | How do I execute complex GraphQL operations or initiate WebSocket subscriptions? | `POST /v1/graphql` | `POST /graphql` | Multi-Query & Streaming |
| 40 | Is the Lens indexer healthy, up to date, and what is the latest processed ledger? | `GET /v1/status` | `GET /status?network=testnet` | System Health & Venue Infrastructure |
| 41 | Which venue adapters (order books, AMMs, oracles) are registered and live? | `GET /v1/venues/registry` | `GET /venues/registry?network=testnet` | System Health & Venue Infrastructure |
| 42 | Is the service process alive at all? | `GET /v1/live` | `GET /live` | System Health & Venue Infrastructure |
| 43 | Is it safe to send traffic yet, or are dependencies still starting? | `GET /v1/ready` | `GET /ready` | System Health & Venue Infrastructure |
| 44 | How many requests have I made and what is my remaining API key quota? | `GET /v1/usage/me` | `GET /usage/me` | System Health & Venue Infrastructure |
| 45 | How much of my API quota have I used? | `GET /v1/usage` | `GET /usage` | System Health & Venue Infrastructure |
| 46 | What payable endpoints and datasets are discoverable in the x402 Bazaar catalog? | `GET /v1/discovery/resources` | `GET /discovery/resources?network=testnet` | Automation, Discovery & Payments |
| 47 | Can I find the right endpoint by describing what I want in plain language? | `GET /v1/discovery/search` | `GET /discovery/search?q=price%20of%20XLM%20in%20dollars&limit=5` | Automation, Discovery & Payments |
| 48 | Which payment schemes and token mechanisms does this x402 facilitator support? | `GET /v1/supported` | `GET /supported` | Automation, Discovery & Payments |
| 49 | How do I verify a signed x402 payment payload before fulfilling a service? | `POST /v1/verify` | `POST /verify` | Automation, Discovery & Payments |
| 50 | How do I submit and settle an x402 payment on the Stellar network? | `POST /v1/settle` | `POST /settle` | Automation, Discovery & Payments |
| 51 | How can my application receive push alerts when a price crosses a threshold? | `POST /v1/webhooks` | `POST /webhooks` | Automation, Discovery & Payments |
| 52 | How do I cancel an existing price threshold alert webhook? | `DELETE /v1/webhooks/:id` | `DELETE /webhooks/wh_9f8e7d6c5b4a3a2b1c?network=testnet` | Automation, Discovery & Payments |

---

## Capability Breakdown

### Core Pricing & Trade Execution

| Question | Route | Example | Description |
|---|---|---|---|
| **What is the current market price and 24-hour volume for an asset pair?** | `GET /v1/price/:assetA/:assetB` | `GET /price/XLM/USDC?network=testnet` | Get aggregated price for a pair |
| **Where can I execute a swap for the best return at a given trade size?** | `GET /v1/price/:assetA/:assetB/route` | `GET /price/XLM/USDC/route?amount=1000&network=testnet` | Get best swap route for a pair and amount |
| **What does the combined order book look like across SDEX and AMM liquidity pools?** | `GET /v1/book/:assetA/:assetB` | `GET /book/XLM/USDC?depth=0.1&step=0.01&network=testnet` | Get the aggregated SDEX and AMM price ladder for a pair |
| **What is the simulated order-book depth and expected slippage for a trade size?** | `GET /v1/price/:assetA/:assetB/depth` | `GET /price/XLM/USDC/depth?amount=1000&network=testnet` | Get order-book depth and execution slippage for a pair |
| **How does slippage grow as my trade size increases?** | `GET /v1/impact/:assetA/:assetB` | `GET /impact/XLM/USDC?network=testnet` | Get an adaptive slippage impact curve for a pair |
| **What is this asset worth in my local currency, such as naira?** | `GET /v1/price/:asset/fiat` | `GET /price/XLM/fiat?currency=NGN&network=testnet` | Convert asset price to fiat currency with NGN support (#290) |

### Market Overview & Liquidity Pools

| Question | Route | Example | Description |
|---|---|---|---|
| **Which trading pairs are currently tracked by Lens on the active network?** | `GET /v1/pairs` | `GET /pairs?network=testnet` | List all active trading pairs |
| **How do I configure Lens to track a new trading pair?** | `POST /v1/pairs` | `POST /pairs` | Add a new trading pair (Admin only) |
| **Which AMM liquidity pools are being watched, and what are their reserves?** | `GET /v1/pools` | `GET /pools?network=testnet` | Get AMM liquidity pool reserves and spot prices |
| **Which assets does Lens track, and which issuers are verified?** | `GET /v1/assets` | `GET /assets?network=testnet` | List tracked assets with metadata and verification status |
| **Who issues this asset, and can I trust that issuer?** | `GET /v1/assets/:code` | `GET /assets/USDC?network=testnet` | Get metadata and verification status for a specific asset |
| **What is the total cross-venue trading volume for an asset over time?** | `GET /v1/volumes/:asset` | `GET /volumes/XLM?window=24h&network=testnet` | Get cross-venue traded volume for an asset |
| **How much value is locked across Stellar DeFi, and in which venues?** | `GET /v1/tvl` | `GET /tvl?network=testnet` | Total Value Locked across Stellar DeFi venues |
| **Which venue is actually carrying the trading volume?** | `GET /v1/venues` | `GET /venues?window=24h&network=testnet` | Venue Share of Volume |
| **Can I get the whole market in one request instead of ten?** | `GET /v1/snapshot` | `GET /snapshot?network=testnet` | Whole-network snapshot (venues, TVL, 24h volume, top pairs, pegs, freshness) |
| **What can I earn lending, and what does borrowing cost, across venues?** | `GET /v1/rates` | `GET /rates?network=testnet` | Query latest lending and borrow rates across pools |
| **What are the supply and borrow rates for one asset on each lending venue?** | `GET /v1/rates/:asset` | `GET /rates/USDC?network=testnet` | Get supply and borrow rates for an asset across lending venues |

### Comparative Analytics & Market Quality

| Question | Route | Example | Description |
|---|---|---|---|
| **Which venues offer the tightest bid/ask spread for an asset right now?** | `GET /v1/spreads/:asset` | `GET /spreads/XLM?window=5m&network=testnet` | Get the tightest per-venue bid/ask spread for an asset |
| **Which pairs currently have the highest volume, price changes, or liquidity?** | `GET /v1/screener` | `GET /screener?sortBy=volume&order=desc&limit=20&network=testnet` | Screen pairs by volume, change, liquidity and price |
| **What moved most today, up, down, or by volume?** | `GET /v1/movers` | `GET /movers?window=24h&limit=10&network=testnet` | Get biggest gainers, biggest losers, and volume movers |
| **How closely is a pegged or wrapped asset tracking its peg target?** | `GET /v1/benchmark/:asset` | `GET /benchmark/USDC?target=USD&network=testnet` | Get peg-deviation statistics for an asset against a target |
| **How do Lens aggregated prices compare against external oracles?** | `GET /v1/compare/:asset` | `GET /compare/XLM?network=testnet` | Compare Lens prices with every configured external oracle |
| **Over the past week, which oracle tracked the market most closely?** | `GET /v1/compare/:asset/summary` | `GET /compare/XLM/summary?window=7d&network=testnet` | Summary statistics per oracle over a window (mean deviation, worst deviation, time outside band) |
| **How has the gap between an oracle and the market moved over time?** | `GET /v1/compare/:asset/history` | `GET /compare/XLM/history?window=7d&network=testnet` | Query historical oracle comparison series and window summary statistics |
| **What is the weighted price of a custom portfolio basket of assets?** | `GET /v1/basket` | `GET /basket?asset=XLM&asset=USDC&weight=0.6&weight=0.4&network=testnet` | Compute the weighted price of a basket of assets |
| **Do these assets move together, or are they genuinely diversified?** | `GET /v1/correlation` | `GET /correlation?asset=XLM&asset=USDC&window=30d&network=testnet` | Compute price correlation matrix across a basket of assets over a window |
| **Which pairs disagree most across venues right now?** | `GET /v1/dispersion` | `GET /dispersion?network=testnet` | List cross-venue dispersion across watched pairs |
| **The venues disagree on this pair — which one is the outlier?** | `GET /v1/dispersion/:assetA/:assetB` | `GET /dispersion/XLM/USDC?network=testnet` | Get venue price dispersion and outlier attribution for a pair |
| **Is this pair trading above or below the centralised exchanges?** | `GET /v1/premium/:assetA/:assetB` | `GET /premium/XLM/USDC?network=testnet` | Get on-chain vs CEX price premium and spread |
| **Is this stablecoin still holding its peg?** | `GET /v1/pegs` | `GET /pegs?network=testnet` | Get peg deviation and window statistics for all configured pegged assets |
| **How much of the market can Lens actually see?** | `GET /v1/coverage` | `GET /coverage?network=testnet` | Get overall market coverage ratio and cross-venue activity |
| **For one asset, which venues is Lens watching and how much do they cover?** | `GET /v1/coverage/:asset` | `GET /coverage/XLM?network=testnet` | Get market coverage ratio and venue breakdown for a specific asset |

### Historical Trends & Robust Averages

| Question | Route | Example | Description |
|---|---|---|---|
| **What are the historical OHLCV candlestick bars for a trading pair?** | `GET /v1/candles/:assetA/:assetB` | `GET /candles/XLM/USDC?interval=1h&network=testnet` | Get OHLCV candle data |
| **What were the historical price buckets for a pair over a recent window?** | `GET /v1/price/:assetA/:assetB/history` | `GET /price/XLM/USDC/history?window=1h&network=testnet` | Get price history buckets |
| **Where can I query raw 1-minute historical snapshots or export them as CSV?** | `GET /v1/prices/history` | `GET /prices/history?pair=XLM/USDC&interval=1m&network=testnet` | Get historical 1-minute price snapshots |
| **What is the manipulation-resistant time-weighted average price (TWAP) for settlement?** | `GET /v1/price/twap/:assetA/:assetB` | `GET /price/twap/XLM/USDC?window=60&sampleInterval=60&method=iqr&network=testnet` | Get a manipulation-resistant time-weighted average price |
| **What is the volume-weighted average price (VWAP) across venues for a pair?** | `GET /v1/price/vwap/:assetA/:assetB` | `GET /price/vwap/XLM/USDC?window=60&source=SDEX&method=iqr&network=testnet` | Get a volume-weighted average price |

### Multi-Query & Streaming

| Question | Route | Example | Description |
|---|---|---|---|
| **How do I query multiple prices, routes, and analytics in a single GET request?** | `GET /v1/graphql` | `GET /graphql?query=%7Bprice%28assetA%3A%22XLM%22%2CassetB%3A%22USDC%22%29%7Bprice%7D%7D` | Execute a GraphQL query over HTTP GET |
| **How do I execute complex GraphQL operations or initiate WebSocket subscriptions?** | `POST /v1/graphql` | `POST /graphql` | Execute a GraphQL query, mutation or subscription handshake |

### System Health & Venue Infrastructure

| Question | Route | Example | Description |
|---|---|---|---|
| **Is the Lens indexer healthy, up to date, and what is the latest processed ledger?** | `GET /v1/status` | `GET /status?network=testnet` | Get API status and indexer state |
| **Which venue adapters (order books, AMMs, oracles) are registered and live?** | `GET /v1/venues/registry` | `GET /venues/registry?network=testnet` | List registered venues and their network liveness |
| **Is the service process alive at all?** | `GET /v1/live` | `GET /live` | Liveness probe |
| **Is it safe to send traffic yet, or are dependencies still starting?** | `GET /v1/ready` | `GET /ready` | Readiness probe |
| **How many requests have I made and what is my remaining API key quota?** | `GET /v1/usage/me` | `GET /usage/me` | Get usage and quota for the calling API key |
| **How much of my API quota have I used?** | `GET /v1/usage` | `GET /usage` | Get usage and quota for the calling API key (alias for /usage/me) |

### Automation, Discovery & Payments

| Question | Route | Example | Description |
|---|---|---|---|
| **What payable endpoints and datasets are discoverable in the x402 Bazaar catalog?** | `GET /v1/discovery/resources` | `GET /discovery/resources?network=testnet` | Browse the x402 Bazaar catalog of discoverable resources |
| **Can I find the right endpoint by describing what I want in plain language?** | `GET /v1/discovery/search` | `GET /discovery/search?q=price%20of%20XLM%20in%20dollars&limit=5` | Natural language search with ranking and quality evaluation for discoverable resources |
| **Which payment schemes and token mechanisms does this x402 facilitator support?** | `GET /v1/supported` | `GET /supported` | List the payment kinds and extensions this facilitator supports |
| **How do I verify a signed x402 payment payload before fulfilling a service?** | `POST /v1/verify` | `POST /verify` | Verify an x402 payment payload |
| **How do I submit and settle an x402 payment on the Stellar network?** | `POST /v1/settle` | `POST /settle` | Settle an x402 payment (idempotent) |
| **How can my application receive push alerts when a price crosses a threshold?** | `POST /v1/webhooks` | `POST /webhooks` | Subscribe to a price-threshold webhook |
| **How do I cancel an existing price threshold alert webhook?** | `DELETE /v1/webhooks/:id` | `DELETE /webhooks/wh_9f8e7d6c5b4a3a2b1c?network=testnet` | Delete a webhook subscription |

---

## Provenance & Accuracy Guarantees

Every number returned by Lens carries provenance metadata:
- **Venues & Samples**: Responses indicate which venues (SDEX, AMM pools, oracles) were sampled.
- **Freshness & Ledger**: Timestamps and ledger numbers indicate the recency of each calculation.
- **Honest Answers**: If a pair has insufficient liquidity or an unmonitored window, Lens returns explicit empty states rather than deceptive zero values or 500 errors.
- **Full Contract Identifiers**: Stellar asset issuers and Soroban contract IDs are always rendered in full (e.g. `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`), never truncated.

## Drift Prevention

This document is compiled directly from [`openapi.yaml`](../openapi.yaml). CI tests in `tests/openapi.test.ts` assert:
1. Every registered Fastify route appears in the spec.
2. Every route operation declares a plain-English `x-question` and `x-example`.
3. This committed file matches the generator output byte-for-byte.

To regenerate this document after modifying `openapi.yaml`:
```bash
npm run index:gen
```
