import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockComputeVWAP } = vi.hoisted(() => ({
  mockComputeVWAP: vi.fn(),
}))

vi.mock('../config', () => ({
  config: {
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: [],
  }),
}))

vi.mock('../pricing/twap', () => ({
  computeVWAP: mockComputeVWAP,
}))

import { registerPriceRoutes } from '../routes/price'
import { registerNetworkSelector } from '../middleware/network'

describe('GET /price/vwap/:assetA/:assetB network scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockComputeVWAP.mockReset()
  })

  it('defaults to activeNetwork when ?network is omitted', async () => {
    mockComputeVWAP.mockResolvedValue({
      vwap: 0.23,
      network: 'testnet',
      startTime: new Date(),
      endTime: new Date(),
      sampleCount: 2,
      volumeTotal: 1000,
      outlierRejected: 0,
      filterMethod: 'iqr',
    })

    const app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await app.register(registerPriceRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/price/vwap/XLM/USDC',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Fix: network field is included in response with activeNetwork value
    expect(body.network).toBe('testnet')
    // network is passed to computeVWAP with activeNetwork fallback
    const [pairKey, windowMinutes, options] = mockComputeVWAP.mock.calls[0]
    expect(options.network).toBe('testnet')
  })

  it('filters VWAP to mainnet when ?network=mainnet is specified', async () => {
    mockComputeVWAP.mockResolvedValue({
      vwap: 0.5,
      network: 'mainnet',
      startTime: new Date(),
      endTime: new Date(),
      sampleCount: 3,
      volumeTotal: 800,
      outlierRejected: 0,
      filterMethod: 'iqr',
    })

    const app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await app.register(registerPriceRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/price/vwap/XLM/USDC?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('mainnet')
    const [pairKey, windowMinutes, options] = mockComputeVWAP.mock.calls[0]
    expect(options.network).toBe('mainnet')
  })

  it('applies both network and source filters as AND condition', async () => {
    mockComputeVWAP.mockResolvedValue({
      vwap: 0.5625,
      network: 'mainnet',
      startTime: new Date(),
      endTime: new Date(),
      sampleCount: 2,
      volumeTotal: 400,
      outlierRejected: 0,
      filterMethod: 'iqr',
    })

    const app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await app.register(registerPriceRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/price/vwap/XLM/USDC?source=SDEX&network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('mainnet')
    expect(body.source).toBe('SDEX')
    const [pairKey, windowMinutes, options] = mockComputeVWAP.mock.calls[0]
    expect(options.source).toBe('SDEX')
    expect(options.network).toBe('mainnet')
    expect(options).toMatchObject({ source: 'SDEX', network: 'mainnet' })
  })
})