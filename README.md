# Lens — Unified Stellar Price API

[![CI](https://github.com/Divinity-Labs/Lens/actions/workflows/ci.yml/badge.svg)](https://github.com/Divinity-Labs/Lens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Stellar-SDEX%20%2B%20AMM-black)](https://stellar.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

## Quickstart

### REST

```bash
curl http://localhost:3002/status
# {
#   "ok": true,
#   "network": "testnet",
#   "watchedPairs": ["XLM:native/USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
#   "lastIndexedLedger": 53842917,  // illustrative — actual value depends on when /status is queried
#   "lastProcessedAt": "2026-05-07T18:45:11.220Z",  // illustrative — actual value depends on when /status is queried
#   "ingestLagSeconds": 4  // illustrative — actual value depends on when /status is queried
# }
#
# /status answers for one network — pass ?network=mainnet (or the
# x-network header) to check the mainnet indexer instead. ingestLagSeconds is
# null until that network has ingested, and lastIndexedLedger is null until
# its SDEX ingester has recorded a trade.
```

### GraphQL

```bash
curl -X POST http://localhost:3002/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ getPrice(assetA:\"XLM\", assetB:\"USDC\") { price assetA assetB pairKey bestRoute lastUpdated } }"}'
# {
#   "data": {
#     "getPrice": {
#       "price": 0.1245,
#       "assetA": "XLM",
#       "assetB": "USDC",
#       "pairKey": "XLM:native/USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
#       "bestRoute": "amm",
#       "lastUpdated": "2026-05-07T18:46:02.114Z"
#     }
#   }
# }
```

### MCP

```bash
# By default the MCP server speaks over stdin and stdout and listens on no
# port; MCP_TRANSPORT=http serves Streamable HTTP on MCP_HTTP_PORT instead
# (see "MCP server" below). Port 3002 is the HTTP API, which knows nothing
# about MCP either way.
npm run mcp:server

# To drive it interactively, point the inspector at that command:
npx @modelcontextprotocol/inspector npm run mcp:server
# Tools and the keys it needs: examples/mcp-server/README.md
# [
#   {
#     "name": "bazaar_search",
#     "description": "Search for resources in a Stellar Bazaar node"
#   },
#   {
#     "name": "paid_call",
#     "description": "Make a paid API call to a Bazaar resource"
#   }
# ]
```

**What Horizon doesn't do:** Horizon's `/trade_aggregations` only covers SDEX. AMM pool prices (derived from reserve ratios) are not aggregated anywhere. Lens fills this gap.

## Venues

<!-- VENUES:START -->
| Venue | Source | Type | Description |
|---|---|---|---|
| SDEX | `SDEX` | Order Book | Stellar's Classic Order Book (SDEX) |
| AMM | `AMM` | Liquidity Pool | Stellar native AMM liquidity pools (Horizon) |
| Soroswap | `soroswap_amm` | AMM DEX | Soroswap constant-product automated market maker on Soroban |
| Aquarius | `aquarius_amm` | Liquidity Pool | Aquarius AMM liquidity pools |
| DeFindex | `defindex_vault` | Vault | DeFindex yield vaults on Soroban, priced per share |
| Phoenix | `phoenix_amm` | Liquidity Pool | Phoenix AMM pools on Soroban |
<!-- VENUES:END -->

## Endpoints

### REST
<!-- ENDPOINTS:START -->
| Method | Path | Description |
|---|---|---|
| GET | `/v1/venues/registry` | List registered venues and their network liveness |
| GET | `/v1/venues` | Venue Share of Volume |
| GET | `/v1/live` | Liveness probe |
| GET | `/v1/tvl` | Total Value Locked across Stellar DeFi venues |
| GET | `/v1/ready` | Readiness probe |
| GET | `/v1/status` | Get API status and indexer state |
| GET | `/v1/snapshot` | Whole-network snapshot (venues, TVL, 24h volume, top pairs, pegs, freshness) |
| GET | `/v1/price/:assetA/:assetB` | Get aggregated price for a pair |
| GET | `/v1/premium/:assetA/:assetB` | Get on-chain vs CEX price premium and spread |
| GET | `/v1/price/:assetA/:assetB/route` | Get best swap route for a pair and amount |
| GET | `/v1/price/:asset/fiat` | Convert asset price to fiat currency with NGN support (#290) |
| GET | `/v1/price/:assetA/:assetB/history` | Get price history buckets |
| GET | `/v1/pools` | Get AMM liquidity pool reserves and spot prices |
| GET | `/v1/candles/:assetA/:assetB` | Get OHLCV candle data |
| GET | `/v1/prices/history` | Get historical 1-minute price snapshots |
| GET | `/v1/pairs` | List all active trading pairs |
| POST | `/v1/pairs` | Add a new trading pair (Admin only) |
| GET | `/v1/price/:assetA/:assetB/depth` | Get order-book depth and execution slippage for a pair |
| GET | `/v1/book/:assetA/:assetB` | Get the aggregated SDEX and AMM price ladder for a pair |
| GET | `/v1/impact/:assetA/:assetB` | Get an adaptive slippage impact curve for a pair |
| GET | `/v1/price/twap/:assetA/:assetB` | Get a manipulation-resistant time-weighted average price |
| GET | `/v1/price/vwap/:assetA/:assetB` | Get a volume-weighted average price |
| GET | `/v1/volumes/:asset` | Get cross-venue traded volume for an asset |
| GET | `/v1/coverage` | Get overall market coverage ratio and cross-venue activity |
| GET | `/v1/coverage/:asset` | Get market coverage ratio and venue breakdown for a specific asset |
| GET | `/v1/spreads/:asset` | Get the tightest per-venue bid/ask spread for an asset |
| GET | `/v1/rates/:asset` | Get supply and borrow rates for an asset across lending venues |
| GET | `/v1/dispersion/:assetA/:assetB` | Get venue price dispersion and outlier attribution for a pair |
| GET | `/v1/dispersion` | List cross-venue dispersion across watched pairs |
| GET | `/v1/compare/:asset` | Compare Lens prices with every configured external oracle |
| GET | `/v1/compare/:asset/history` | Query historical oracle comparison series and window summary statistics |
| GET | `/v1/compare/:asset/summary` | Summary statistics per oracle over a window (mean deviation, worst deviation, time outside band) |
| GET | `/v1/screener` | Screen pairs by volume, change, liquidity and price |
| GET | `/v1/movers` | Get biggest gainers, biggest losers, and volume movers |
| GET | `/v1/benchmark/:asset` | Get peg-deviation statistics for an asset against a target |
| GET | `/v1/pegs` | Get peg deviation and window statistics for all configured pegged assets |
| GET | `/v1/basket` | Compute the weighted price of a basket of assets |
| GET | `/v1/correlation` | Compute price correlation matrix across a basket of assets over a window |
| GET | `/v1/discovery/resources` | Browse the x402 Bazaar catalog of discoverable resources |
| GET | `/v1/discovery/search` | Natural language search with ranking and quality evaluation for discoverable resources |
| POST | `/v1/webhooks` | Subscribe to a price-threshold webhook |
| DELETE | `/v1/webhooks/:id` | Delete a webhook subscription |
| GET | `/v1/usage/me` | Get usage and quota for the calling API key |
| GET | `/v1/usage` | Get usage and quota for the calling API key (alias for /usage/me) |
| GET | `/v1/supported` | List the payment kinds and extensions this facilitator supports |
| POST | `/v1/verify` | Verify an x402 payment payload |
| POST | `/v1/settle` | Settle an x402 payment (idempotent) |
| GET | `/v1/graphql` | Execute a GraphQL query over HTTP GET |
| POST | `/v1/graphql` | Execute a GraphQL query, mutation or subscription handshake |
| GET | `/v1/rates` | Query latest lending and borrow rates across pools |
| GET | `/v1/assets` | List tracked assets with metadata and verification status |
| GET | `/v1/assets/:code` | Get metadata and verification status for a specific asset |
<!-- ENDPOINTS:END -->

The table above is generated from [`openapi.yaml`](openapi.yaml) by `npm run openapi:gen`;
edit the spec rather than the table. CI runs `npm run readme:check` and fails when
the committed table differs from a fresh generation.

<!-- QUESTION_INDEX_START -->
| Question | Route | Example |
|---|---|---|
| What is the current market price and 24-hour volume for an asset pair? | `GET /v1/price/:assetA/:assetB` | `GET /price/XLM/USDC?network=testnet` |
| Where can I execute a swap for the best return at a given trade size? | `GET /v1/price/:assetA/:assetB/route` | `GET /price/XLM/USDC/route?amount=1000&network=testnet` |
| What does the combined order book look like across SDEX and AMM liquidity pools? | `GET /v1/book/:assetA/:assetB` | `GET /book/XLM/USDC?depth=0.1&step=0.01&network=testnet` |
| What is the simulated order-book depth and expected slippage for a trade size? | `GET /v1/price/:assetA/:assetB/depth` | `GET /price/XLM/USDC/depth?amount=1000&network=testnet` |
| How does slippage grow as my trade size increases? | `GET /v1/impact/:assetA/:assetB` | `GET /impact/XLM/USDC?network=testnet` |
| What is this asset worth in my local currency, such as naira? | `GET /v1/price/:asset/fiat` | `GET /price/XLM/fiat?currency=NGN&network=testnet` |
| Which trading pairs are currently tracked by Lens on the active network? | `GET /v1/pairs` | `GET /pairs?network=testnet` |
| How do I configure Lens to track a new trading pair? | `POST /v1/pairs` | `POST /pairs` |
| Which AMM liquidity pools are being watched, and what are their reserves? | `GET /v1/pools` | `GET /pools?network=testnet` |
| Which assets does Lens track, and which issuers are verified? | `GET /v1/assets` | `GET /assets?network=testnet` |
| Who issues this asset, and can I trust that issuer? | `GET /v1/assets/:code` | `GET /assets/USDC?network=testnet` |
| What is the total cross-venue trading volume for an asset over time? | `GET /v1/volumes/:asset` | `GET /volumes/XLM?window=24h&network=testnet` |
| How much value is locked across Stellar DeFi, and in which venues? | `GET /v1/tvl` | `GET /tvl?network=testnet` |
| Which venue is actually carrying the trading volume? | `GET /v1/venues` | `GET /venues?window=24h&network=testnet` |
| Can I get the whole market in one request instead of ten? | `GET /v1/snapshot` | `GET /snapshot?network=testnet` |
| What can I earn lending, and what does borrowing cost, across venues? | `GET /v1/rates` | `GET /rates?network=testnet` |
| What are the supply and borrow rates for one asset on each lending venue? | `GET /v1/rates/:asset` | `GET /rates/USDC?network=testnet` |
| Which venues offer the tightest bid/ask spread for an asset right now? | `GET /v1/spreads/:asset` | `GET /spreads/XLM?window=5m&network=testnet` |
| Which pairs currently have the highest volume, price changes, or liquidity? | `GET /v1/screener` | `GET /screener?sortBy=volume&order=desc&limit=20&network=testnet` |
| What moved most today, up, down, or by volume? | `GET /v1/movers` | `GET /movers?window=24h&limit=10&network=testnet` |
| How closely is a pegged or wrapped asset tracking its peg target? | `GET /v1/benchmark/:asset` | `GET /benchmark/USDC?target=USD&network=testnet` |
| How do Lens aggregated prices compare against external oracles? | `GET /v1/compare/:asset` | `GET /compare/XLM?network=testnet` |
| Over the past week, which oracle tracked the market most closely? | `GET /v1/compare/:asset/summary` | `GET /compare/XLM/summary?window=7d&network=testnet` |
| How has the gap between an oracle and the market moved over time? | `GET /v1/compare/:asset/history` | `GET /compare/XLM/history?window=7d&network=testnet` |
| What is the weighted price of a custom portfolio basket of assets? | `GET /v1/basket` | `GET /basket?asset=XLM&asset=USDC&weight=0.6&weight=0.4&network=testnet` |
| Do these assets move together, or are they genuinely diversified? | `GET /v1/correlation` | `GET /correlation?asset=XLM&asset=USDC&window=30d&network=testnet` |
| Which pairs disagree most across venues right now? | `GET /v1/dispersion` | `GET /dispersion?network=testnet` |
| The venues disagree on this pair — which one is the outlier? | `GET /v1/dispersion/:assetA/:assetB` | `GET /dispersion/XLM/USDC?network=testnet` |
| Is this pair trading above or below the centralised exchanges? | `GET /v1/premium/:assetA/:assetB` | `GET /premium/XLM/USDC?network=testnet` |
| Is this stablecoin still holding its peg? | `GET /v1/pegs` | `GET /pegs?network=testnet` |
| How much of the market can Lens actually see? | `GET /v1/coverage` | `GET /coverage?network=testnet` |
| For one asset, which venues is Lens watching and how much do they cover? | `GET /v1/coverage/:asset` | `GET /coverage/XLM?network=testnet` |
| What are the historical OHLCV candlestick bars for a trading pair? | `GET /v1/candles/:assetA/:assetB` | `GET /candles/XLM/USDC?interval=1h&network=testnet` |
| What were the historical price buckets for a pair over a recent window? | `GET /v1/price/:assetA/:assetB/history` | `GET /price/XLM/USDC/history?window=1h&network=testnet` |
| Where can I query raw 1-minute historical snapshots or export them as CSV? | `GET /v1/prices/history` | `GET /prices/history?pair=XLM/USDC&interval=1m&network=testnet` |
| What is the manipulation-resistant time-weighted average price (TWAP) for settlement? | `GET /v1/price/twap/:assetA/:assetB` | `GET /price/twap/XLM/USDC?window=60&sampleInterval=60&method=iqr&network=testnet` |
| What is the volume-weighted average price (VWAP) across venues for a pair? | `GET /v1/price/vwap/:assetA/:assetB` | `GET /price/vwap/XLM/USDC?window=60&source=SDEX&method=iqr&network=testnet` |
| How do I query multiple prices, routes, and analytics in a single GET request? | `GET /v1/graphql` | `GET /graphql?query=%7Bprice%28assetA%3A%22XLM%22%2CassetB%3A%22USDC%22%29%7Bprice%7D%7D` |
| How do I execute complex GraphQL operations or initiate WebSocket subscriptions? | `POST /v1/graphql` | `POST /graphql` |
| Is the Lens indexer healthy, up to date, and what is the latest processed ledger? | `GET /v1/status` | `GET /status?network=testnet` |
| Which venue adapters (order books, AMMs, oracles) are registered and live? | `GET /v1/venues/registry` | `GET /venues/registry?network=testnet` |
| Is the service process alive at all? | `GET /v1/live` | `GET /live` |
| Is it safe to send traffic yet, or are dependencies still starting? | `GET /v1/ready` | `GET /ready` |
| How many requests have I made and what is my remaining API key quota? | `GET /v1/usage/me` | `GET /usage/me` |
| How much of my API quota have I used? | `GET /v1/usage` | `GET /usage` |
| What payable endpoints and datasets are discoverable in the x402 Bazaar catalog? | `GET /v1/discovery/resources` | `GET /discovery/resources?network=testnet` |
| Can I find the right endpoint by describing what I want in plain language? | `GET /v1/discovery/search` | `GET /discovery/search?q=price%20of%20XLM%20in%20dollars&limit=5` |
| Which payment schemes and token mechanisms does this x402 facilitator support? | `GET /v1/supported` | `GET /supported` |
| How do I verify a signed x402 payment payload before fulfilling a service? | `POST /v1/verify` | `POST /verify` |
| How do I submit and settle an x402 payment on the Stellar network? | `POST /v1/settle` | `POST /settle` |
| How can my application receive push alerts when a price crosses a threshold? | `POST /v1/webhooks` | `POST /webhooks` |
| How do I cancel an existing price threshold alert webhook? | `DELETE /v1/webhooks/:id` | `DELETE /webhooks/wh_9f8e7d6c5b4a3a2b1c?network=testnet` |
<!-- QUESTION_INDEX_END -->
Every non-internal route above has a matching entry in [`openapi.yaml`](openapi.yaml);
`tests/openapi.test.ts` boots the server and fails if a registered route is
missing from the spec. Operator-only and non-HTTP routes (`/admin/keys*`,
`/admin/usage*`, `/admin/webhook-delivery-failures`, `/metrics`, `/ws`, `/graphiql*`) are deliberately excluded via
the commented allow-list in [`src/openapi/coverage.ts`](src/openapi/coverage.ts).
In addition, live service responses are verified against their published schemas on a daily schedule (`05:00 UTC`) via `npm run spec:validate-live` — see [docs/live-spec-validation.md](docs/live-spec-validation.md).

All routes are partitioned into three security and CORS tiers (`public`, `credentialed`, and `admin`) with a split CORS policy — see the [Route Classification & CORS Guide](docs/routes.md).

## API-key authentication

Client API keys must be sent as `Authorization: Bearer <key>`; `X-API-Key` is **not supported**. A key cannot be supplied as a query parameter. The admin credential is separate: set `ADMIN_TOKEN` on the server and send it in `X-Admin-Token` (or Bearer with the *admin* token) when creating or revoking keys. Admin routes bypass client-key auth but enforce their own admin authorization.

To create a key and inspect its usage on a locally configured Lens server, run this example in a shell that has `ADMIN_TOKEN` set to the **same value used by the running server**. No real key is included here:

```bash
export LENS_URL="http://localhost:3002"
test -n "$ADMIN_TOKEN" || { echo "Set ADMIN_TOKEN first" >&2; exit 1; }
RESPONSE="$(curl --fail-with-body -sS -X POST "$LENS_URL/admin/keys" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"label":"example-client","ratePerMin":60,"ratePerDay":10000}')"
API_KEY="$(printf '%s' "$RESPONSE" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).key))')"
curl --fail-with-body -sS "$LENS_URL/usage/me" -H "Authorization: Bearer $API_KEY"
```

The key is returned in plaintext **only in the creation response**. Lens stores its deterministic SHA-256 hash, not plaintext, so save the returned credential securely. The key can later be revoked through `DELETE /admin/keys/:id` using its returned `id` and the admin token. Revoked or expired keys no longer authenticate. Optional `scopes` and `expiresAt` restrict a key; see the admin API for rotation and key listing.

`ratePerMin` (default **60**) and `ratePerDay` (default **10000**) are request-rate limits; a depleted request quota returns 429. Monetary metering uses `dailyQuotaCents` (default **500**) and `monthlyQuotaCents` (default **10000**) with `overagePolicy` (`block`, `charge_402`, or `allow_overage`). `GET /usage/me` shows the calling key's usage.

**Authentication errors:** an absent `Authorization` header produces HTTP 401 with `code: "missing"` and a message naming that header; a malformed or non-Bearer value produces `code: "malformed"`. Unknown, revoked, and expired credentials return distinct 401 codes. The table below enumerates them. An `X-API-Key` header alone is handled as missing. Admin authorization failures use `code: "admin_unauthorized"`.


The `?network=testnet\|mainnet` query param (or `x-network` header) selects the
Stellar network. It is validated on every request — an unrecognised value gets a
`400` — and defaults to this instance's `STELLAR_NETWORK`. Only the routes whose
spec entry declares a `network` parameter answer for the selected network; the
ones listed below still read a single instance-wide network.

Per-request today: `/price/:assetA/:assetB` (its VWAP, OHLCV, AMM and
best-route reads), `/price/:assetA/:assetB/route`, `/price/:assetA/:assetB/depth`, `/book/:assetA/:assetB`,
`/prices/history`, `/screener`, `/pools`, `/pairs`, `/spreads/:asset`,
`/volumes/:asset`, `/status`, and the x402 payment `network`/`payTo`. That list
is the same one `openapi.yaml` declares a `network` parameter on — if they ever
disagree, the spec is the thing to fix.

`GET /volumes/:asset` also reports the trade count, median trade size, largest
trade's volume share, and `volumeConcentration`. Concentration is the HHI: the
sum of squared individual trade volume shares (0 to 1; 1 means one trade
accounted for all volume). The `provenance` object gives the venues and
positive-volume sample count used and the total observed sample count
(including zero-volume rows), plus the latest trade time and its age at the
response's `endTime`.
When the window has no trades, or its samples have no positive volume, derived
size and concentration metrics are `null` and `status` explains why.

Still reading across both networks, and ignoring the parameter:
`/candles/:assetA/:assetB`, `/price/twap/*`, and `/price/vwap/*`.

### API key authentication errors

API-key authentication failures return HTTP 401 with a machine-readable `code`:

| Code | Meaning |
|---|---|
| `missing` | No Authorization header was supplied. |
| `malformed` | The Authorization header is not a valid Bearer header. |
| `unknown` | The key was not recognized; never-issued and unknown keys have the same response. |
| `revoked` | The recognized key has been revoked. |
| `expired` | The recognized key has passed its expiry time. |

Unknown keys always receive the same response, regardless of whether the key
ever existed. Admin-token failures use `admin_unauthorized`.

Admin key creation accepts an optional future ISO date-time in `expiresAt`.
Omitting it creates a key without an expiry.

```bash
curl "https://api.example.com/price/XLM/USDC?network=mainnet"
```

### Data Quality Guarantees
For formal guarantees on pricing freshness (including the 300s staleness threshold), completeness (venue diversity and outlier filtering), precision (PostgreSQL Decimal(36,18) and negotiated decimal strings), venue inclusion across SDEX and AMMs, and deterministic violation semantics, see [`docs/data-quality.md`](docs/data-quality.md).

### GraphQL
Available at `/graphql` with GraphiQL IDE at `/graphiql`. Real-time price
streaming is available via the `priceUpdated` [subscription](#graphql-subscriptions-live-prices).

For complete GraphQL schema documentation, all queries with runnable `curl` examples, WebSocket `graphql-transport-ws` handshake specifications, and an explicit comparison against the REST surface, see [`docs/graphql.md`](docs/graphql.md).

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

#### Schema Definition & SDL Artifact
The GraphQL schema is exported as a canonical Schema Definition Language (SDL) artifact committed at [`schema.graphql`](schema.graphql).

- **Location**: [`schema.graphql`](schema.graphql)
- **Regenerate / Refresh**:
  ```bash
  npm run graphql:schema:gen
  ```
- **Drift Guard & Validation**: CI runs `src/__tests__/graphqlSchemaDrift.test.ts` to assert that `schema.graphql` matches the code-defined schema in `src/api/graphql.ts`, guarantees deterministic output, validates SDL syntax for client generators, and detects breaking schema changes.


## Observability

Prometheus metrics are exposed on `GET /metrics` (public, no API key required).
The MCP server is a separate process with its own `GET /metrics` on its own
port, and that one does require its bearer token — see
[MCP server](#mcp-server).

Alongside the ingestion and database metrics, Lens exports HTTP request,
latency, authentication and rate-limit signals:

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status_class` |
| `http_request_duration_seconds` | Histogram | `method`, `route` |
| `api_key_auth_failures_total` | Counter | `reason` |
| `admin_auth_failures_total` | Counter | — |
| `rate_limit_rejections_total` | Counter | `scope` |
| `global_shed_requests_total` | Counter | — |

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

The websocket stream carries its own signals — `ws_clients_total`,
`ws_messages_sent_total`, `ws_messages_dropped_total`, `ws_clients_dropped_total`
and `ws_buffered_bytes` — which exist to make slow subscribers visible instead
of silent. See [`docs/websocket-backpressure.md`](docs/websocket-backpressure.md).

The ingestion metrics are labelled by `network` as well, so a dual-network
deployment reports each network separately:

| Metric | Type | Labels |
|---|---|---|
| `trades_ingested_total` | Counter | `pair`, `network` |
| `amm_snapshots_total` | Counter | `pool`, `network` |
| `price_snapshots_total` | Counter | `network` |
| `last_trade_timestamp` | Gauge | `pair`, `network` |

`last_trade_timestamp` is a gauge, so without the `network` label one network's
ingester overwrites the other's value for the same pair — which would make the
staleness signal silently unusable. See
[`docs/ingest-metrics.md`](docs/ingest-metrics.md) for the cardinality notes
(`pairs x networks`) and a staleness alert.

### Database Connection Pool & Shared Architecture

> **Important architectural note**: The ingester loops (SDEX, AMM, Soroswap, Snapshot, Aquarius), background workers (retention, partitions), and the HTTP/GraphQL API handlers **run in a single process and share one connection pool**.

Because deployments often scale across multiple instances, total database connections against Postgres equal:
$$\text{Total Connections} = \text{Instances} \times \text{DB\_POOL\_SIZE} + \text{Superuser/Admin Headroom}$$

Configure `DB_POOL_SIZE` and `DB_POOL_TIMEOUT_MS` appropriately so the aggregate across all running instances stays safely beneath PostgreSQL's `max_connections` (typically 100).

Pool utilisation and exhaustion metrics are exposed on `GET /metrics`:
- `db_pool_connections_in_use`: Number of active connections checked out.
- `db_pool_connections_idle`: Number of idle connections ready in pool.
- `db_pool_connections_waiting`: Requests queued waiting for an available connection.
- `db_pool_exhaustion_errors_total`: Counter incremented whenever connection acquisition times out. Requests encountering pool exhaustion fail with an explicit `503 Service Unavailable` (`DB_POOL_EXHAUSTED`) rather than generic latency or unhandled timeouts.

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
> sorted, e.g. `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM`). Use the `listPairs` query to discover
> the exact keys being indexed. Only the pair you subscribe to is delivered;
> updates for other pairs are filtered out server-side. For full protocol handshake details and a raw WebSocket implementation, see [`docs/graphql.md`](docs/graphql.md#live-price-subscriptions-graphql-transport-ws).

## Venue Price Dispersion & Reconciliation

When multiple venues quote the same pair, their prices naturally diverge due to market dynamics and arbitrage opportunities. Lens periodically reconciles quotes across venues to detect unhealthy price dispersion or stale/faulty feeds:

* **Dispersion Metric:** Measured as the **Maximum Absolute Percentage Deviation (MAPD)** from the median:
  $$\text{deviationPct}_i = \frac{|p_i - \text{median}|}{\text{median}} \times 100$$
  The venue with the maximum deviation is designated as the outlying venue. The median is chosen because it resists extreme skew from rogue or corrupted prints.
* **Freshness Window:** Quotes older than `RECONCILIATION_FRESHNESS_SECONDS` (default: `300s` / 5 minutes) are excluded from the median and dispersion calculations, but their names are recorded in `staleVenues` so missing feeds remain visible.
* **Edge Cases:**
  * **Single-Venue Pair:** Dispersion is not meaningful. Recorded explicitly with `status: "insufficient_venues"` without computing a fake zero or raising an alert.
  * **Two-Venue Pair:** Both venues sit equidistant from their midpoint. Deterministic alphabetical tie-breaking picks the outlying venue, and `isAmbiguous: true` is flagged.
  * **Defensive Math:** Non-positive and non-finite quotes are discarded defensively.
* **Alerting & Suppression:**
  * When dispersion exceeds `RECONCILIATION_THRESHOLD_PCT` (default: `2.0%`, with optional per-pair overrides via `RECONCILIATION_PAIR_THRESHOLDS`), an alert is delivered to registered webhooks for the pair and emitted on `priceEmitter` (`dispersion:alert`).
  * Alerts include the pair, dispersion %, threshold %, and the outlying venue by name.
  * Cooldown suppression (`RECONCILIATION_ALERT_COOLDOWN_SECONDS`, default: `300s`) prevents duplicate alerts while elevated dispersion persists, automatically resetting once prices converge back within threshold.
* **Querying Dispersion:**
  * `GET /dispersion/:assetA/:assetB?from=…&to=…&limit=50&network=testnet`
  * `GET /dispersion?pair=XLM/USDC&network=mainnet`
## MCP server

`npm run mcp:server` starts the Bazaar MCP server ([src/mcp/server.ts](src/mcp/server.ts), wired up in [examples/mcp-server/run.ts](examples/mcp-server/run.ts)). It advertises:

| Tool | What it does | Spends? |
| --- | --- | --- |
| `bazaar_search` | Reads a Bazaar base URL's `/discovery/resources` or `/discovery/search?q=` and lists what is available. | No |
| `paid_call` | Fetches an x402-gated URL and handles the `402 → sign → retry` loop. | **Yes — it signs with a real Stellar key** |
| `payment_budget` | Reports the configured limits and what is left of today's budget. | No |
| `lens_get_price` | Reads Lens's own aggregated price for a watched pair. | No |
| `lens_quote` | What one order of a size the caller names would cost: the best route, the order-book depth and the price-impact ladder, in one answer. | No |
| `lens_list_pairs` | Lists the pairs watched on one network, one bounded page at a time, each with its latest price and the issuer of both assets in full. | No |
| `lens_get_pools` | Lists AMM pools with their newest reserves, spot price and fee — how much liquidity stands behind a pair. | No |
| `lens_screen_pairs` | Ranks watched pairs by volume, 24h change, price or liquidity, with the same filters as `GET /screener`. | No |

`payment_budget` appears whenever a spend budget is configured, which the example always sets, and `lens_get_price` only where the server can reach Lens's own price data. The three data tools follow the same rule: they are advertised only where the host supplies Lens's data, and each one runs the very function its REST route runs, so a page over MCP is the same rows and cursor as a page over HTTP. `lens_quote` follows it on the pricing side: it is advertised only where the host can read Lens's markets, and its three legs are the very calls `GET /price/:assetA/:assetB/route`, `GET /price/:assetA/:assetB/depth` and `GET /impact/:assetA/:assetB` make, so one quote over MCP is the same route, depth and impact the three HTTP requests return — at the order size the caller names instead of a fixed 1000. A leg that cannot price the order arrives as a qualified part of the answer (`depth.status: "unavailable"` with its reason, or `impact: null`), never as a zero and never as a failed call; only a read that outright fails answers `ERR_SERVICE_UNREACHABLE`, which means retry. Every one of them is served over **either** transport, and the tool list, schemas and error codes are identical whichever you pick. Which transport runs is selected by configuration; **stdio is the default**, so an existing setup needs no changes.

**⚠️ Warning:** the mainnet key signs with real XLM. Read the configuration,
spending warning, and worked example before running.

The server signs with a real Stellar key, so it needs `MCP_AGENT_SECRET_KEY_TESTNET`
and `MCP_AGENT_SECRET_KEY_MAINNET` in the environment — keep them in `.env`
(`run.ts` loads it with `dotenv`) rather than in a shell history line or a
client config file that gets shared. Never commit them. Optional spend
controls: `MCP_MAX_PAYMENT_PRICE` (per call, default `$1.00`),
`MCP_DAILY_SPEND_CEILING` (default `$10.00`) and `MCP_SPEND_STATE_FILE` — the
running total survives a restart, because a restart does not refund what the
previous process spent.

Full documentation: [examples/mcp-server/README.md](examples/mcp-server/README.md)

### stdio (default)

For a client that spawns the server itself as a child process — Claude
Desktop, Cursor, or the runnable [agent example](examples/mcp-server/agent.ts)
(`npm run mcp:agent`, which prints discovery and a paid call end to end).

```bash
npm run mcp:server   # reads MCP_TRANSPORT=stdio, talks JSON-RPC on stdin/stdout
```

Point a client at the command — the keys come from `.env`, so nothing secret
has to be written into client config. This is the same invocation
[agent.ts](examples/mcp-server/agent.ts) uses:

```json
{
  "mcpServers": {
    "lens-bazaar": {
      "command": "npx",
      "args": ["tsx", "examples/mcp-server/run.ts"]
    }
  }
}
```

Because the process is spawned by the client, there is no port, no token and
no remote attack surface: whoever can spawn it can spend, so keep it to
your own machine.

### Streamable HTTP

For a client that connects over the network instead of spawning a process —
a hosted agent, a shared dev box, a container. Set `MCP_TRANSPORT=http`:

```bash
# MCP_AGENT_SECRET_KEY_TESTNET / MCP_AGENT_SECRET_KEY_MAINNET live in .env
export MCP_TRANSPORT=http
export MCP_HTTP_AUTH_TOKEN="$(openssl rand -hex 32)"   # required, see below
export MCP_HTTP_HOST=127.0.0.1                   # default
export MCP_HTTP_PORT=3003                        # default
export MCP_HTTP_PATH=/mcp                        # default
npm run mcp:server
# [mcp-server] Listening at http://127.0.0.1:3003/mcp
```

**Authentication is mandatory and fails closed.** Without a non-empty
`MCP_HTTP_AUTH_TOKEN` the process exits before it builds a signer, so an
unauthenticated remote server with `paid_call` on its tool list can never come
up. Every request must then carry it as a bearer token; anything else gets a
JSON-RPC error with `ERR_UNAUTHORIZED` and is rejected before the payment path
is reached:

```bash
curl -sS -X POST http://127.0.0.1:3003/mcp \
  -H "Authorization: Bearer $MCP_HTTP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A client connects the same way:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3003/mcp'), {
  requestInit: { headers: { authorization: `Bearer ${process.env.MCP_HTTP_AUTH_TOKEN}` } },
});

const client = new Client({ name: 'lens-agent', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
```

Notes for this transport:

- It binds `127.0.0.1` unless you set `MCP_HTTP_HOST` deliberately. Do not
  expose it on a routable address over plain HTTP: the bearer token and every
  paid result cross the wire, so terminate TLS in a reverse proxy and forward
  to loopback.
- The token is a credential — the bearer who holds it can spend. Keep it out
  of URLs, logs, and shell history; rotate it if it leaks.
- Requests are stateless: no `Mcp-Session-Id` is issued and each `POST` is
  served by a fresh transport, so a client cannot hold a session open across
  requests. Every MCP message must be a `POST` (`GET` returns `405`, which
  spec-compliant clients treat as "no server-initiated stream"). Bodies are
  capped at 1 MiB.
- The daily spend ceiling is shared across everything this process serves, so
  one HTTP client cannot spend past a budget another one already used up.

#### Payment spend metrics

What the agent spent is scrapeable from the same listener, at `GET /metrics`,
guarded by the same bearer token — it is operator data about a key that moves
money, so there is no anonymous scrape:

```bash
curl -sS http://127.0.0.1:3003/metrics \
  -H "Authorization: Bearer $MCP_HTTP_AUTH_TOKEN"
```

| Metric | Type | Labels |
| --- | --- | --- |
| `mcp_payment_attempts_total` | Counter | `host`, `network`, `outcome` |
| `mcp_payment_amount_usd_total` | Counter | `host`, `network` |
| `mcp_payment_unquantified_total` | Counter | `host`, `network` |

A refused payment is an attempt (`outcome="failure"`) and adds nothing to
`mcp_payment_amount_usd_total`. `host` may only be a value from
`MCP_METRIC_HOSTS` and `network` only one from `MCP_METRIC_NETWORKS` (default
`stellar:testnet,stellar:pubnet` — the networks this server signs for):
Prometheus series are permanent, so anything outside an allow-list is reported
as `unknown` instead of letting one caller mint a time series per URL an agent
tries. Amounts that are not a USD money string cannot join the USD sum, so they
are counted in `mcp_payment_unquantified_total` rather than dropped silently.
Per-payment detail — full URL, transaction hash, asset, error code — is in the
`MCP_PAYMENT_LEDGER_FILE` audit trail, which keeps the real host whatever the
allow-list says.

`MCP_HTTP_PATH` cannot be `/metrics`; the process exits at boot rather than
answering MCP and Prometheus on one path. Under **stdio** there is no listener
to scrape, so read the running total from the `payment_budget` tool or the
audit file.

### WebSocket backpressure

`/ws` counts a message as sent only once the socket reports the write completed,
and bounds what a client that stops reading can cost: past 256 KiB of queued
bytes updates are coalesced to the newest one, past 1 MiB — or congested for 30s
— the client is closed with `1013` and counted. A truncated feed is visible in
`ws_messages_dropped_total` rather than silent, and one slow client cannot affect
any other. See [`docs/websocket-backpressure.md`](docs/websocket-backpressure.md).

## Time Model: Observation Time vs. Source Time

Lens separates observation time from source time to avoid conflating local ingestion wall-clock time with native blockchain or exchange timestamps:

* **`observed_at`** (`DateTime`, non-null): The UTC wall-clock timestamp when Lens recorded/ingested the sample.
* **`source_time`** (`DateTime?`, nullable): The native timestamp reported by the source venue itself. Null when the source has no native timestamp.
* **`ledger`** (`Int`): Stellar ledger sequence number, kept distinct from timestamp fields.

### Venue Capabilities

Every venue adapter explicitly declares its `sourceTimeCapability`:

| Venue / Adapter | Status | Semantic | Description |
|---|---|---|---|
| **SDEX** | `provided` | `ledger_close` | Horizon ledger close time of the executed trade. |
| **AMM (Trades)** | `provided` | `ledger_close` | Horizon ledger close time of the pool trade. |
| **AMM (Snapshots)** | `unavailable` | - | State snapshot; `source_time` is `null`. |
| **Soroswap AMM** | `unavailable` | - | Contract simulation; `source_time` is `null` (never backfilled with wall-clock). |
| **Aquarius AMM** | `unavailable` | - | API state snapshot; `source_time` is `null` (never backfilled with wall-clock). |
| **CEX Adapters** | `provided` | `exchange_timestamp` | Exchange-reported trade/ticker timestamp. |

### Bucketing Rationale

All candle aggregation (`/candles`), time windowing, TWAP, and VWAP calculations key on **`observed_at`** (observation time):

* **Cross-venue completeness**: State-only venues (Soroswap, Aquarius, AMM reserve snapshots) have no trade execution timestamps (`source_time = null`). Bucketing on `source_time` would drop or misrepresent state snapshots.
* **Monotonic reference clock**: `observed_at` provides a single monotonic time reference across all venues, preventing clock skew, reorg gaps, and polling latency skews from distorting aggregate candles.

## Usage Examples


Lens gates `/price`, `/pools`, and `/candles` behind x402 micropayments on Stellar (testnet by default). The `/status` endpoint is free.

### 1. Free health check & status monitoring (`/status`)

`/status` provides a structured, comprehensive health contract separating **process health** (runtime container, memory, uptime) from **data health** (ingestion currency, last ledger, ingest lag).

```bash
curl http://localhost:3002/status
```

```json
{
  "ok": true,
  "status": "healthy",
  "network": "testnet",
  "health": {
    "process": "healthy",
    "data": "healthy"
  },
  "process": {
    "uptimeSeconds": 86420,
    "memoryUsageMb": 18.42,
    "status": "healthy"
  },
  "data": {
    "lastIndexedLedger": 53842917,
    "lastProcessedAt": "2026-05-07T18:45:11.220Z",
    "ingestLagSeconds": 4,
    "isStale": false
  },
  "watchedPairs": ["XLM:native/USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
  "lastIndexedLedger": 53842917,
  "lastProcessedAt": "2026-05-07T18:45:11.220Z",
  "ingestLagSeconds": 4
}
```

#### Health Differentiation & Paging Conditions
- **Process Health vs Data Health:** The HTTP status code distinguishes service availability from data staleness.
  - `HTTP 200 OK` (`status: "healthy"`): Both process runtime and data feeds are functioning normally.
  - `HTTP 200 OK` (`status: "degraded"`, `health.data: "stale"`): The API server is healthy and responding, but ingestion lag exceeds 300 seconds. **Do not page engineers for intermittent upstream ledger delays.**
  - `HTTP 200 OK` (`status: "degraded"`, `health.process: "degraded"`): the port answers but boot has not finished, so not every ingester is running yet. Normal for the first seconds of a deploy — gate rollouts on `/ready`, which stays 503 until boot completes, rather than paging on this.
  - `HTTP 503 Service Unavailable` (`pagingCondition: "DATABASE_DOWN"`): Critical infrastructure failure (e.g. Postgres is down or unreachable). **Uptime monitors should page on HTTP 503.** The body carries `error: "Database unavailable"` and nothing more — `/status` is public, so the driver's own message (which can contain the host, the user and the connection string) goes to the server log only.

#### Monitoring Configuration Example (Datadog / Prometheus / BetterStack)
Configure your synthetic monitor / HTTP probe:
```yaml
# Prometheus Blackbox / Uptime monitor probe example
probe:
  target: "http://lens-api.internal:3002/status?network=mainnet"
  method: "GET"
  expect_status: 200
  alert_conditions:
    - severity: critical # Page on-call
      condition: "status_code == 503 || body.pagingCondition == 'DATABASE_DOWN'"
    - severity: warning  # Slack notification only
      condition: "body.health.data == 'stale' || body.data.ingestLagSeconds > 300"
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
#   "pairKey": "XLM:native/USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
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
Lens also *publishes* prices: [`docs/sep40-oracle-publisher.md`](docs/sep40-oracle-publisher.md) covers the SEP-40 contract in `oracle/contract/`, the deviation-and-interval publication policy in `src/publish/`, deployment, and key handling.
The API specification is available in [OpenAPI 3.0 format](openapi.yaml) and is auto-published to GitHub Pages at https://miracle656.github.io/lens/openapi.json.

Operators: start with the [Operations runbook](docs/RUNBOOK.md) — what runs, how each external dependency degrades, how to check ingestion health via `/status` and `/metrics`, the known failure modes with their symptoms, and deploy/rollback procedures.

Operational docs: [HTTP metrics](docs/http-metrics.md), [ingest metrics](docs/ingest-metrics.md), [websocket backpressure](docs/websocket-backpressure.md), [health probes](docs/health.md), [GraphQL](docs/graphql.md).
The MCP server also advertises read-only [resources](docs/mcp-resources.md) — the watched pairs, venues, this OpenAPI document, and service status — each with a stable URI and freshness an agent can cache against.

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

`docker compose ps` shows each service's health. `lens` reports `healthy` only once `/ready` is green — the server has finished booting, migrations are applied, and Postgres and Redis are reachable. Until then it shows `starting` (or `unhealthy` if boot fails), even though the process is already listening: `/status` answers as soon as the server listens, so it cannot tell you the stack is ready. `postgres` and `redis` have their own health checks, and Lens waits for both before starting.

## Quick Start (Manual)

```bash
# 1. Start PostgreSQL + Redis only — the compose file also defines the
#    Lens container, which would take port 3002 before step 6 starts it
docker-compose up -d postgres redis

# 2. Install dependencies
npm ci

# 3. Copy env
cp .env.example .env

# 4. Apply database migrations
npm run db:deploy

# 5. Seed the database with fixture data
npm run seed

# 6. Start dev server
npm run dev
```

## Seed & Query

A fresh clone gives an empty database — every price endpoint returns zeros and
you cannot tell working code from broken code. `npm run seed` writes
deterministic fixture data so the API is immediately usable.

### What it seeds

| Table | Rows per network | Description |
|---|---|---|
| `pair_configs` | 1 | Default pair registration so `/pairs` and `/price` resolve immediately |
| `price_points` | 36 (24 SDEX + 12 AMM) | Hourly SDEX trades and bi-hourly AMM trades over 24 h |
| `pool_snapshots` | 6 | AMM pool reserves every 4 h |
| `price_aggregates` | 49 (12×1m + 12×5m + 24×1h + 1×24h) | Pre-computed OHLCV buckets |

Data is seeded for the default pair on each network:
- **testnet:** `XLM / USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- **mainnet:** `XLM / USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`

### Usage

```bash
# Seed both networks (default)
npm run seed

# Seed a single network
npm run seed -- --network testnet
npm run seed -- --network mainnet
```

### Idempotency

The seed guarantees idempotency by **converging to the same deterministic row set**.
Timestamps are anchored to the current UTC hour (`Math.floor(Date.now() / 3_600_000) * 3_600_000`), keeping fixture data fresh relative to `NOW()` (satisfying service-level queries bounded by 1 h / 24 h intervals).

To prevent duplicate accumulation across runs while keeping timestamps fresh, re-seeding safely cleans up previously seed-owned rows (`where: { id: { startsWith: 'seed-' }, network }`) before inserting the fresh set. Default pair configs use `skipDuplicates: true` on `@@id([network, pairKey])` so existing pairs are preserved.

```
$ npm run seed

🌱 Lens seed complete

  testnet  (USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM)
    pair_configs     1 inserted (1 total)
    price_points     36 inserted (36 total)
    pool_snapshots   6 inserted (6 total)
    price_aggregates 49 inserted (49 total)

  mainnet  (USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM)
    pair_configs     1 inserted (1 total)
    price_points     36 inserted (36 total)
    pool_snapshots   6 inserted (6 total)
    price_aggregates 49 inserted (49 total)

  ✅ testnet: 1 pair_configs, 36 price_points, 6 pool_snapshots, 49 price_aggregates
  ✅ mainnet: 1 pair_configs, 36 price_points, 6 pool_snapshots, 49 price_aggregates

$ npm run seed   # re-seed: cleans seed rows & converges to the same row set

🌱 Lens seed complete

  testnet  (USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM)
    pair_configs     0 inserted (1 total)
    price_points     36 inserted (36 total)
    pool_snapshots   6 inserted (6 total)
    price_aggregates 49 inserted (49 total)

  mainnet  (USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM)
    pair_configs     0 inserted (1 total)
    price_points     36 inserted (36 total)
    pool_snapshots   6 inserted (6 total)
    price_aggregates 49 inserted (49 total)

  ✅ testnet: 1 pair_configs, 36 price_points, 6 pool_snapshots, 49 price_aggregates
  ✅ mainnet: 1 pair_configs, 36 price_points, 6 pool_snapshots, 49 price_aggregates
```

### Verify with the API

After seeding, start the server (`npm run dev`) and confirm the endpoints
return real data:

```bash
# /pairs — lists watched pairs with latest price
curl -s http://localhost:3002/pairs | jq '.pairs[0]'
# {
#   "pairKey": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM",
#   "assetA": { "code": "XLM", "issuer": null },
#   "assetB": { "code": "USDC", "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
#   "latestPrice": 0.11906825,
#   "lastUpdated": "<seeded-anchor-timestamp>"
# }

# /pools — lists AMM pool snapshots
curl -s http://localhost:3002/pools | jq '.pools[0]'
# {
#   "pool_id": "65c24738ce0ba076fd4f4d3b66618681ca1f9e9d78c95bb8db3a684a82bb3ee0",
#   "asset_a": "XLM",
#   "asset_b": "USDC",
#   "reserve_a": 550000,
#   "reserve_b": 66000,
#   "spot_price": 0.12,
#   "fee_bp": 30,
#   "timestamp": "<seeded-anchor-timestamp>"
# }

# /price/:assetA/:assetB — aggregated VWAP + best route
curl -s http://localhost:3002/price/XLM/USDC | jq '{price, ammPrice, lastUpdated}'
# {
#   "price": 0.11906825,
#   "ammPrice": 0.12,
#   "lastUpdated": "<request-timestamp>"
# }
```

*(Note: timestamp values above reflect the dynamic hourly anchor at seed execution time and request time).*

## Load testing

The price endpoints are load-tested with k6 (`.github/workflows/load.yml`,
`tests/load/prices.k6.js`), on a schedule and on demand. The acceptance
criterion is **price p95 < 80ms at 5k RPS**; twap/vwap get a looser
p95 < 500ms because they compute over a 60-minute window. Thresholds are
per endpoint, and the k6 summary is uploaded as a `k6-summary` artifact on
every run, so a failing run still leaves its numbers behind.

To try a small run locally against docker-compose (with k6 installed — see
https://k6.io/docs/get-started/installation/). The database must be seeded
first: an empty database has no price points for `/price` to serve.

```bash
docker compose up -d
npm run seed -- --network testnet
RATE=200 DURATION=20s k6 run tests/load/prices.k6.js
```

(The full 5k RPS run needs a machine with enough headroom to both serve and
generate the load; a hosted CI runner is the reference environment for it.)

## Backfill & Ingestion Gap Detection

Lens provides persistent gap detection and an idempotent historical backfill CLI to recover missing trade history and declare incomplete time windows in API responses.

### 1. Gap Detection & IngestionGap Model
Gaps are tracked per `(network, source, pair)` in the `IngestionGap` table:
- `status`: `'open'` (detected hole in history), `'filled'` (successfully backfilled), or `'permanent'` (data cannot be backfilled).
- Gaps are detected when the elapsed time between consecutive price points exceeds the expected ingestion cadence (default 5 minutes).
- **Idempotency & Merging:** Re-running gap detection never duplicates records; overlapping or adjacent intervals are merged automatically into single continuous ranges.

### 2. Backfill CLI
Run the backfill script for historical sources:

```bash
# Backfill SDEX trades for XLM/USDC
npm run backfill -- --source SDEX --pair XLM/USDC --start 2026-10-15T00:00:00Z --end 2026-10-15T06:00:00Z --network testnet

# Detect gaps and backfill them automatically
npm run backfill -- --source SDEX --pair XLM/USDC --start 2026-10-15T00:00:00Z --end 2026-10-15T06:00:00Z --detect
```

- **History Support:**
  - `SDEX` and `AMM`: Supported via Horizon historical trade paging. Refetched points are written through the same idempotent `upsertPricePoints` path as live ingestion. Gaps are marked `filled`.
  - `soroswap_amm` and `aquarius_amm`: State-only venues that do not retain historical trade logs. Attempting to backfill them cleanly marks the gap as `permanent` and exits without error.
- **Idempotent Re-runs:** Running the same backfill range a second time produces 0 duplicate records and leaves the gap marked `filled`.

### 3. Incomplete Window Declarations in API Responses
When querying time-window endpoints (such as `/prices/history`, `/candles/:assetA/:assetB`, `/price/:assetA/:assetB/history`, `/price/twap/*`, and `/price/vwap/*`):
- If the requested window overlaps any `open` or `permanent` gaps for that pair and network, the response includes `incomplete: true` along with the list of overlapping `gaps`:
  ```json
  {
    "pair": "XLM/USDC",
    "interval": "1m",
    "incomplete": true,
    "gaps": [
      {
        "source": "SDEX",
        "start": "2026-10-15T01:00:00.000Z",
        "end": "2026-10-15T03:00:00.000Z",
        "status": "open"
      }
    ],
    "points": [...]
  }
  ```
- Windows that are clean or cover only `filled` gaps omit the `incomplete` and `gaps` fields.

## Numeric Precision & Serialization

Lens enforces strict arbitrary-precision numeric aggregation across SQL queries to eliminate floating-point representation artifacts and order-dependent rounding errors:

- **Database Precision**: Declared in `prisma/schema.prisma` as `Decimal(36, 18)` for prices and `Decimal(36, 7)` for volumes (matching Stellar 7-decimal stroop precision).
- **Exact Aggregations**: All intermediate SQL aggregations (`SUM`, `array_agg`, `MAX`, `MIN`) are computed in PostgreSQL using exact `numeric` arithmetic without `::float` casts inside aggregate expressions.
- **Edge Serialization**: Values are cast once at the serialization boundary to documented precision:
  - Prices: up to 18 decimal places (`PRICE_DECIMAL_PLACES = 18`).
  - Volumes: up to 7 decimal places (`VOLUME_DECIMAL_PLACES = 7`).

## Rate Limiting & 429 Handling

Lens enforces rate limits per client IP or authenticated API key to protect system throughput:

| Tier / Endpoint | Window | Limit |
| :--- | :--- | :--- |
| **Public Unauthenticated (by IP)** | 1 minute | `100 requests` (`RATE_LIMITS.ipDefault`) |
| **Authenticated API Keys** | 1 minute | `1,000 requests` (`RATE_LIMITS.authenticatedDefault`) |
| **Public Health/Monitoring (`/status`)** | 1 minute | `1,000 requests` (`RATE_LIMITS.monitoring`) |

### Handling 429 (Too Many Requests)
When a client exceeds their allowance, Lens replies with HTTP status `429 Too Many Requests`.

1. **`Retry-After` Header:** Specifies the number of seconds to wait before retrying (e.g., `Retry-After: 42`).
2. **Standardized Error Body:**
   ```json
   {
     "statusCode": 429,
     "error": "Too Many Requests",
     "code": "rate_limited",
     "message": "Rate limit exceeded, retry in 42 seconds",
     "retryAfter": 42
   }
   ```
Callers should parse the `Retry-After` header or `retryAfter` field and apply exponential backoff.


## Environment Variables

| Variable | Description | Default | Required |
|---|---|---|---|
| `NODE_ENV` | Environment mode (`development`, `test`, `production`) | `development` | No |
| `PORT` | API server port | `3002` | No |
| `HOST` | API server host | `0.0.0.0` | No |
| `GLOBAL_RATE_LIMIT_MAX` | Maximum accepted non-health requests per rolling minute per instance | `1000` | No |
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
- **Runtime:** Node.js 22 + TypeScript
- **API:** Fastify + Mercurius (GraphQL)
- **Database:** PostgreSQL + TimescaleDB
- **Cache:** Redis
- **Queue:** BullMQ
- **Stellar:** @stellar/stellar-sdk


### Deployed smoke check

Run against a real running instance (local, staging or production):

```bash
SMOKE_MAX_AGE_SECONDS=120 SMOKE_TIMEOUT_MS=8000 npm run smoke -- http://localhost:3002
```

Validate the smoke checker itself with `npm run test:smoke`.

The check requires public `/status`, `/live` and `/ready`, plus `/price/XLM/USDC`. It uses a
`graphql-transport-ws` live price subscription at `/graphql`. Both probes must be
present and healthy — a missing `/ready` fails the run rather than being skipped,
since a smoke check that silently tolerates an absent probe is how a deployment
ends up unmonitored while still green. It checks
indexer and trade freshness, validates price shape, and waits for a real
subscription event. It fails non-zero, naming the failing check, on timeout,
stale data, a missing message, or HTTP errors. No synthetic price events are
generated. On installations where x402 payment gates the price endpoint,
a normal unauthenticated call receives HTTP 402 and the smoke check fails;
it never bypasses payment requirements. A quiet pair without any new trades
will likewise fail the live-message requirement.
