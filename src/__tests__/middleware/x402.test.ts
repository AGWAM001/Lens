import { describe, it, expect, vi, beforeEach } from 'vitest'

// x402.ts reads env vars inside the plugin function, so set them before the app registers the plugin.
// We still need them here for the mock payment address used in test assertions.
const PAYMENT_ADDRESS = 'GPAYMENTADDRESS123456789012345678901234567890123456789012'

// ── All mock objects via vi.hoisted so they exist when vi.mock factories execute ──
const {
  mockVerify,
  mockSettle,
  mockInitialize,
  mockRegisterChain,
  MockResourceServer,
  MockFacilitatorClient,
  MockExactScheme,
} = vi.hoisted(() => {
  const mockVerify = vi.fn()
  const mockSettle = vi.fn().mockResolvedValue(undefined)
  const mockInitialize = vi.fn().mockResolvedValue(undefined)

  // .register() returns `this` for chaining
  const instance = {
    initialize: mockInitialize,
    verify: mockVerify,
    settle: mockSettle,
    register: vi.fn(),
  }
  instance.register.mockReturnValue(instance)
  const mockRegisterChain = instance

  // Constructor mocks — must be regular functions (not arrows) to support `new`
  function MockResourceServer() { return instance }
  function MockFacilitatorClient() { return {} }
  function MockExactScheme() { return {} }

  return { mockVerify, mockSettle, mockInitialize, mockRegisterChain, MockResourceServer, MockFacilitatorClient, MockExactScheme }
})

vi.mock('@x402/core/server', () => ({
  x402ResourceServer: MockResourceServer,
  HTTPFacilitatorClient: MockFacilitatorClient,
}))

vi.mock('@x402/stellar/exact/server', () => ({
  ExactStellarScheme: MockExactScheme,
}))

import Fastify from 'fastify'
import { registerX402, GATED_ROUTES, matchGatedRoute, matchesPathSegment } from '../../middleware/x402'
import { registerNetworkSelector } from '../../middleware/network'
import { _resetX402ResourceServers } from '../../x402/network'

// ── Helpers ───────────────────────────────────────────────────────────────────
async function buildApp() {
  process.env.ORACLE_PAYMENT_ADDRESS = PAYMENT_ADDRESS
  process.env.STELLAR_NETWORK = 'testnet'
  const app = Fastify({ logger: false })
  await app.register(registerX402)
  app.get('/price/test', async () => ({ ok: true }))
  app.get('/pools/test', async () => ({ ok: true }))
  app.get('/candles/test', async () => ({ ok: true }))
  app.post('/graphql', async () => ({ ok: true }))
  app.get('/public', async () => ({ ok: true }))
  app.get('/pricing', async () => ({ ok: true }))
  app.get('/poolsize', async () => ({ ok: true }))
  app.get('/prices/history', async () => ({ ok: true }))
  app.get('/candlesticks', async () => ({ ok: true }))
  await app.ready()
  return app
}

// Same as buildApp(), but with the network selector registered ahead of x402
// so req.network is actually resolved from ?network=/x-network per request.
async function buildAppWithNetworkSelector() {
  process.env.ORACLE_PAYMENT_ADDRESS = PAYMENT_ADDRESS
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await app.register(registerX402)
  app.get('/price/test', async () => ({ ok: true }))
  await app.ready()
  return app
}

