import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

// The fixtures below use absolute timestamps, and coverage derives `hasGap`
// from how old the newest indexed trade is (> 6h). Without a frozen clock this
// suite passes on the day it is written and fails every day after, which is
// what happened here. Pin "now" just after the fixture timestamps.
const FROZEN_NOW = new Date('2026-10-19T11:00:00.000Z')
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FROZEN_NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

const { mockQuery, mockHorizonCall } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockHorizonCall: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  class MockServer {
    url: string
    constructor(url: string) {
      this.url = url
    }
    tradeAggregation() {
      return this
    }
    limit() {
      return this
    }
    call() {
      return mockHorizonCall()
    }
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: MockServer,
    },
  }
})

import { activeNetwork } from '../config'
import { registerCoverageRoutes } from '../routes/coverage'
import {
  computeCoverageRatio,
  computeTradeCoverageRatio,
  parseAssetString,
} from '../services/coverage'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerCoverageRoutes(app)
  await app.ready()
  return app
}

const VALID_MAINNET_USDC =
  'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

describe('Coverage Ratio Arithmetic Pinning', () => {
  describe('computeCoverageRatio', () => {
    it('pins normal ratio arithmetic: 50 indexed / 100 network = 0.5', () => {
      const result = computeCoverageRatio(50, 100)
      expect(result.status).toBe('computed')
      expect(result.coverageRatio).toBe(0.5)
    })

    it('pins 100% coverage: 100 indexed / 100 network = 1.0', () => {
      const result = computeCoverageRatio(100, 100)
      expect(result.status).toBe('computed')
      expect(result.coverageRatio).toBe(1.0)
    })

    it('pins 0% coverage: reports 0.0 when network volume > 0 but Lens indexed 0', () => {
      // Unflattering coverage must be reported faithfully, not hidden or nullified
      const result = computeCoverageRatio(0, 100)
      expect(result.status).toBe('computed')
      expect(result.coverageRatio).toBe(0.0)
    })

    it('pins coverage > 1.0 when Lens indexes venues outside Horizon (e.g. Soroswap AMM): 150 / 100 = 1.5', () => {
      const result = computeCoverageRatio(150, 100)
      expect(result.status).toBe('computed')
      expect(result.coverageRatio).toBe(1.5)
    })

    it('pins unanswerable when network volume is 0 (division by zero is not zero!)', () => {
      // 0 network volume means no trades occurred on-chain; saying 0% coverage is false
      const result = computeCoverageRatio(0, 0)
      expect(result.status).toBe('unanswerable')
      expect(result.coverageRatio).toBeNull()
      expect(result.reason).toMatch(/zero network volume/)
    })

    it('pins unanswerable when positive indexed volume but zero network volume', () => {
      const result = computeCoverageRatio(50, 0)
      expect(result.status).toBe('unanswerable')
      expect(result.coverageRatio).toBeNull()
    })

    it('pins unanswerable for non-finite or negative numbers', () => {
      expect(computeCoverageRatio(NaN, 100).status).toBe('unanswerable')
      expect(computeCoverageRatio(100, Infinity).status).toBe('unanswerable')
      expect(computeCoverageRatio(-10, 100).status).toBe('unanswerable')
      expect(computeCoverageRatio(100, -10).status).toBe('unanswerable')
    })
  })

  describe('computeTradeCoverageRatio', () => {
    it('pins normal trade count ratio: 40 indexed / 80 network = 0.5', () => {
      const result = computeTradeCoverageRatio(40, 80)
      expect(result.status).toBe('computed')
      expect(result.coverageRatio).toBe(0.5)
    })

    it('pins 0% trade coverage: 0 indexed / 50 network = 0.0', () => {
      const result = computeTradeCoverageRatio(0, 50)
      expect(result.status).toBe('computed')
      expect(result.coverageRatio).toBe(0.0)
    })

    it('pins unanswerable when network trades is 0', () => {
      const result = computeTradeCoverageRatio(0, 0)
      expect(result.status).toBe('unanswerable')
      expect(result.coverageRatio).toBeNull()
    })
  })
})

