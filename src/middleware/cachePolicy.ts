import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
// Single source of truth for candle intervals — shared with the candles
// route module, so the two can never drift apart (issue #266 review).
import { INTERVAL_SECONDS as CANDLE_INTERVAL_SECONDS } from '../candleIntervals'

/**
 * Whether x402 payment gating is active. Mirrors isX402Configured() in
 * ../x402/network.ts (which checks the same env vars) — inlined here to
 * avoid pulling the @x402 packages into the middleware bundle.
 */
function isX402Active(): boolean {
  return Boolean(
    process.env.ORACLE_PAYMENT_ADDRESS_TESTNET ||
      process.env.ORACLE_PAYMENT_ADDRESS_MAINNET ||
      process.env.ORACLE_PAYMENT_ADDRESS,
  )
}

// x402-gated route prefixes (mirrors GATED_ROUTES in ./x402.ts).
// Kept as a local list instead of importing matchGatedRoute from ./x402,
// because that module pulls in DB dependencies (via ../x402/metering) that
// break unit tests and bloat the middleware. If GATED_ROUTES changes, update
// this list. Note: /graphql is POST-only and already no-store, so it is
// omitted here.
const X402_GATED_PREFIXES = ['/price', '/pools', '/candles'] as const

/**
 * Whether a route+method falls behind the x402 payment gate.
 * Matches on path-segment boundaries, same as matchGatedRoute in ./x402.ts.
 */
function isX402GatedRoute(routePath: string, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  const segments = routePath.split('/').filter(Boolean)
  return X402_GATED_PREFIXES.some(prefix =>
    prefix
      .split('/')
      .filter(Boolean)
      .every((seg, i) => segments[i] === seg),
  )
}

/**
 * Per-route Cache-Control policy (issue #266).
 *
 * Every route sends a deliberate `Cache-Control` header:
 * - Live prices get a short max-age — they move every few seconds.
 * - `/pairs` and `/pools` change only when a pool is added — rarely — so
 *   they get a medium max-age.
 * - `/candles` for a closed historical window is *probably* immutable (see
 *   `candlesPolicy` for why "probably" matters); the currently-forming
 *   window is not.
 * - Per-caller responses (usage, admin) are `no-store` — they must never sit
 *   in a shared cache keyed by URL.
 * - Mutations and error responses are `no-store`.
 *
 * Vary: the Stellar network is resolved from the `?network=` query param
 * (part of the URL, hence part of the cache key) OR the `x-network` header
 * (NOT part of the cache key). Every `public` response therefore sends
 * `Vary: x-network` — without it, a shared cache could serve a mainnet
 * response to a testnet request.
 *
 * x402: routes behind the x402 payment gate (`/price*`, `/pools*`,
 * `/candles*`, see GATED_ROUTES in `./x402`) return the same market data
 * regardless of who pays — the response does not vary by payer identity, so
 * no `Vary` on payment headers is needed. But when x402 gating is active,
 * these routes use `private` instead of `public`: a shared cache serving a
 * paid response would let the next caller skip payment entirely, a direct
 * revenue leak. When x402 is not configured, `public` is safe and used.
 *
 * The policy is documented beside each route in `openapi.yaml` (see the
 * `Cache-Control` response header and the "Cache policy" section in the
 * spec's info description).
 */

/**
 * Cache policy for `/candles/:assetA/:assetB`.
 *
 * A window whose `to` is at least one full interval in the past is *probably*
 * closed: no new price point should land in it. But "probably" is doing real
 * work here — backfill and reconciliation jobs can rewrite historical buckets
 * (late-arriving trades, corrections). We therefore do NOT treat closed
 * windows as immutable: they get a short max-age (1h) so a rewrite propagates
 * quickly, plus a long `stale-while-revalidate` (24h) so repeat requests stay
 * fast while revalidation happens in the background. If backfill-driven
 * rewrites are ever ruled out for a deployment, the max-age can be raised.
 */
function candlesPolicy(query: Record<string, unknown>): string {
  const interval = typeof query.interval === 'string' ? query.interval : '1h'
  const intervalSecs = CANDLE_INTERVAL_SECONDS[interval] ?? 3600
  const toRaw = query.to
  const toMs = typeof toRaw === 'string' && toRaw !== '' ? Date.parse(toRaw) : Date.now()
  if (!Number.isNaN(toMs) && toMs < Date.now() - intervalSecs * 1000) {
    return 'public, max-age=3600, stale-while-revalidate=86400'
  }
  return 'public, max-age=60'
}

