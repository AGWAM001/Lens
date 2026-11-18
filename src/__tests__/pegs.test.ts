import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetNetworkConfig } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetNetworkConfig: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config')
  return {
    ...actual,
    getNetworkConfig: mockGetNetworkConfig,
  }
})

import { registerPegsRoutes, PEG_TOLERANCE_BPS } from '../routes/pegs'
import { parsePeggedAssets, DEFAULT_PEG_TOLERANCE_BPS } from '../config'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerPegsRoutes(app)
  await app.ready()
  return app
}

describe('parsePeggedAssets', () => {
  it('returns an empty list for blank input', () => {
    expect(parsePeggedAssets('')).toEqual([])
    expect(parsePeggedAssets('   ')).toEqual([])
  })

  it('parses single and multiple pegged asset definitions with optional windowHours', () => {
    const circleIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    const eurocIssuer = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
    const parsed = parsePeggedAssets(
      `USDC:${circleIssuer}=USD:1.0, EURC:${eurocIssuer}=USD:1.08:12`
    )

    expect(parsed).toEqual([
      {
        asset: { code: 'USDC', issuer: circleIssuer },
        target: 'USD',
        targetPrice: 1.0,
        windowHours: 24,
      },
      {
        asset: { code: 'EURC', issuer: eurocIssuer },
        target: 'USD',
        targetPrice: 1.08,
        windowHours: 12,
      },
    ])
  })

  it('requires an explicit targetPrice and names the offending entry on malformed input', () => {
    const circleIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    expect(() => parsePeggedAssets(`USDC:${circleIssuer}`)).toThrow(
      /Invalid pegged asset format: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"/
    )
    expect(() => parsePeggedAssets(`USDC:${circleIssuer}=USD`)).toThrow(
      /Expected "ASSET\[:ISSUER\]=TARGET:TARGET_PRICE\[:WINDOW_HOURS\]"/
    )
    expect(() => parsePeggedAssets(`USDC:${circleIssuer}=USD:notanumber`)).toThrow(
      /Invalid target price in pegged asset/
    )
    expect(() => parsePeggedAssets(`USDC:${circleIssuer}=USD:0`)).toThrow(
      /Invalid target price in pegged asset/
    )
  })

  it('shares the 100 bps (1%) default peg tolerance band with snapshot and peg alerts (#322)', () => {
    expect(DEFAULT_PEG_TOLERANCE_BPS).toBe(100)
    expect(PEG_TOLERANCE_BPS).toBe(100)
  })
})

