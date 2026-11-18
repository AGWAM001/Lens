import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockFindFirst, mockFindMany } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {
    pricePoint: {
      findFirst: mockFindFirst,
      findMany: mockFindMany,
    },
  },
}))

import { registerPremiumRoutes } from '../routes/premium'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerPremiumRoutes(app)
  await app.ready()
  return app
}

describe('GET /premium/:assetA/:assetB', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.PREMIUM_STALENESS_SECONDS
  })

  it('fresh data: returns 200 with correct prices, sources, timestamps, and spreadBps', async () => {
    const now = new Date()
    const onChainTime = new Date(now.getTime() - 10_000) // 10s ago
    const cexTime = new Date(now.getTime() - 5_000) // 5s ago

    mockFindFirst.mockResolvedValue({
      id: 'pt-1',
      network: 'testnet',
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      source: 'SDEX',
      price: 0.10,
      timestamp: onChainTime,
    })

    mockFindMany.mockResolvedValue([
      {
        id: 'pt-2',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'binance',
        price: 0.105,
        timestamp: cexTime,
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/premium/XLM/USDC?network=testnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.assetA).toBe('XLM')
    expect(body.assetB).toBe('USDC')
    expect(body.network).toBe('testnet')

    expect(body.onChain.price).toBe(0.10)
    expect(body.onChain.source).toBe('SDEX')
    expect(body.onChain.timestamp).toBe(onChainTime.toISOString())

    expect(body.cex.price).toBe(0.105)
    expect(body.cex.source).toBe('binance')
    expect(body.cex.timestamp).toBe(cexTime.toISOString())

    // ((0.105 - 0.10) / 0.10) * 10000 = 500 bps
    expect(body.spreadBps).toBe(500)
  })

  it('spreadBps calculation: asserts arithmetic is correct for known prices', async () => {
    const now = new Date()

    mockFindFirst.mockResolvedValue({
      id: 'pt-1',
      network: 'testnet',
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      source: 'AMM',
      price: 1.00,
      timestamp: now,
    })

    mockFindMany.mockResolvedValue([
      {
        id: 'pt-2',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'coinbase',
        price: 1.0234,
        timestamp: now,
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/premium/XLM/USDC',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // ((1.0234 - 1.00) / 1.00) * 10000 = 234 bps
    expect(body.spreadBps).toBe(234)
  })

  it('negative spreadBps calculation: when CEX is lower than on-chain', async () => {
    const now = new Date()

    mockFindFirst.mockResolvedValue({
      id: 'pt-1',
      network: 'testnet',
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      source: 'SDEX',
      price: 1.00,
      timestamp: now,
    })

    mockFindMany.mockResolvedValue([
      {
        id: 'pt-2',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'kraken',
        price: 0.985,
        timestamp: now,
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/premium/XLM/USDC',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // ((0.985 - 1.00) / 1.00) * 10000 = -150 bps
    expect(body.spreadBps).toBe(-150)
  })

  it('picks the CEX with the highest price (best bid) across multiple CEX sources', async () => {
    const now = new Date()
    const freshTime = new Date(now.getTime() - 5_000)

    mockFindFirst.mockResolvedValue({
      id: 'pt-onchain',
      network: 'testnet',
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      source: 'SDEX',
      price: 0.10,
      timestamp: freshTime,
    })

    // Three CEX sources: Binance at 0.104, Coinbase at 0.108, Kraken at 0.102
    mockFindMany.mockResolvedValue([
      {
        id: 'pt-cb-new',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'coinbase',
        price: 0.108,
        timestamp: freshTime,
      },
      {
        id: 'pt-binance-new',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'binance',
        price: 0.104,
        timestamp: freshTime,
      },
      {
        id: 'pt-kraken-new',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'kraken',
        price: 0.102,
        timestamp: freshTime,
      },
      // older row for binance with a higher historical price that should be ignored because it is not its most recent
      {
        id: 'pt-binance-old',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'binance',
        price: 0.200,
        timestamp: new Date(now.getTime() - 30_000),
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/premium/XLM/USDC',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.cex.source).toBe('coinbase')
    expect(body.cex.price).toBe(0.108)
  })

  it('on-chain side stale: on-chain price older than the bound, CEX fresh — returns 400 naming onChain as stale', async () => {
    const now = new Date()
    const oldTime = new Date(now.getTime() - 120_000) // 120s ago (> 60s default)
    const freshTime = new Date(now.getTime() - 10_000) // 10s ago

    mockFindFirst.mockResolvedValue({
      id: 'pt-1',
      network: 'testnet',
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      source: 'SDEX',
      price: 0.10,
      timestamp: oldTime,
    })

    mockFindMany.mockResolvedValue([
      {
        id: 'pt-2',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'binance',
        price: 0.105,
        timestamp: freshTime,
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/premium/XLM/USDC',
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.code).toBe('STALE_DATA')
    expect(body.stale).toBe('onChain')
    expect(body.ageSeconds).toBeGreaterThanOrEqual(119)
    expect(body.onChainAgeSeconds).toBeGreaterThanOrEqual(119)
    expect(body.cexAgeSeconds).toBeLessThan(60)
  })

  it('CEX side stale: CEX price older than the bound, on-chain fresh — returns 400 naming cex as stale', async () => {
    const now = new Date()
    const freshTime = new Date(now.getTime() - 10_000) // 10s ago
    const oldTime = new Date(now.getTime() - 150_000) // 150s ago

    mockFindFirst.mockResolvedValue({
      id: 'pt-1',
      network: 'testnet',
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      source: 'AMM',
      price: 0.10,
      timestamp: freshTime,
    })

    mockFindMany.mockResolvedValue([
      {
        id: 'pt-2',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'binance',
        price: 0.105,
        timestamp: oldTime,
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/premium/XLM/USDC',
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.code).toBe('STALE_DATA')
    expect(body.stale).toBe('cex')
    expect(body.ageSeconds).toBeGreaterThanOrEqual(149)
    expect(body.cexAgeSeconds).toBeGreaterThanOrEqual(149)
    expect(body.onChainAgeSeconds).toBeLessThan(60)
  })

  it('both stale: both older than the bound — returns 400 naming both', async () => {
    const now = new Date()
    const oldOnChainTime = new Date(now.getTime() - 90_000) // 90s ago
    const oldCexTime = new Date(now.getTime() - 180_000) // 180s ago

    mockFindFirst.mockResolvedValue({
      id: 'pt-1',
      network: 'testnet',
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      source: 'SDEX',
      price: 0.10,
      timestamp: oldOnChainTime,
    })

    mockFindMany.mockResolvedValue([
      {
        id: 'pt-2',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'binance',
        price: 0.105,
        timestamp: oldCexTime,
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/premium/XLM/USDC',
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.code).toBe('STALE_DATA')
    expect(body.stale).toBe('both')
    expect(body.onChainAgeSeconds).toBeGreaterThanOrEqual(89)
    expect(body.cexAgeSeconds).toBeGreaterThanOrEqual(179)
  })

  it('unknown network: returns 400', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/premium/XLM/USDC?network=fakenet',
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toContain('Invalid network "fakenet"')
  })

  it('respects configurable PREMIUM_STALENESS_SECONDS env var', async () => {
    process.env.PREMIUM_STALENESS_SECONDS = '10' // 10s staleness threshold
    const now = new Date()
    const time = new Date(now.getTime() - 15_000) // 15s ago (> 10s, but < 60s default)

    mockFindFirst.mockResolvedValue({
      id: 'pt-1',
      network: 'testnet',
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      source: 'SDEX',
      price: 0.10,
      timestamp: time,
    })

    mockFindMany.mockResolvedValue([
      {
        id: 'pt-2',
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'USDC/XLM',
        source: 'binance',
        price: 0.105,
        timestamp: now,
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/premium/XLM/USDC',
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.stale).toBe('onChain')
  })
})
