# Lens — Unified Stellar Price API

[![CI](https://github.com/Miracle656/Lens/actions/workflows/ci.yml/badge.svg)](https://github.com/Miracle656/Lens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Stellar-SDEX%20%2B%20AMM-black)](https://stellar.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Aggregates price data from Stellar's Classic Order Book (SDEX) and AMM Liquidity Pools into a single, unified API.

**What Horizon doesn't do:** Horizon's `/trade_aggregations` only covers SDEX. AMM pool prices (derived from reserve ratios) are not aggregated anywhere. Lens fills this gap.

## Endpoints

### REST
| Method | Path | Description |
|---|---|---|
| GET | `/price/:assetA/:assetB` | Current VWAP, 24h volume, best route |
| GET | `/price/:assetA/:assetB/route?amount=1000` | Best execution route for a given amount |
| GET | `/price/:assetA/:assetB/history?window=1h` | OHLCV history (`1m`, `5m`, `1h`, `24h`) |
| GET | `/prices/history?pair=XLM/USDC&from=…&to=…&interval=1m` | Historical 1-minute price snapshots, optionally aggregated (`1m`, `5m`, `1h`); ~30-day retention |
| GET | `/pools` | Active AMM pools being watched |
| GET | `/pairs` | Watched trading pairs |
| GET | `/status` | Indexer health |
| GET | `/discovery/resources?type=&payTo=&network=&extensions=&limit=&offset=` | Bazaar catalog of x402-discoverable resources (spec: [`bazaar`](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md)) |

Every route accepts an optional `?network=testnet\|mainnet` query param (or
`x-network` header) to pick the Stellar network — default is `testnet`. An
unrecognised value gets `400`. `/price/:assetA/:assetB` — its VWAP, OHLCV, AMM
and best-route reads — and x402 payment `network`/`payTo` are per-request. The
candle, TWAP/VWAP, history, screener, pools and depth endpoints still read
across both networks and ignore the parameter.

```bash
curl "https://api.example.com/price/XLM/USDC?network=mainnet"
```

### GraphQL
Available at `/graphql` with GraphiQL IDE at `/graphiql`. Real-time price
streaming is available via the `priceUpdated` [subscription](#graphql-subscriptions-live-prices).

```graphql
query {
  getPrice(assetA: "XLM", assetB: "USDC") {
    price
    bestRoute
    vwap1h
    volume24h
    priceChange24h
  }
  getBestRoute(assetA: "XLM", assetB: "USDC", amount: 500) {
    route
    sdexPrice
    ammPrice
    estimatedOutput
    slippagePct
    recommendation
  }
}
```

## Observability

Prometheus metrics are exposed on `GET /metrics` (public, no API key required).

Alongside the ingestion and database metrics, Lens exports the three HTTP
signals needed to answer "is the API healthy":

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status_class` |
| `http_request_duration_seconds` | Histogram | `method`, `route` |

`route` is the matched route **template** (`/price/:assetA/:assetB`), never the
resolved URL, so the number of time series stays bounded no matter how many
distinct assets are queried. `status_class` is `2xx`/`4xx`/`5xx` rather than the
exact code, for the same reason.

```promql
# Request rate
sum(rate(http_requests_total[5m])) by (route)

# Error rate
sum(rate(http_requests_total{status_class="5xx"}[5m]))
  / sum(rate(http_requests_total[5m]))

# p95 latency
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
```

See [`docs/http-metrics.md`](docs/http-metrics.md) for the full label reference,
the bucket rationale and suggested alerting rules.

### GraphQL Subscriptions (live prices)

Lens exposes a `priceUpdated(pair)` subscription that pushes a message every time
an ingester (SDEX, Horizon AMM, or Soroswap) records a new price for the pair.
It runs over the same `/graphql` endpoint using the `graphql-transport-ws`
protocol, so any [`graphql-ws`](https://github.com/enisdenjo/graphql-ws) client works.

```graphql
subscription {
  priceUpdated(pair: "XLM/USDC", network: "mainnet") {
    pair
    price
    ts
    network
  }
}
```

```bash
npm install graphql-ws ws
```

```typescript
import { createClient } from "graphql-ws";
import WebSocket from "ws"; // browsers already have WebSocket globally

const client = createClient({
  url: "ws://localhost:3002/graphql",
  webSocketImpl: WebSocket, // omit in the browser
});

// `subscribe` returns an unsubscribe function — call it to close the channel.
const unsubscribe = client.subscribe(
  {
    query: `subscription ($pair: String!, $network: String) {
      priceUpdated(pair: $pair, network: $network) { pair price ts network }
    }`,
    variables: { pair: "XLM/USDC", network: "mainnet" },
  },
  {
    next: ({ data }) => console.log("price:", data.priceUpdated),
    error: (err) => console.error("subscription error:", err),
    complete: () => console.log("subscription closed"),
  },
);

// Later — stop receiving updates and close the socket cleanly:
// unsubscribe();
```

> **`network` is optional but you almost always want it.** Since #117 every
> enabled network runs its own ingester loop and they all publish to the same
> stream, so omitting it interleaves testnet and mainnet prices for the same
> pair. Every message carries its own `network` field, so an omitted argument
> is safe *if* you read that field — and misleading if you do not.

> **Note:** the `pair` argument is the canonical `pairKey` (alphabetically
> sorted, e.g. `XLM:native/USDC:GA5...`). Use the `listPairs` query to discover
> the exact keys being indexed. Only the pair you subscribe to is delivered;
> updates for other pairs are filtered out server-side.

## Usage Examples

Lens gates `/price`, `/pools`, and `/candles` behind x402 micropayments on Stellar (testnet by default). The `/status` endpoint is free.

### 1. Free health check (no payment)

```bash
curl http://localhost:3002/status
# {
#   "ok": true,
#   "watchedPairs": ["XLM:native/USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
#   "lastIndexedLedger": 53842917,
#   "lastProcessedAt": "2026-05-07T18:45:11.220Z"
# }
```

### 2. Paid request without `X-PAYMENT` → `402` with payment requirements

```bash
curl -i http://localhost:3002/price/XLM/USDC
# HTTP/1.1 402 Payment Required
# content-type: application/json
#
# {
#   "x402Version": 1,
#   "accepts": [
#     {
#       "scheme": "exact",
#       "price": "$0.10",
#       "network": "stellar:testnet",
#       "payTo": "G...your-oracle-address..."
#     }
#   ],
#   "error": "Payment required",
#   "description": "Unified SDEX+AMM price with VWAP and best route"
# }
```

The `accepts[]` array lists every payment requirement the server will honor. Sign one of them, encode as JSON, base64-encode, and resend with the `X-PAYMENT` header.

### 3. Paid request with `X-PAYMENT` → `200` with price data

```bash
# X-PAYMENT is base64(JSON(signed payment payload — see @x402/stellar))
curl -H "X-PAYMENT: $(cat payment.b64)" \
     http://localhost:3002/price/XLM/USDC
# {
#   "assetA": "XLM",
#   "assetB": "USDC",
#   "pairKey": "XLM:native/USDC:GA5...",
#   "vwap1m": "0.12450000",
#   "vwap1h": "0.12410000",
#   "volume24h": "1284390.5500",
#   "priceChange24h": "0.32",
#   "bestRoute": "amm",
#   "lastUpdated": "2026-05-07T18:46:02.114Z"
# }
```

### 4. Node.js — automatic payment with `@x402/fetch` + `@x402/stellar`

`@x402/fetch` wraps the native `fetch` so a `402` is intercepted, signed, and retried automatically — your application code looks like a normal request.

```bash
npm install @x402/fetch @x402/stellar
```

```typescript
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";

// 1. Sign with a Stellar testnet secret (S...). Fund via friendbot first.
const signer = createEd25519Signer(
  process.env.STELLAR_SECRET!, // e.g. "SBN...FUNDED..."
  "stellar:testnet",
);

// 2. Wrap fetch — `stellar:*` matches both pubnet and testnet.
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "stellar:*",
      client: new ExactStellarScheme(signer),
    },
  ],
});