function makePaymentHeader(overrides: Record<string, unknown> = {}): string {
  const payload = { scheme: 'exact', amount: '$0.10', recipient: PAYMENT_ADDRESS, ...overrides }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

beforeEach(() => {
  mockVerify.mockReset()
  mockSettle.mockReset().mockResolvedValue(undefined)
  mockInitialize.mockReset().mockResolvedValue(undefined)
  mockRegisterChain.register.mockReturnValue(mockRegisterChain)
  // Per-network resource servers are memoised at module scope (see
  // x402/network.ts) — clear between tests so each one builds fresh against
  // whatever ORACLE_PAYMENT_ADDRESS_* env vars it sets up.
  _resetX402ResourceServers()
  delete process.env.ORACLE_PAYMENT_ADDRESS_MAINNET
  delete process.env.ORACLE_PAYMENT_ADDRESS_TESTNET
})

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('x402 middleware', () => {
  it('returns 200 when payment header is valid', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { 'x-payment': makePaymentHeader() },
    })

    expect(res.statusCode).toBe(200)
    expect(mockVerify).toHaveBeenCalledOnce()
  })

  it('returns 402 with x402Version and accepts body when payment header is missing', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/price/test' })

    expect(res.statusCode).toBe(402)
    const body = res.json()
    expect(body).toHaveProperty('x402Version', 1)
    expect(body).toHaveProperty('accepts')
    expect(body.accepts[0]).toHaveProperty('price', '$0.10')
    expect(body.accepts[0]).toHaveProperty('payTo', PAYMENT_ADDRESS)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('returns 402 when payment is for wrong amount', async () => {
    mockVerify.mockResolvedValue({ isValid: false, invalidReason: 'amount mismatch' })
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { 'x-payment': makePaymentHeader({ amount: '$0.01' }) },
    })

    expect(res.statusCode).toBe(402)
    expect(res.json()).toMatchObject({ error: 'Payment invalid', reason: 'amount mismatch' })
  })

  it('returns 402 when payment is for wrong recipient', async () => {
    mockVerify.mockResolvedValue({ isValid: false, invalidReason: 'recipient mismatch' })
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { 'x-payment': makePaymentHeader({ recipient: 'GWRONGADDRESS' }) },
    })

    expect(res.statusCode).toBe(402)
    expect(res.json()).toMatchObject({ error: 'Payment invalid', reason: 'recipient mismatch' })
  })

  it('does not gate non-matching routes', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/public' })

    expect(res.statusCode).toBe(200)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('does not gate /pricing or /poolsize, but gates /price/...', async () => {
    const app = await buildApp()

    const pricingRes = await app.inject({ method: 'GET', url: '/pricing' })
    expect(pricingRes.statusCode).toBe(200)

    const poolsizeRes = await app.inject({ method: 'GET', url: '/poolsize' })
    expect(poolsizeRes.statusCode).toBe(200)

    const priceRes = await app.inject({ method: 'GET', url: '/price/test' })
    expect(priceRes.statusCode).toBe(402)
  })

  it('gates /pools with $0.05 price requirement', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/pools/test' })

    expect(res.statusCode).toBe(402)
    expect(res.json().accepts[0]).toHaveProperty('price', '$0.05')
  })

  it('gates /candles with $0.05 price requirement', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/candles/test' })

    expect(res.statusCode).toBe(402)
    expect(res.json().accepts[0]).toHaveProperty('price', '$0.05')
  })

  it('settles payment asynchronously after successful verification', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildApp()

    await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { 'x-payment': makePaymentHeader() },
    })

    await new Promise(r => setTimeout(r, 20))
    expect(mockSettle).toHaveBeenCalledOnce()
  })

  it('gates POST requests to /graphql with $0.10 price requirement', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ test }' },
    })

    expect(res.statusCode).toBe(402)
    expect(res.json().accepts[0]).toHaveProperty('price', '$0.10')
  })

  it('allows POST to /graphql with valid payment header', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ test }' },
      headers: { 'x-payment': makePaymentHeader() },
    })

    expect(res.statusCode).toBe(200)
    expect(mockVerify).toHaveBeenCalledOnce()
  })

  it('does not gate GET requests to /graphql', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/graphql',
    })

    expect(res.statusCode).toBe(404)
    expect(mockVerify).not.toHaveBeenCalled()
  })
})