describe('parseAssetString', () => {
  it('parses native XLM correctly', () => {
    expect(parseAssetString('XLM').canonical).toBe('XLM')
    expect(parseAssetString('XLM').code).toBe('XLM')
    expect(parseAssetString('XLM').issuer).toBeNull()
    expect(parseAssetString('XLM:native').canonical).toBe('XLM')
  })

  it('parses token with full 56-character issuer without eliding', () => {
    const parsed = parseAssetString(VALID_MAINNET_USDC)
    expect(parsed.code).toBe('USDC')
    expect(parsed.issuer).toBe('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
    expect(parsed.canonical).toBe(VALID_MAINNET_USDC)
  })

  it('rejects an invalid issuer key', () => {
    expect(() => parseAssetString('USDC:INVALIDKEY')).toThrow(/expected 56-character/)
  })

  it('rejects empty or malformed asset string', () => {
    expect(() => parseAssetString('')).toThrow(/Invalid asset identifier/)
    expect(() => parseAssetString('A/B')).toThrow(/Invalid asset identifier/)
  })
})

describe('GET /coverage/:asset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('computes coverage ratio and returns full provenance for an asset', async () => {
    // Mock Postgres indexed volume: 500 XLM across SDEX and AMM
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT asset_a')) {
        return { rows: [] }
      }
      return {
        rows: [
          { source: 'SDEX', volume: '300.0', trade_count: 6, last_seen: '2026-10-19T10:30:00Z' },
          { source: 'AMM', volume: '200.0', trade_count: 4, last_seen: '2026-10-19T10:35:00Z' },
        ],
      }
    })

    // Mock Horizon trade aggregations: total 1000 XLM on network, 20 trades
    mockHorizonCall.mockResolvedValue({
      records: [
        { base_volume: '600.0', counter_volume: '60.0', trade_count: '12', timestamp: 1792400000000 },
        { base_volume: '400.0', counter_volume: '40.0', trade_count: '8', timestamp: 1792403600000 },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/coverage/XLM?window=24h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.asset).toBe('XLM')
    expect(body.window).toBe('24h')
    expect(body.status).toBe('computed')
    expect(body.reason).toBeNull()

    // 500 indexed / 1000 network = 0.5 (50% coverage)
    expect(body.coverageRatio).toBe(0.5)
    expect(body.tradeCoverageRatio).toBe(0.5) // 10 indexed / 20 network = 0.5

    expect(body.indexed.totalVolume).toBe(500)
    expect(body.indexed.tradeCount).toBe(10)
    expect(body.indexed.byVenue).toEqual({ SDEX: 300, AMM: 200 })
    expect(body.indexed.venues.sort()).toEqual(['AMM', 'SDEX'])

    expect(body.networkActivity.totalVolume).toBe(1000)
    expect(body.networkActivity.tradeCount).toBe(20)

    // Provenance
    expect(body.provenance.venues.sort()).toEqual(['AMM', 'SDEX'])
    expect(body.provenance.indexedSampleCount).toBe(10)
    expect(body.provenance.networkSampleCount).toBe(2)
    expect(body.provenance.lastIndexedTrade).toBe('2026-10-19T10:35:00.000Z')
    expect(body.provenance.hasGap).toBe(false)
    expect(body.methodology).toBeTypeOf('string')

    await app.close()
  })

  it('reports unflattering 0% coverage faithfully when Lens indexed 0 of an active market', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    mockHorizonCall.mockResolvedValue({
      records: [{ base_volume: '500.0', counter_volume: '50.0', trade_count: '10', timestamp: 1792400000000 }],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/coverage/XLM?window=24h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('computed')
    // 0 / 500 = 0.0 coverage
    expect(body.coverageRatio).toBe(0)
    expect(body.indexed.totalVolume).toBe(0)
    expect(body.networkActivity.totalVolume).toBe(500)

    await app.close()
  })

  it('reports status unanswerable and coverageRatio null when no network activity occurred on Horizon', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    mockHorizonCall.mockResolvedValue({ records: [] })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/coverage/XLM?window=24h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('unanswerable')
    expect(body.coverageRatio).toBeNull()
    expect(body.reason).toMatch(/zero network volume/)

    await app.close()
  })

  it('reports status unanswerable and 200 OK when Horizon API fails (does not 500)', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT asset_a')) {
        return { rows: [] }
      }
      return {
        rows: [{ source: 'SDEX', volume: '100', trade_count: 2, last_seen: '2026-10-19T10:00:00Z' }],
      }
    })
    mockHorizonCall.mockRejectedValue(new Error('Horizon gateway timeout'))

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/coverage/XLM?window=24h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('unanswerable')
    expect(body.coverageRatio).toBeNull()
    expect(body.reason).toMatch(/Horizon API unreachable/)

    await app.close()
  })

  it('never elides contract ids or issuers', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    mockHorizonCall.mockResolvedValue({ records: [] })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/coverage/${VALID_MAINNET_USDC}?window=24h` })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asset).toBe(VALID_MAINNET_USDC)
    expect(body.asset).not.toContain('…')
    expect(body.asset).not.toContain('...')

    await app.close()
  })

  it('rejects an invalid window parameter with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/coverage/XLM?window=1h' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/window must be one of/)
    await app.close()
  })

  describe('network scoping', () => {
    it('echoes the requested network in the response', async () => {
      mockQuery.mockResolvedValue({ rows: [] })
      mockHorizonCall.mockResolvedValue({ records: [] })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/coverage/XLM?network=mainnet' })
      expect(res.statusCode).toBe(200)
      expect(res.json().network).toBe('mainnet')
      await app.close()
    })

    it('defaults to activeNetwork when no network is specified', async () => {
      mockQuery.mockResolvedValue({ rows: [] })
      mockHorizonCall.mockResolvedValue({ records: [] })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/coverage/XLM' })
      expect(res.statusCode).toBe(200)
      expect(res.json().network).toBe(activeNetwork)
      await app.close()
    })

    it('rejects an invalid network parameter with 400', async () => {
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/coverage/XLM?network=invalidnet' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/network must be one of/)
      await app.close()
    })
  })
})

describe('GET /coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('computes overall coverage and per-asset list with methodology and provenance', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT asset_a')) {
        return { rows: [] }
      }
      return {
        rows: [
          { source: 'SDEX', volume: '1000.0', trade_count: 10, last_seen: '2026-10-19T10:00:00Z' },
        ],
      }
    })
    mockHorizonCall.mockResolvedValue({
      records: [
        { base_volume: '2000.0', counter_volume: '200.0', trade_count: '20', timestamp: 1792400000000 },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/coverage?window=24h&network=testnet' })

    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.network).toBe('testnet')
    expect(body.window).toBe('24h')
    expect(body.overall).toBeDefined()
    expect(body.overall.tradeCoverageRatio).toBeTypeOf('number')
    expect(body.overall.totalIndexedTrades).toBeGreaterThanOrEqual(10)
    expect(body.overall.venues).toContain('SDEX')

    expect(Array.isArray(body.assets)).toBe(true)
    expect(body.assets.length).toBeGreaterThan(0)

    for (const asset of body.assets) {
      expect(asset.asset).toBeDefined()
      expect(asset.byVenue).toBeDefined()
      expect(Array.isArray(asset.venues)).toBe(true)
    }

    expect(body.provenance).toBeDefined()
    expect(body.provenance.horizonUrl).toContain('testnet')
    expect(body.methodology).toBeTypeOf('string')

    await app.close()
  })

  it('rejects invalid window on /coverage with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/coverage?window=5m' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/window must be one of/)
    await app.close()
  })

  it('rejects invalid network on /coverage with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/coverage?network=badnet' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/network must be one of/)
    await app.close()
  })
})
