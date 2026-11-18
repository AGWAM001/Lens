# Route Classification and Security Architecture

Lens categorizes its API routes into three explicit security and access tiers:
1. **Public Reads (`public`)**
2. **Credentialed Routes (`credentialed`)**
3. **Operator Admin Routes (`admin`)**

This classification governs Cross-Origin Resource Sharing (CORS), rate limiting, authentication enforcement, and OpenAPI spec publication.

---

## Route Classification Matrix

| HTTP Method | Route Template | Classification | Authentication / Gate | CORS Policy | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **GET** | `/status` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | System and ingestion lag health check |
| **GET** | `/metrics` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Prometheus scrape endpoint (text exposition) |
| **GET** | `/price/:assetA/:assetB` | `public` | Optional x402 Micropayment | Open to any origin (`origin: true`, `credentials: false`) | Unified SDEX+AMM price and VWAP |
| **GET** | `/price/:assetA/:assetB/route` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Best execution routing |
| **GET** | `/price/:assetA/:assetB/depth` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Simulated order-book depth and slippage |
| **GET** | `/price/:assetA/:assetB/history`| `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | OHLCV history buckets |
| **GET** | `/price/twap/:assetA/:assetB` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Time-weighted average price (TWAP) |
| **GET** | `/price/vwap/:assetA/:assetB` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Volume-weighted average price (VWAP) |
| **GET** | `/candles/:assetA/:assetB` | `public` | Optional x402 Micropayment | Open to any origin (`origin: true`, `credentials: false`) | OHLCV candlestick time series |
| **GET** | `/prices/history` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Historical 1-minute price snapshots |
| **GET** | `/pools` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Active AMM liquidity pools |
| **GET** | `/pairs` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Indexed Stellar trading pairs |
| **GET** | `/volumes/:asset` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Cross-venue traded volume statistics |
| **GET** | `/spreads/:asset` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Bid/ask spreads across venues |
| **GET** | `/compare/:asset` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Multi-venue & oracle deviation comparison |
| **GET** | `/screener` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Top markets ranked by volume/liquidity |
| **GET** | `/benchmark/:asset` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Asset peg stability & tracking |
| **GET** | `/basket` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Multi-asset weighted index price |
| **GET** | `/discovery/resources` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Bazaar catalog of discoverable x402 resources |
| **GET** | `/supported` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | Supported x402 payment schemes & networks |
| **POST**| `/verify` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | x402 payment verification |
| **POST**| `/settle` | `public` | None (Public) | Open to any origin (`origin: true`, `credentials: false`) | x402 payment settlement (idempotent) |
| **POST**| `/webhooks` | `public`* | None (Public by default) | Open to any origin (`origin: true`, `credentials: false`) | Subscribe to price threshold notifications |
| **DELETE**|`/webhooks/:id` | `public`* | None (Public by default) | Open to any origin (`origin: true`, `credentials: false`) | Cancel webhook subscription |
| **POST**| `/graphql` | `public` | None (Public query resolver) | Open to any origin (`origin: true`, `credentials: false`) | GraphQL query endpoint |
| **GET** | `/graphiql` | `public` | None (Internal UI) | Open to any origin (`origin: true`, `credentials: false`) | Interactive GraphiQL IDE |
| **GET** | `/ws` | `public` | Optional x402 Header | Open to any origin (`origin: true`, `credentials: false`) | WebSocket real-time price feed |
| **GET** | `/usage/me` | `credentialed` | `Authorization: Bearer <key>` | Restricted to `CORS_ALLOWED_ORIGINS`, `credentials: true` | Calling key's usage, quotas, and limits |
| **ANY** | Any endpoint with `Authorization` | `credentialed` | API key or Bearer token | Restricted to `CORS_ALLOWED_ORIGINS`, `credentials: true` | Dynamic narrowing when caller credentials are sent |
| **POST**| `/admin/keys` | `admin` | `X-Admin-Token` | Closed by default (`origin: false`, `credentials: false`) | Mint new API keys (returns plaintext key once) |
| **DELETE**|`/admin/keys/:id` | `admin` | `X-Admin-Token` | Closed by default (`origin: false`, `credentials: false`) | Revoke existing API keys |
| **GET** | `/admin/usage` | `admin` | `X-Admin-Token` | Closed by default (`origin: false`, `credentials: false`) | Operator usage report for all API keys |
| **GET** | `/admin/usage/:keyId` | `admin` | `X-Admin-Token` | Closed by default (`origin: false`, `credentials: false`) | Operator usage report for specific key |

\* *Note: If `REQUIRE_API_KEY=true` is enabled, non-exempt routes inherit API key verification requirements and dynamically adopt credentialed CORS protections.*

---

## CORS Security Model

### 1. Public Reads (`public`)
- **Intent**: Public financial data, order book states, oracle rates, and service discovery are intentionally world-readable. DApps, browser extensions, block explorers, and analytics tools running on any domain must be able to query these endpoints without friction.
- **Access-Control-Allow-Origin**: Reflects the requesting origin (or `*`), allowing universal browser access.
- **Access-Control-Allow-Credentials**: Explicitly omitted / `false`. Browsers will strictly deny sharing sensitive cookies or ambient authentication with cross-origin callers.

### 2. Credentialed Routes (`credentialed`)
- **Intent**: Endpoints that expose account-level information, usage quotas, or billing history (such as `/usage/me`) require strict boundary control.
- **Access-Control-Allow-Origin**: Checked against the configured `CORS_ALLOWED_ORIGINS` environment variable (e.g. `https://app.lens.stellar.org,http://localhost:3000`). If the origin matches, it is allowed; otherwise, cross-origin access is refused (no `Access-Control-Allow-Origin` header emitted).
- **Access-Control-Allow-Credentials**: Explicitly set to `true` for permitted origins.

### 3. Admin Routes (`admin`)
- **Intent**: Key issuance, key revocation, and system-wide usage metrics are restricted to infrastructure operators via `ADMIN_TOKEN`.
- **Policy**: Closed to cross-origin browsers by default (`origin: false`).
- **Access-Control-Allow-Origin**: None. Browser preflight requests return `404` and actual requests lack CORS headers, preventing malicious or CSRF-style browser interactions.
- **Operator Overrides**: If operators use an internal dashboard, authorized origins can be explicitly whitelisted using `CORS_ADMIN_ALLOWED_ORIGINS`.

---

## Configuration

Add the following environment variables to `.env` as needed:

```bash
# Comma-separated list of trusted web app origins permitted to call credentialed routes (/usage/me)
CORS_ALLOWED_ORIGINS=https://app.lens.stellar.org,https://portal.lens.stellar.org,http://localhost:3000

# Optional: Comma-separated list of internal admin origins permitted to call /admin/* endpoints
# Leave unset or empty to close all cross-origin browser access to admin routes (recommended)
CORS_ADMIN_ALLOWED_ORIGINS=

# Optional: Comma-separated list of blocked origins to deny even on public routes
CORS_PUBLIC_BLOCKED_ORIGINS=
```