describe('x402 middleware — per-request network', () => {
  it('defaults to testnet requirements when no network is requested', async () => {
    const app = await buildAppWithNetworkSelector()

    const res = await app.inject({ method: 'GET', url: '/price/test' })

    expect(res.statusCode).toBe(402)
    expect(res.json().accepts[0]).toMatchObject({ network: 'stellar:testnet', payTo: PAYMENT_ADDRESS })
  })

  it('resolves mainnet network/payTo from ?network=mainnet', async () => {
    const MAINNET_ADDRESS = 'GMAINNETADDRESS123456789012345678901234567890123456789012'
    process.env.ORACLE_PAYMENT_ADDRESS_MAINNET = MAINNET_ADDRESS
    const app = await buildAppWithNetworkSelector()

    const res = await app.inject({ method: 'GET', url: '/price/test?network=mainnet' })

    expect(res.statusCode).toBe(402)
    expect(res.json().accepts[0]).toMatchObject({ network: 'stellar:pubnet', payTo: MAINNET_ADDRESS })
  })

  it('falls back to the shared ORACLE_PAYMENT_ADDRESS when no mainnet-specific address is set', async () => {
    const app = await buildAppWithNetworkSelector()

    const res = await app.inject({ method: 'GET', url: '/price/test?network=mainnet' })

    expect(res.statusCode).toBe(402)
    expect(res.json().accepts[0]).toMatchObject({ network: 'stellar:pubnet', payTo: PAYMENT_ADDRESS })
  })

  it('rejects an invalid ?network= before x402 even runs', async () => {
    const app = await buildAppWithNetworkSelector()

    const res = await app.inject({ method: 'GET', url: '/price/test?network=pubnet' })

    expect(res.statusCode).toBe(400)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('verifies a mainnet payment against mainnet requirements', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildAppWithNetworkSelector()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test?network=mainnet',
      headers: { 'x-payment': makePaymentHeader() },
    })

    expect(res.statusCode).toBe(200)
    expect(mockVerify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ network: 'stellar:pubnet' })
    )
  })
})

describe('x402 gating — declared paid set', () => {
  it('declares the paid set in one place with explicit routes, methods, and prices', () => {
    expect(Array.isArray(GATED_ROUTES)).toBe(true)
    expect(GATED_ROUTES).toHaveLength(4)

    expect(GATED_ROUTES[0]).toMatchObject({
      path: '/price',
      method: 'GET',
      price: '$0.10',
    })
    expect(GATED_ROUTES[1]).toMatchObject({
      path: '/pools',
      method: 'GET',
      price: '$0.05',
    })
    expect(GATED_ROUTES[2]).toMatchObject({
      path: '/candles',
      method: 'GET',
      price: '$0.05',
    })
    expect(GATED_ROUTES[3]).toMatchObject({
      path: '/graphql',
      method: 'POST',
      price: '$0.10',
    })
  })
})

describe('x402 gating — path-segment boundary matching', () => {
  it('matches only on path-segment boundaries', () => {
    // Exact matches
    expect(matchesPathSegment('/price', '/price')).toBe(true)
    expect(matchesPathSegment('/pools', '/pools')).toBe(true)
    expect(matchesPathSegment('/candles', '/candles')).toBe(true)
    expect(matchesPathSegment('/graphql', '/graphql')).toBe(true)

    // Subpaths at slash boundary
    expect(matchesPathSegment('/price/test', '/price')).toBe(true)
    expect(matchesPathSegment('/price/XLM/USDC', '/price')).toBe(true)
    expect(matchesPathSegment('/price/twap/XLM/USDC', '/price')).toBe(true)
    expect(matchesPathSegment('/pools/test', '/pools')).toBe(true)
    expect(matchesPathSegment('/candles/test', '/candles')).toBe(true)

    // Trailing slashes
    expect(matchesPathSegment('/price/', '/price')).toBe(true)
    expect(matchesPathSegment('/pools/', '/pools')).toBe(true)

    // Near-misses (must NOT match)
    expect(matchesPathSegment('/pricing', '/price')).toBe(false)
    expect(matchesPathSegment('/pricing/overview', '/price')).toBe(false)
    expect(matchesPathSegment('/poolsize', '/pools')).toBe(false)
    expect(matchesPathSegment('/pool', '/pools')).toBe(false)
    expect(matchesPathSegment('/pools-overview', '/pools')).toBe(false)
    expect(matchesPathSegment('/prices', '/price')).toBe(false)
    expect(matchesPathSegment('/prices/history', '/price')).toBe(false)
    expect(matchesPathSegment('/price-check', '/price')).toBe(false)
    expect(matchesPathSegment('/candlesticks', '/candles')).toBe(false)
    expect(matchesPathSegment('/graphiql', '/graphql')).toBe(false)
    expect(matchesPathSegment('/graphql-schema', '/graphql')).toBe(false)
  })

  it('strips query strings and fragments before segment matching', () => {
    expect(matchesPathSegment('/price?network=testnet', '/price')).toBe(true)
    expect(matchesPathSegment('/price/test?network=testnet', '/price')).toBe(true)
    expect(matchesPathSegment('/pricing?network=testnet', '/price')).toBe(false)
    expect(matchesPathSegment('/poolsize?compact=1', '/pools')).toBe(false)
    expect(matchesPathSegment('/public?prefix=/price', '/price')).toBe(false)
    expect(matchesPathSegment('/status?/price', '/price')).toBe(false)
  })
})

