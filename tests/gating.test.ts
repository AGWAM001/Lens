import { describe, it, expect, afterEach, vi } from 'vitest'
import { cachePolicyFor } from '../src/middleware/cachePolicy'
import {
  GATED_ROUTES,
  matchGatedRoute,
  matchesPathSegment,
  isX402Configured,
  paymentAddressFor,
  type GatedRoute,
} from '../src/x402/gating'

// The identity checks below import middleware/x402 to prove its re-exports are
// the shared objects, not copies. Mock the heavy modules that file pulls in
// (DB, Redis, @x402) so this stays a pure unit test (issue #677).
vi.mock('../src/x402/metering', () => ({
  checkQuota: vi.fn(),
  recordUsage: vi.fn(),
  parseCents: vi.fn(),
  getQuotaConfig: vi.fn(),
}))
vi.mock('../src/redis', () => ({ redis: {} }))
vi.mock('../src/db', () => ({ prisma: {} }))
vi.mock('@x402/core/server', () => ({
  x402ResourceServer: vi.fn(),
  HTTPFacilitatorClient: vi.fn(),
}))
vi.mock('@x402/stellar/exact/server', () => ({ ExactStellarScheme: vi.fn() }))

const { GATED_ROUTES: GATED_ROUTES_VIA_X402, matchGatedRoute: matchGatedRouteViaX402 } = await import(
  '../src/middleware/x402'
)

// Unit tests for the shared x402 gating module (issue #677).
// The payment gate (middleware/x402.ts) and the cache policy
// (middleware/cachePolicy.ts) must answer the same questions about which
// routes are paid, from one definition — the old cachePolicy kept a second
// copy that could (and silently did) drift.

