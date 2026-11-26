/**
 * Single source of truth for x402 payment gating decisions (issue #677).
 *
 * This module answers, without touching a database or importing any `@x402`
 * package:
 *
 *   1. Which routes are paid (GATED_ROUTES)?
 *   2. Does a given path+method fall behind the gate (matchGatedRoute)?
 *   3. Is x402 configured at all (isX402Configured)?
 *
 * Both `middleware/x402.ts` (the payment gate itself) and
 * `middleware/cachePolicy.ts` (which must keep paid responses out of shared
 * caches) read from here, so the two can no longer drift apart. Everything in
 * this file is pure data + env reads: no imports, so it is safe to use from
 * any middleware and trivially unit-testable.
 */

/** A route gated by x402 and its per-call price. */
export interface GatedRoute {
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly price: string
  readonly description: string
}

// Routes gated by x402 and their prices, declared in deliberate order.
// NOTE: /graphql is POST-only and already no-store, so cachePolicy never needs
// to downgrade it — it stays in the list for the payment gate's sake.
export const GATED_ROUTES: readonly GatedRoute[] = [
  {
    path: '/price',
    method: 'GET',
    price: '$0.10',
    description: 'Unified SDEX+AMM price with VWAP and best route',
  },
  {
    path: '/pools',
    method: 'GET',
    price: '$0.05',
    description: 'AMM liquidity pool reserves and spot prices',
  },
  {
    path: '/candles',
    method: 'GET',
    price: '$0.05',
    description: 'OHLCV candle data for trading charts',
  },
  {
    path: '/graphql',
    method: 'POST',
    price: '$0.10',
    description: 'GraphQL queries for price data and market information',
  },
] as const

/**
 * Checks whether `routedPath` matches `prefix` at a path-segment boundary.
 *
 * Query strings and fragments are stripped so they cannot affect whether a route
 * matches. A path matches at a segment boundary if each segment of the prefix
 * matches the corresponding segment of the path.
 *
 * For example:
 *   - '/price' matches '/price'
 *   - '/price/test' matches '/price'
 *   - '/pricing' does NOT match '/price' (segment 'pricing' !== 'price')
 *   - '/poolsize' does NOT match '/pools' (segment 'poolsize' !== 'pools')
 */
export function matchesPathSegment(routedPath: string, prefix: string): boolean {
  const cleanPath = routedPath.split('?')[0].split('#')[0]
  const cleanPrefix = prefix.split('?')[0].split('#')[0]

  const pathSegments = cleanPath.split('/').filter(Boolean)
  const prefixSegments = cleanPrefix.split('/').filter(Boolean)

  if (pathSegments.length < prefixSegments.length) {
    return false
  }

  return prefixSegments.every((seg, i) => pathSegments[i] === seg)
}

/**
 * Finds the first matching gated route definition for a given path and HTTP method.
 * Matches on the routed path at a path-segment boundary, never on raw URLs with query strings.
 */
export function matchGatedRoute(
  path: string,
  method: string,
  routes: readonly GatedRoute[] = GATED_ROUTES,
): GatedRoute | undefined {
  const upperMethod = method.toUpperCase()
  return routes.find(
    route => route.method.toUpperCase() === upperMethod && matchesPathSegment(path, route.path)
  )
}

/** Network names relevant to x402 configuration (same union as config.NetworkName). */
export type GatingNetworkName = 'testnet' | 'mainnet'

/**
 * The x402 payment address for a given network.
 *
 * Resolution order (first non-empty wins), mirroring `config.ts`'s per-network
 * env var convention:
 *   1. `ORACLE_PAYMENT_ADDRESS_TESTNET` / `ORACLE_PAYMENT_ADDRESS_MAINNET`
 *   2. `ORACLE_PAYMENT_ADDRESS` (back-compat with single-network setups)
 */
export function paymentAddressFor(network: GatingNetworkName): string | undefined {
  const suffix = network.toUpperCase()
  return process.env[`ORACLE_PAYMENT_ADDRESS_${suffix}`] || process.env.ORACLE_PAYMENT_ADDRESS
}

/** True if x402 gating should be active for at least one network. */
export function isX402Configured(): boolean {
  return Boolean(paymentAddressFor('testnet') || paymentAddressFor('mainnet'))
}