describe('x402 gating — route match table', () => {
  const table: Array<{
    description: string
    path: string
    method: string
    expectedGated: boolean
    expectedPrice?: string
  }> = [
    // ── Every entry in the paid set ──
    { description: 'base /price route', path: '/price', method: 'GET', expectedGated: true, expectedPrice: '$0.10' },
    { description: 'subpath /price/test', path: '/price/test', method: 'GET', expectedGated: true, expectedPrice: '$0.10' },
    { description: 'subpath /price/:assetA/:assetB', path: '/price/XLM/USDC', method: 'GET', expectedGated: true, expectedPrice: '$0.10' },
    { description: 'subpath /price/twap/:assetA/:assetB', path: '/price/twap/XLM/USDC', method: 'GET', expectedGated: true, expectedPrice: '$0.10' },
    { description: 'base /pools route', path: '/pools', method: 'GET', expectedGated: true, expectedPrice: '$0.05' },
    { description: 'subpath /pools/test', path: '/pools/test', method: 'GET', expectedGated: true, expectedPrice: '$0.05' },
    { description: 'base /candles route', path: '/candles', method: 'GET', expectedGated: true, expectedPrice: '$0.05' },
    { description: 'subpath /candles/test', path: '/candles/test', method: 'GET', expectedGated: true, expectedPrice: '$0.05' },
    { description: 'subpath /candles/:assetA/:assetB', path: '/candles/XLM/USDC', method: 'GET', expectedGated: true, expectedPrice: '$0.05' },
    { description: 'POST to /graphql', path: '/graphql', method: 'POST', expectedGated: true, expectedPrice: '$0.10' },

    // ── Query string variations on gated routes (must remain gated) ──
    { description: '/price/test with query param', path: '/price/test?network=testnet', method: 'GET', expectedGated: true, expectedPrice: '$0.10' },
    { description: '/pools with query param', path: '/pools?sort=reserves', method: 'GET', expectedGated: true, expectedPrice: '$0.05' },
    { description: '/candles/test with query param', path: '/candles/test?interval=1h', method: 'GET', expectedGated: true, expectedPrice: '$0.05' },
    { description: 'POST /graphql with query param', path: '/graphql?debug=true', method: 'POST', expectedGated: true, expectedPrice: '$0.10' },

    // ── Near-misses (must NOT be gated) ──
    { description: 'near-miss /pricing', path: '/pricing', method: 'GET', expectedGated: false },
    { description: 'near-miss /pricing with query string', path: '/pricing?pair=XLM/USDC', method: 'GET', expectedGated: false },
    { description: 'near-miss /poolsize', path: '/poolsize', method: 'GET', expectedGated: false },
    { description: 'near-miss /poolsize with query string', path: '/poolsize?compact=true', method: 'GET', expectedGated: false },
    { description: 'near-miss /prices (plural)', path: '/prices', method: 'GET', expectedGated: false },
    { description: 'near-miss /prices/history', path: '/prices/history', method: 'GET', expectedGated: false },
    { description: 'near-miss /price-check', path: '/price-check', method: 'GET', expectedGated: false },
    { description: 'near-miss /pricequote', path: '/pricequote', method: 'GET', expectedGated: false },
    { description: 'near-miss /pool (singular)', path: '/pool', method: 'GET', expectedGated: false },
    { description: 'near-miss /pools-all', path: '/pools-all', method: 'GET', expectedGated: false },
    { description: 'near-miss /candlesticks', path: '/candlesticks', method: 'GET', expectedGated: false },
    { description: 'near-miss GET /graphql (only POST is gated)', path: '/graphql', method: 'GET', expectedGated: false },
    { description: 'near-miss POST /graphql-schema', path: '/graphql-schema', method: 'POST', expectedGated: false },
    { description: 'near-miss GET /graphiql', path: '/graphiql', method: 'GET', expectedGated: false },

    // ── Unrelated routes & query-string injection attempts ──
    { description: 'unrelated /public route', path: '/public', method: 'GET', expectedGated: false },
    { description: 'query string containing gated path /public?path=/price', path: '/public?path=/price', method: 'GET', expectedGated: false },
    { description: 'query string containing gated path /status?/price', path: '/status?/price', method: 'GET', expectedGated: false },
    { description: 'root route /', path: '/', method: 'GET', expectedGated: false },
  ]

  for (const { description, path, method, expectedGated, expectedPrice } of table) {
    it(`${expectedGated ? 'gates' : 'does not gate'} ${description} [${method} ${path}]`, () => {
      const match = matchGatedRoute(path, method)
      if (expectedGated) {
        expect(match).toBeDefined()
        expect(match?.price).toBe(expectedPrice)
      } else {
        expect(match).toBeUndefined()
      }
    })
  }
})

