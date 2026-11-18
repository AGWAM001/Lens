import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ingestBlendPool,
  ingestBlendPools,
  blendAdapter,
  _resetLastPrice,
  _getLastPrice,
  type BlendPoolData,
} from '../ingest/venues/blend'
import * as dbModule from '../db'
import { blend_pool_errors_total, blend_rates_ingested_total } from '../metrics'

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../logger', () => ({
  createLogger: () => mockLogger,
  logger: mockLogger,
}))

vi.mock('../db', () => ({
  insertLendingRates: vi.fn().mockResolvedValue(1),
  getLatestLendingRates: vi.fn().mockResolvedValue([]),
}))

describe('Blend Ingester & Fault Isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetLastPrice()
  })

  const mockPoolId = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
  const mockAssetId = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75' // USDC

  const samplePoolData: BlendPoolData = {
    poolId: mockPoolId,
    network: 'mainnet',
    backstopRate: 1_000_000n, // 10%
    reserves: [
      {
        assetId: mockAssetId,
        assetSymbol: 'USDC',
        rateDecimals: 12,
        config: {
          index: 0,
          decimals: 7,
          util: 7_500_000,
          r_base: 100_000,
          r_one: 400_000,
          r_two: 2_000_000,
          r_three: 5_000_000,
        },
        data: {
          b_supply: 2_000_000_0000000n, // 2M USDC
          d_supply: 1_000_000_0000000n, // 1M USDC borrowed => 50% util
          b_rate: 10n ** 12n,
          d_rate: 10n ** 12n,
          ir_mod: 10_000_000n,
        },
      },
    ],
  }

  it('successfully ingests a healthy pool and writes rates with network', async () => {
    const mockFetch = vi.fn().mockResolvedValue(samplePoolData)
    const incSpy = vi.spyOn(blend_rates_ingested_total, 'inc')

    const rates = await ingestBlendPool(mockPoolId, 'mainnet', mockFetch)

    expect(rates.length).toBe(1)
    expect(rates[0].poolId).toBe(mockPoolId)
    expect(rates[0].asset).toBe('USDC')
    expect(rates[0].assetAddress).toBe(mockAssetId)
    expect(rates[0].source).toBe('blend')
    expect(rates[0].utilization).toBe(0.5)
    expect(rates[0].totalSupply).toBe(2_000_000)
    expect(rates[0].totalBorrowed).toBe(1_000_000)
    expect(rates[0].reserves).toBe(1_000_000)

    // Must write to database with explicit network
    expect(dbModule.insertLendingRates).toHaveBeenCalledTimes(1)
    expect(dbModule.insertLendingRates).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          poolId: mockPoolId,
          asset: 'USDC',
          source: 'blend',
        }),
      ]),
      'mainnet'
    )

    expect(incSpy).toHaveBeenCalledWith({ pool: mockPoolId, network: 'mainnet' }, 1)
  })

  it('skips a pool that returns null/empty with a metric and log, never crashing', async () => {
    const mockFetch = vi.fn().mockResolvedValue(null)
    const errMetricSpy = vi.spyOn(blend_pool_errors_total, 'inc')
    const warnSpy = mockLogger.warn

    // Must not throw
    const rates = await ingestBlendPool(mockPoolId, 'testnet', mockFetch)

    expect(rates).toEqual([])
    expect(dbModule.insertLendingRates).not.toHaveBeenCalled()
    expect(errMetricSpy).toHaveBeenCalledWith({ pool: mockPoolId, network: 'testnet' })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('skips a pool that throws an RPC network error with a metric and log, never crashing', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('RPC request timed out'))
    const errMetricSpy = vi.spyOn(blend_pool_errors_total, 'inc')
    const errLogSpy = mockLogger.error

    // Must not throw or crash
    const rates = await ingestBlendPool(mockPoolId, 'mainnet', mockFetch)

    expect(rates).toEqual([])
    expect(dbModule.insertLendingRates).not.toHaveBeenCalled()
    expect(errMetricSpy).toHaveBeenCalledWith({ pool: mockPoolId, network: 'mainnet' })
    expect(errLogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pool: mockPoolId, network: 'mainnet', err: expect.objectContaining({ message: 'RPC request timed out' }) }),
      'failed to ingest Blend pool'
    )
  })

  it('continues ingesting other pools when one pool fails in ingestBlendPools', async () => {
    const pool1 = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
    const pool2 = 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS'

    const mockIngest = vi.fn().mockImplementation(async (poolId) => {
      if (poolId === pool1) {
        throw new Error('Simulated pool corruption')
      }
      return [
        {
          poolId: pool2,
          asset: 'USDC',
          supplyApy: 0.05,
          borrowApy: 0.08,
          utilization: 0.6,
        },
      ]
    })

    const count = await ingestBlendPools('mainnet', mockIngest)
    // Should still ingest the second pool
    expect(count).toBeGreaterThanOrEqual(1)
    expect(mockIngest).toHaveBeenCalled()
  })

  it('implements VenueAdapter contract and reference helper functions', () => {
    expect(blendAdapter.name).toBe('Blend')
    expect(blendAdapter.source).toBe('blend')
    expect(typeof blendAdapter.isEnabled).toBe('function')
    expect(typeof blendAdapter.getPollIntervalMs).toBe('function')
    expect(typeof blendAdapter.discover).toBe('function')
    expect(typeof blendAdapter.read).toBe('function')
    expect(typeof blendAdapter.derive).toBe('function')
    expect(typeof blendAdapter.write).toBe('function')
    expect(typeof blendAdapter.ingestPair).toBe('function')

    // Reset last price helper
    _resetLastPrice()
    expect(_getLastPrice('mainnet', 'XLM/USDC')).toBeUndefined()
  })

  it('enforces network isolation: testnet and mainnet never cross-contaminate', async () => {
    const mockFetch = vi.fn().mockResolvedValue(samplePoolData)

    await ingestBlendPool(mockPoolId, 'testnet', mockFetch)
    expect(dbModule.insertLendingRates).toHaveBeenLastCalledWith(expect.any(Array), 'testnet')

    await ingestBlendPool(mockPoolId, 'mainnet', mockFetch)
    expect(dbModule.insertLendingRates).toHaveBeenLastCalledWith(expect.any(Array), 'mainnet')
  })
})