const ENV_KEYS = [
  'ORACLE_PAYMENT_ADDRESS_TESTNET',
  'ORACLE_PAYMENT_ADDRESS_MAINNET',
  'ORACLE_PAYMENT_ADDRESS',
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

describe('gating module (issue #677)', () => {
  it('exports the same route list the payment gate re-exports', () => {
    // The re-export through middleware/x402 is what existing callers import;
    // it must be the identical object, not a copy, or drift returns.
    expect(GATED_ROUTES_VIA_X402).toBe(GATED_ROUTES)
    expect(matchGatedRouteViaX402).toBe(matchGatedRoute)
  })

  it('keeps the GET prefixes the cache policy relied on', () => {
    // These are the three prefixes the old local X402_GATED_PREFIXES list held.
    const getPaths = GATED_ROUTES.filter(r => r.method === 'GET').map(r => r.path)
    expect(getPaths).toEqual(['/price', '/pools', '/candles'])
    // /graphql stays in the list for the payment gate (POST-only).
    expect(GATED_ROUTES.some(r => r.path === '/graphql' && r.method === 'POST')).toBe(true)
  })

  it('matches at segment boundaries (old behaviour preserved)', () => {
    expect(matchesPathSegment('/price/XLM/USDC', '/price')).toBe(true)
    expect(matchesPathSegment('/pricing', '/price')).toBe(false)
    expect(matchesPathSegment('/poolsize', '/pools')).toBe(false)
    expect(matchesPathSegment('/price/XLM/USDC?network=testnet', '/price')).toBe(true)
    expect(matchGatedRoute('/price/XLM/USDC', 'GET')).toMatchObject({ path: '/price' })
    // POST-only route is not returned for GET, and vice versa.
    expect(matchGatedRoute('/graphql', 'GET')).toBeUndefined()
    expect(matchGatedRoute('/graphql', 'POST')).toMatchObject({ path: '/graphql' })
  })
})

describe('cachePolicyFor uses the shared gated-route list', () => {
  it('downgrades real gated routes to private when x402 is on', () => {
    expect(cachePolicyFor('GET', '/pools', 200, {}, { x402Active: true })).toBe(
      'private, max-age=300',
    )
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB', 200, {}, { x402Active: true })).toBe(
      'private, max-age=30',
    )
    expect(cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, {}, { x402Active: true })).toBe(
      'private, max-age=60',
    )
  })

  it('keeps gated routes public when x402 is off', () => {
    expect(cachePolicyFor('GET', '/pools', 200, {}, { x402Active: false })).toBe(
      'public, max-age=300',
    )
    expect(cachePolicyFor('GET', '/pools', 200)).toBe('public, max-age=300')
  })

  it('downgrades a made-up GET entry added to the list in the test (issue #677 done-when)', () => {
    // '/screener' is classified public by the switch but is NOT paid today.
    // Adding it to the list passed via opts must flip its shared-cacheability
    // the same way adding a real paid route would.
    const extended: readonly GatedRoute[] = [
      ...GATED_ROUTES,
      { path: '/screener', method: 'GET', price: '$0.01', description: 'made-up test entry' },
    ]
    expect(cachePolicyFor('GET', '/screener', 200, {}, { x402Active: true })).toBe(
      'public, max-age=120',
    )
    expect(
      cachePolicyFor('GET', '/screener', 200, {}, { x402Active: true, gatedRoutes: extended }),
    ).toBe('private, max-age=120')
    // HEAD benefits from the same gate; POST is never cacheable anyway.
    expect(
      cachePolicyFor('HEAD', '/screener', 200, {}, { x402Active: true, gatedRoutes: extended }),
    ).toBe('private, max-age=120')
    expect(
      cachePolicyFor('POST', '/screener', 200, {}, { x402Active: true, gatedRoutes: extended }),
    ).toBe('no-store')
  })

  it('still refuses non-GET routes and leaves no-store policies alone', () => {
    // A POST gated entry cannot downgrade anything: non-GET is no-store already.
    const extended: readonly GatedRoute[] = [
      ...GATED_ROUTES,
      { path: '/admin/keys', method: 'POST', price: '$0.01', description: 'made-up' },
    ]
    expect(
      cachePolicyFor('POST', '/admin/keys', 200, {}, { x402Active: true, gatedRoutes: extended }),
    ).toBe('no-store')
    // no-store policies are never rewritten.
    expect(
      cachePolicyFor('GET', '/usage/me', 200, {}, { x402Active: true, gatedRoutes: extended }),
    ).toBe('no-store')
  })
})

describe('isX402Configured covers every env combination', () => {
  // One shared function now, but the contract is the old OR of the three
  // payment-address variables — verify all 8 combinations agree with that.
  const combos: Array<Record<string, string | undefined>> = []
  for (let mask = 0; mask < 8; mask++) {
    combos.push({
      ORACLE_PAYMENT_ADDRESS_TESTNET: mask & 1 ? 'GTEST...' : undefined,
      ORACLE_PAYMENT_ADDRESS_MAINNET: mask & 2 ? 'GMAIN...' : undefined,
      ORACLE_PAYMENT_ADDRESS: mask & 4 ? 'GALL...' : undefined,
    })
  }

  it.each(combos)('env %j → configured iff any address set', env => {
    for (const key of ENV_KEYS) delete process.env[key]
    let expected = false
    for (const [key, value] of Object.entries(env)) {
      if (value) {
        process.env[key] = value
        expected = true
      }
    }
    expect(isX402Configured()).toBe(expected)
    // paymentAddressFor resolves per-network exactly as documented.
    expect(Boolean(paymentAddressFor('testnet'))).toBe(
      Boolean(process.env.ORACLE_PAYMENT_ADDRESS_TESTNET || process.env.ORACLE_PAYMENT_ADDRESS),
    )
    expect(Boolean(paymentAddressFor('mainnet'))).toBe(
      Boolean(process.env.ORACLE_PAYMENT_ADDRESS_MAINNET || process.env.ORACLE_PAYMENT_ADDRESS),
    )
  })
})