// 3. Call the gated endpoint. The 402 → sign → 200 dance is automatic.
const res = await fetchWithPayment("http://localhost:3002/price/XLM/USDC");
const data = await res.json();
console.log(`XLM/USDC VWAP-1h: ${data.vwap1h}`);
```

> **Mainnet:** swap `STELLAR_NETWORK=mainnet` on the server, point the
> client at `stellar:pubnet`, and supply a custom Soroban RPC URL via
> `new ExactStellarScheme(signer, { url: "https://your-rpc..." })`.
> Stellar payments use *ledger-based* expiration (~12 ledgers ≈ 60s),
> not timestamps.

### 5. GraphQL price query

```bash
curl -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ getPrice(assetA:\"XLM\", assetB:\"USDC\") { price vwap1h volume24h priceChange24h } }"}'
```

Or interactively at [http://localhost:3002/graphiql](http://localhost:3002/graphiql).

> **Note:** the current `GATED_ROUTES` map in [`src/middleware/x402.ts`](src/middleware/x402.ts) gates `/price`, `/pools`, and `/candles` only — `/graphql` is not gated. If you intend price data from GraphQL to require the same payment as REST, extend `GATED_ROUTES` (or add a per-resolver guard).

## TypeScript Client

A typed TypeScript client is generated from [`openapi.yaml`](openapi.yaml) with
[`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript) and
[`openapi-fetch`](https://github.com/openapi-ts/openapi-typescript/tree/main/packages/openapi-fetch).
It is committed at [`clients/typescript`](clients/typescript) — **no type is
hand-written**, so a change to the spec is a change to the client.

```bash
# Regenerate clients/typescript/src/schema.d.ts from the spec
npm run client:gen

# Type-check the generated client
npm run client:typecheck
```

CI runs `npm run client:gen` and fails if the committed client differs from the
regenerated output, so the client can never drift from `openapi.yaml`.

```typescript
import { createLensClient } from "./clients/typescript/src/index.js";

const client = createLensClient({ baseUrl: "http://localhost:3002" });

const { data, error } = await client.GET("/price/{assetA}/{assetB}", {
  params: { path: { assetA: "XLM", assetB: "USDC" } },
});
if (error) throw new Error(`request failed: ${error}`);

// `data` is `AggregatedPrice`, derived from the spec.
console.log(`XLM/USDC vwap1h: ${data?.vwap1h}`);
```

A runnable version lives in
[`clients/typescript/src/example.ts`](clients/typescript/src/example.ts); run it
against a local server with `npx tsx clients/typescript/src/example.ts`.

## Documentation
Detailed system design and data flow diagrams can be found in the [Architecture Overview](docs/architecture.md).
The API specification is available in [OpenAPI 3.0 format](openapi.yaml) and is auto-published to GitHub Pages at https://miracle656.github.io/lens/openapi.json.

## Examples

The [oracle relay example](examples/oracle-relay/README.md) shows a minimal Soroban contract plus a Node relay that reads Lens prices and pushes them on chain.

The [price alert bot example](examples/alert-bot/README.md) shows an "if XLM > X notify me" bot built on the WebSocket price stream — see the [cookbook walkthrough](docs/cookbook/alert-bot.md).

## Docker Quickstart
The fastest way to get Lens running locally is with Docker:

```bash
# Start Lens, Postgres, and Redis
docker compose up -d

# Check health
docker compose ps
```
The API will be available at `http://localhost:3002`. Database migrations run automatically on startup.

## Quick Start (Manual)

```bash
# 1. Start PostgreSQL + Redis
docker-compose up -d

# 2. Install dependencies
npm install

# 3. Copy env
cp .env.example .env

# 4. Push database schema
npm run db:push

# 5. Start dev server
npm run dev
```

## Environment Variables

| Variable | Description | Default | Required |
|---|---|---|---|
| `NODE_ENV` | Environment mode (`development`, `test`, `production`) | `development` | No |
| `PORT` | API server port | `3002` | No |
| `HOST` | API server host | `0.0.0.0` | No |
| `DATABASE_URL` | PostgreSQL connection string | - | **Yes** |
| `REDIS_URL` | Redis connection string | - | **Yes** |
| `PRICE_CACHE_TTL` | Cache duration for price data (seconds) | `10` | No |
| `HORIZON_URL` | Stellar Horizon server URL | - | No |
| `RPC_URL` | Soroban RPC server URL | - | No |
| `NETWORK_PASSPHRASE` | Stellar network passphrase | - | No |
| `STELLAR_NETWORK` | `mainnet` or `testnet` — this instance's default/ingested network | `testnet` | No |
| `POLL_INTERVAL_MS` | Indexer polling frequency (ms) | `5000` | No |
| `SDEX_PAGE_SIZE` | Trades per page for SDEX ingestion | `200` | No |
| `AMM_PAGE_SIZE` | Trades per page for AMM ingestion | `200` | No |
| `ADMIN_API_KEY` | Key for admin route authentication | - | No |
| `WATCHED_PAIRS` | Comma-separated list of asset pairs to index | - | **Yes** |
| `ORACLE_PAYMENT_ADDRESS` | Stellar address for x402 API payments | - | No* |
| `ORACLE_PAYMENT_ADDRESS_TESTNET` / `ORACLE_PAYMENT_ADDRESS_MAINNET` | Per-network override for the address above | - | No |
| `X402_FACILITATOR_URL` | x402 facilitator service URL | - | No |

*\*Required if enabling x402 payment gating.*

## Stack
- **Runtime:** Node.js 20 + TypeScript
- **API:** Fastify + Mercurius (GraphQL)
- **Database:** PostgreSQL + TimescaleDB
- **Cache:** Redis
- **Queue:** BullMQ
- **Stellar:** @stellar/stellar-sdk