describe('x402 gating — HTTP integration with Fastify', () => {
  it('does not gate /pricing or /poolsize, but gates /price/... under HTTP', async () => {
    const app = await buildApp()

    // Near-misses return 200, not 402
    const resPricing = await app.inject({ method: 'GET', url: '/pricing' })
    expect(resPricing.statusCode).toBe(200)

    const resPoolsize = await app.inject({ method: 'GET', url: '/poolsize' })
    expect(resPoolsize.statusCode).toBe(200)

    const resPricesHistory = await app.inject({ method: 'GET', url: '/prices/history' })
    expect(resPricesHistory.statusCode).toBe(200)

    const resCandlesticks = await app.inject({ method: 'GET', url: '/candlesticks' })
    expect(resCandlesticks.statusCode).toBe(200)

    // Gated routes return 402 without payment header
    const resPrice = await app.inject({ method: 'GET', url: '/price/test' })
    expect(resPrice.statusCode).toBe(402)

    const resPools = await app.inject({ method: 'GET', url: '/pools/test' })
    expect(resPools.statusCode).toBe(402)

    const resCandles = await app.inject({ method: 'GET', url: '/candles/test' })
    expect(resCandles.statusCode).toBe(402)

    const resGraphql = await app.inject({ method: 'POST', url: '/graphql' })
    expect(resGraphql.statusCode).toBe(402)
  })

  it('guarantees query strings cannot change whether a route is gated', async () => {
    const app = await buildApp()

    // Free routes remain free regardless of query string
    const resPricingQuery = await app.inject({ method: 'GET', url: '/pricing?foo=bar&price=free' })
    expect(resPricingQuery.statusCode).toBe(200)

    const resPoolsizeQuery = await app.inject({ method: 'GET', url: '/poolsize?compact=1' })
    expect(resPoolsizeQuery.statusCode).toBe(200)

    const resPublicQuery = await app.inject({ method: 'GET', url: '/public?redirect=/price/test' })
    expect(resPublicQuery.statusCode).toBe(200)

    // Paid routes remain gated regardless of query string
    const resPriceQuery = await app.inject({ method: 'GET', url: '/price/test?query=something' })
    expect(resPriceQuery.statusCode).toBe(402)

    const resPoolsQuery = await app.inject({ method: 'GET', url: '/pools/test?verbose=true' })
    expect(resPoolsQuery.statusCode).toBe(402)

    const resCandlesQuery = await app.inject({ method: 'GET', url: '/candles/test?interval=5m' })
    expect(resCandlesQuery.statusCode).toBe(402)
  })
})