describe('GET /pegs', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const envKeys = [
    'PEGGED_ASSETS',
    'PEGGED_ASSETS_TESTNET',
    'PEGGED_ASSETS_MAINNET',
    'WATCHED_PAIRS',
    'WATCHED_PAIRS_TESTNET',
    'WATCHED_PAIRS_MAINNET',
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of envKeys) {
      savedEnv[k] = process.env[k]
    }
  })

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('honours and echoes ?network= parameter', async () => {
    mockGetNetworkConfig.mockReturnValue({
      pairs: [],
      pegged: [],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.network).toBe('mainnet')
    expect(data.pegs).toEqual([])
    expect(mockGetNetworkConfig).toHaveBeenCalledWith('mainnet')
  })

  it('rejects an invalid network parameter with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=ropsten',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('network must be one of')
  })

  it('returns all configured pegged assets with current, worst deviation, and provenance', async () => {
    const circleIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    mockGetNetworkConfig.mockReturnValue({
      pairs: [
        {
          pairKey: `USDC:${circleIssuer}/USD`,
          assetA: { code: 'USDC', issuer: circleIssuer },
          assetB: { code: 'USD', issuer: null },
        },
      ],
      pegged: [
        {
          asset: { code: 'USDC', issuer: circleIssuer },
          target: 'USD',
          targetPrice: 1.0,
          windowHours: 24,
        },
      ],
    })

    mockQuery.mockResolvedValue({
      rows: [
        {
          latest_price: '0.9998',
          latest_ts: '2026-10-16T12:00:00.000Z',
          latest_source: 'SDEX',
          worst_deviation_bps: '5.2',
          sample_count: 142,
          venues: ['SDEX', 'AMM'],
          window_last_ts: '2026-10-16T12:00:00.000Z',
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.network).toBe('mainnet')
    expect(data.pegs).toHaveLength(1)

    const peg = data.pegs[0]
    expect(peg.asset).toBe(`USDC:${circleIssuer}`)
    expect(peg.code).toBe('USDC')
    expect(peg.issuer).toBe(circleIssuer)
    expect(peg.target).toBe('USD')
    expect(peg.targetPrice).toBe(1.0)
    expect(peg.pairKey).toBe(`USDC:${circleIssuer}/USD`)
    expect(peg.currentPrice).toBe(0.9998)
    // (0.9998 - 1.0) * 10000 = -2.0 bps
    expect(peg.currentDeviationBps).toBeCloseTo(-2.0, 1)
    expect(peg.worstDeviationBps).toBe(5.2)
    expect(peg.window).toBe('24h')
    expect(peg.provenance.venues).toEqual(['SDEX', 'AMM'])
    expect(peg.provenance.sampleCount).toBe(142)
    expect(typeof peg.provenance.freshnessSeconds).toBe('number')
    expect(peg.provenance.lastSampleTimestamp).toBe('2026-10-16T12:00:00.000Z')
  })

  it('omits unconfigured assets completely', async () => {
    const circleIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    mockGetNetworkConfig.mockReturnValue({
      // Pairs include XLM, BTC, ETH, and USDC, but only USDC is configured as pegged
      pairs: [
        {
          pairKey: 'BTC/USD',
          assetA: { code: 'BTC', issuer: null },
          assetB: { code: 'USD', issuer: null },
        },
        {
          pairKey: `USDC:${circleIssuer}/USD`,
          assetA: { code: 'USDC', issuer: circleIssuer },
          assetB: { code: 'USD', issuer: null },
        },
      ],
      pegged: [
        {
          asset: { code: 'USDC', issuer: circleIssuer },
          target: 'USD',
          targetPrice: 1.0,
          windowHours: 24,
        },
      ],
    })

    mockQuery.mockResolvedValue({
      rows: [
        {
          latest_price: '1.0000',
          latest_ts: '2026-10-16T12:00:00.000Z',
          latest_source: 'SDEX',
          worst_deviation_bps: '0',
          sample_count: 10,
          venues: ['SDEX'],
          window_last_ts: '2026-10-16T12:00:00.000Z',
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    // BTC must be completely absent, not present with 0 deviation
    expect(data.pegs.find((p: any) => p.code === 'BTC')).toBeUndefined()
    expect(data.pegs).toHaveLength(1)
    expect(data.pegs[0].code).toBe('USDC')
  })

  it('reports null deviation and empty provenance for pegged assets with no trades or liquidity', async () => {
    const euroIssuer = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
    mockGetNetworkConfig.mockReturnValue({
      pairs: [
        {
          pairKey: `EURC:${euroIssuer}/EUR`,
          assetA: { code: 'EURC', issuer: euroIssuer },
          assetB: { code: 'EUR', issuer: null },
        },
      ],
      pegged: [
        {
          asset: { code: 'EURC', issuer: euroIssuer },
          target: 'EUR',
          targetPrice: 1.0,
          windowHours: 24,
        },
      ],
    })

    mockQuery.mockResolvedValue({
      rows: [
        {
          latest_price: null,
          latest_ts: null,
          latest_source: null,
          worst_deviation_bps: null,
          sample_count: 0,
          venues: null,
          window_last_ts: null,
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.pegs).toHaveLength(1)

    const peg = data.pegs[0]
    expect(peg.asset).toBe(`EURC:${euroIssuer}`)
    expect(peg.currentPrice).toBeNull()
    expect(peg.currentDeviationBps).toBeNull()
    expect(peg.worstDeviationBps).toBeNull()
    expect(peg.provenance).toEqual({
      venues: [],
      sampleCount: 0,
      freshnessSeconds: null,
      lastSampleTimestamp: null,
    })
  })

  it('reports null when a configured pegged asset is not quoted/watched in pairs', async () => {
    const rwaIssuer = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
    mockGetNetworkConfig.mockReturnValue({
      pairs: [], // no watched pairs
      pegged: [
        {
          asset: { code: 'TBILL', issuer: rwaIssuer },
          target: 'USD',
          targetPrice: 100.0,
          windowHours: 24,
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.pegs).toHaveLength(1)

    const peg = data.pegs[0]
    expect(peg.asset).toBe(`TBILL:${rwaIssuer}`)
    expect(peg.targetPrice).toBe(100.0)
    expect(peg.pairKey).toBeNull()
    expect(peg.currentPrice).toBeNull()
    expect(peg.currentDeviationBps).toBeNull()
    expect(peg.worstDeviationBps).toBeNull()
    expect(peg.provenance.sampleCount).toBe(0)
  })

  it('defaults to Circle USDC=USD:1.0 on both networks when PEGGED_ASSETS* is unset in process.env', async () => {
    delete process.env.PEGGED_ASSETS
    delete process.env.PEGGED_ASSETS_TESTNET
    delete process.env.PEGGED_ASSETS_MAINNET

    vi.resetModules()
    const realConfig = await vi.importActual<typeof import('../config')>('../config')
    mockGetNetworkConfig.mockImplementation((net: 'testnet' | 'mainnet') =>
      realConfig.getNetworkConfig(net)
    )

    expect(realConfig.getNetworkConfig('mainnet').pegged).toEqual([
      {
        asset: {
          code: 'USDC',
          issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        },
        target: 'USD',
        targetPrice: 1.0,
        windowHours: 24,
      },
    ])
    expect(realConfig.getNetworkConfig('testnet').pegged).toEqual([
      {
        asset: {
          code: 'USDC',
          issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        },
        target: 'USD',
        targetPrice: 1.0,
        windowHours: 24,
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('mainnet')
    expect(body.pegs).toHaveLength(1)
    expect(body.pegs[0].asset).toBe(
      'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    )
    expect(body.pegs[0].target).toBe('USD')
    expect(body.pegs[0].targetPrice).toBe(1.0)
  })

  it('wires PEGGED_ASSETS_<NETWORK> and PEGGED_ASSETS through the real getNetworkConfig into GET /pegs', async () => {
    const circleIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    const eurocIssuer = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'

    process.env.WATCHED_PAIRS_MAINNET = `USDC:${circleIssuer}/USD,EURC:${eurocIssuer}/USD`
    process.env.PEGGED_ASSETS_MAINNET = `USDC:${circleIssuer}=USD:1.0,EURC:${eurocIssuer}=USD:1.08:12`
    delete process.env.PEGGED_ASSETS_TESTNET
    process.env.PEGGED_ASSETS = `USDC:${circleIssuer}=USD:1.0`

    vi.resetModules()
    const realConfig = await vi.importActual<typeof import('../config')>('../config')
    mockGetNetworkConfig.mockImplementation((net: 'testnet' | 'mainnet') =>
      realConfig.getNetworkConfig(net)
    )

    // Verify real getNetworkConfig populated `pegged` on both networks (paired var on mainnet, shared fallback on testnet)
    expect(realConfig.getNetworkConfig('mainnet').pegged).toHaveLength(2)
    expect(realConfig.getNetworkConfig('testnet').pegged).toHaveLength(1)

    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            latest_price: '1.0002',
            latest_ts: '2026-10-16T12:00:00.000Z',
            latest_source: 'SDEX',
            worst_deviation_bps: '4.0',
            sample_count: 80,
            venues: ['SDEX'],
            window_last_ts: '2026-10-16T12:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            latest_price: '1.0854',
            latest_ts: '2026-10-16T12:00:00.000Z',
            latest_source: 'AMM',
            worst_deviation_bps: '65.0',
            sample_count: 45,
            venues: ['AMM'],
            window_last_ts: '2026-10-16T12:00:00.000Z',
          },
        ],
      })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/pegs?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('mainnet')
    expect(body.pegs).toHaveLength(2)

    expect(body.pegs[0]).toMatchObject({
      asset: `USDC:${circleIssuer}`,
      target: 'USD',
      targetPrice: 1.0,
      window: '24h',
      currentPrice: 1.0002,
      worstDeviationBps: 4.0,
    })
    expect(body.pegs[0].currentDeviationBps).toBeCloseTo(2.0, 1)

    expect(body.pegs[1]).toMatchObject({
      asset: `EURC:${eurocIssuer}`,
      target: 'USD',
      targetPrice: 1.08,
      window: '12h',
      currentPrice: 1.0854,
      worstDeviationBps: 65.0,
    })
    // (1.0854 - 1.08) / 1.08 * 10000 = +50 bps
    expect(body.pegs[1].currentDeviationBps).toBeCloseTo(50.0, 1)
  })
})
