# HTTP Status Code Conventions

This document defines the consistent rules for HTTP status codes across all Lens API routes.

## The Rule

**404 Not Found** is returned when:
- A **resource does not exist** (the requested entity is not configured, not registered, or fundamentally absent)
- Examples: pair not watched, API key not found, webhook subscription ID not found

**200 OK with empty result** is returned when:
- A **query matched nothing** (the resource exists and the query was valid, but no data satisfied the filters/time range)
- Examples: no price data in the requested time window, no trades in the last 24h, no pools for the given asset

**400 Bad Request** is returned when:
- Request parameters are malformed, out of range, or violate validation rules
- Examples: invalid date format, unsupported window value, negative amount

## Application per Route

### Routes returning 404 for non-existent resources

| Route | 404 Condition |
|---|---|
| `GET /price/:assetA/:assetB` | Pair not watched on the requested network |
| `GET /price/:assetA/:assetB/route` | Pair not watched on the requested network |
| `GET /price/:assetA/:assetB/depth` | Pair not watched on the requested network |
| `GET /benchmark/:asset` | Pair not watched on the requested network |
| `DELETE /admin/keys/:id` | API key ID not found |
| `DELETE /webhooks/:id` | Already 204 (idempotent deletion) |

### Routes returning 200 with empty result + reason

| Route | Empty Result Condition | Response Shape |
|---|---|---|
| `GET /basket` | One or more assets have no price data | `{ error: "No price data found for: ASSET1, ASSET2" }` **→ Changed to 200** |
| `GET /compare/:asset` | No Lens or Reflector price available | `{ lens: null, reflector: null, status: "no_data", ... }` **→ Changed to 200** |
| `GET /candles/:assetA/:assetB` | No trades in the requested time range | `{ candles: [], pairKey, interval, from, to }` |
| `GET /price/:assetA/:assetB/history` | No aggregated buckets for the window | `{ buckets: [], pairKey, window }` |
| `GET /spreads/:asset` | No venue quoted the asset in the window | `{ venues: [], tightest: null, ... }` |
| `GET /volumes/:asset` | No trades for the asset in the window | `{ totalVolume: 0, byVenue: {}, venues: [], tradeCount: 0, ... }` |
| `GET /screener` | No pairs matched the filters | `{ data: [], nextCursor: null, hasMore: false, total: null }` |
| `GET /pools` | No pools for the network | `{ pools: [] }` |
| `GET /pairs` | No watched pairs (configuration issue) | `{ pairs: [] }` |

### Rationale

The distinction preserves semantic information that a single status code cannot carry:

- **404** tells the client "you asked for something that cannot exist — check your configuration or endpoint"
- **200 + empty** tells the client "your request was valid but there is no data right now — try again later or widen your filters"

A client that retries a 404 without changing its request is wasting resources. A client that retries a 200-empty after waiting or adjusting filters is behaving correctly.

### Migration notes

Routes that **changed** from 404 to 200-empty:
- `/basket` — was 404 when an asset had no price; now 200 with `{ error: ... }` listing the missing assets
- `/compare/:asset` — was 404 when both sources were null; now 200 with `status: "no_data"`

Routes that were **already correct** and unchanged:
- `/candles`, `/price/*/history`, `/spreads`, `/volumes`, `/screener`, `/pools`, `/pairs` — all return 200 with empty arrays
- `/price`, `/price/*/route`, `/price/*/depth`, `/benchmark` — all return 404 for unwatched pairs
