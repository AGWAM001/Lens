# Portfolio NAV Example

A minimal Next.js page that values a Stellar account using Lens price feeds.

## Quick start

1. Run a local Lens instance (default port **3002**):
   ```bash
   docker compose up -d
   ```
2. Install and run this example:
   ```bash
   cd examples/portfolio-nav
   npm install
   npx next dev -p 3001
   ```
3. Open http://localhost:3001, paste your Stellar public key (`G…`), and click **Value**.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_LENS_URL` | `http://localhost:3002` | Lens API base URL |
| `NEXT_PUBLIC_HORIZON_URL` | `https://horizon.stellar.org` | Horizon API for account balances |
| `NEXT_PUBLIC_LENS_KEY` | *(empty)* | Bearer token for authenticated Lens instances |
| `NEXT_PUBLIC_NETWORK` | `mainnet` | Passed as `?network=` to Lens; must match the Horizon network |

### Security note on API keys

Because this is a client-rendered page, any `NEXT_PUBLIC_` value is visible
to every visitor in their browser's DevTools. For production use, prefer a
small server route (e.g. `pages/api/price.ts`) that adds the key
server-side and proxies requests to Lens. The client then calls your
internal route without exposing the credential.

## Type-checking

```bash
npx tsc --noEmit
```

Uses the included `tsconfig.json`. No live Stellar account is hard-coded —
paste your own at runtime.