export interface CachePolicyOptions {
  /**
   * Whether x402 payment gating is active. When true, x402-gated routes
   * downgrade `public` → `private` (see module docstring for why).
   */
  x402Active?: boolean
}

/**
 * Returns the `Cache-Control` value for a request. Pure function of the
 * route, method, status and options — no I/O — so it is unit-testable
 * without booting the server.
 */
export function cachePolicyFor(
  method: string,
  routePath: string,
  statusCode: number,
  query: Record<string, unknown> = {},
  opts: CachePolicyOptions = {},
): string {
  // Mutations are never cacheable.
  if (method !== 'GET' && method !== 'HEAD') return 'no-store'
  // Never cache errors — a cached 4xx/5xx would hide recovery.
  if (statusCode < 200 || statusCode >= 300) return 'no-store'

  // Per-caller responses: usage is scoped to the caller's API key, admin
  // routes to the operator. A shared cache must never serve one caller's
  // response to another.
  if (routePath.startsWith('/admin/') || routePath === '/usage/me') return 'no-store'

  let policy: string
  switch (routePath) {
    // Health/monitoring — fresh by design.
    case '/status':
      policy = 'public, max-age=15'
      break

    // Reference data: changes only when a pair/pool is added — rarely.
    case '/pairs':
    case '/pools':
      policy = 'public, max-age=300'
      break

    // Live prices — move constantly.
    case '/price/:assetA/:assetB':
    case '/price/:assetA/:assetB/route':
    case '/price/:assetA/:assetB/depth':
      policy = 'public, max-age=30'
      break

    // Aggregates and derived views — recomputed on a schedule.
    case '/price/:assetA/:assetB/history':
    case '/price/twap/:assetA/:assetB':
    case '/price/vwap/:assetA/:assetB':
    case '/prices/history':
    case '/compare/:asset':
    case '/spreads/:asset':
      policy = 'public, max-age=60'
      break

    // Slower-moving derived views.
    case '/volumes/:asset':
    case '/screener':
    case '/basket':
    case '/tvl':
      policy = 'public, max-age=120'
      break

    // Benchmarks anchor to long windows.
    case '/benchmark/:asset':
      policy = 'public, max-age=300'
      break

    // Static discovery document.
    case '/discovery/resources':
      policy = 'public, max-age=3600'
      break

    // Candles: closed historical windows are probably immutable (see above).
    case '/candles/:assetA/:assetB':
      policy = candlesPolicy(query)
      break

    default:
      // Deliberate default: anything not classified above — facilitator
      // endpoints, GraphQL, webhooks, unknown routes — is not cached.
      return 'no-store'
  }

  // x402-gated routes must not sit in a shared cache when gating is active:
  // the next caller would get the response without paying.
  if (opts.x402Active && policy.startsWith('public') && isX402GatedRoute(routePath, method)) {
    return policy.replace('public', 'private')
  }
  return policy
}

/**
 * Returns the `Vary` header value for a response with the given
 * Cache-Control policy, or `null` when no `Vary` is needed.
 *
 * `no-store` responses are never cached; `private` responses are only cached
 * per-user (the browser key includes everything). Only `public` (shared
 * cache) responses need to declare that the `x-network` header is part of
 * the effective cache key.
 */
export function varyFor(cacheControl: string): string | null {
  if (cacheControl.startsWith('public')) return 'x-network'
  return null
}

async function cachePolicyPlugin(app: FastifyInstance) {
  // x402 gating is configured via env, not per-request — read once.
  const x402Active = isX402Active()

  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    // A route that sets its own Cache-Control keeps it — the middleware
    // only fills in the default policy.
    if (reply.getHeader('Cache-Control') != null) return payload

    const routePath = req.routeOptions?.url ?? ''
    const query = (req.query ?? {}) as Record<string, unknown>
    const policy = cachePolicyFor(req.method, routePath, reply.statusCode, query, { x402Active })
    reply.header('Cache-Control', policy)

    const vary = varyFor(policy)
    if (vary) {
      const existing = reply.getHeader('Vary')
      reply.header('Vary', existing ? `${existing}, ${vary}` : vary)
    }
    return payload
  })
}

export const registerCachePolicy = fp(cachePolicyPlugin, { name: 'cache-policy' })
