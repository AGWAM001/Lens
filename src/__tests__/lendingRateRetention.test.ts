import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
}))

import {
  pruneOldRates,
  pruneAllRateNetworks,
  RATE_PRUNE_BATCH_SIZE,
  RATE_RETENTION_DAYS,
} from '../jobs/lendingRateRetention'
import { activeNetwork } from '../config'

describe('pruneOldRates', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('defaults to the 30-day retention window and bounded batch size', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 10 }).mockResolvedValueOnce({ rowCount: 0 })

    const pruned = await pruneOldRates()

    expect(RATE_RETENTION_DAYS).toBe(30)
    expect(pruned).toBe(10)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 30, RATE_PRUNE_BATCH_SIZE])
    expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM lending_rates AS rates/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/LIMIT \$3\s+FOR UPDATE SKIP LOCKED/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/timestamp < NOW\(\) - \(\$2 \|\| ' days'\)::interval/)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('honors a custom retention window', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    const pruned = await pruneOldRates(7)

    expect(pruned).toBe(0)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 7, RATE_PRUNE_BATCH_SIZE])
  })

  it('binds the requested network instead of the active one', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 5 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 0 })

    await pruneOldRates(30, 'mainnet')
    await pruneOldRates(30, 'testnet')

    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 30, RATE_PRUNE_BATCH_SIZE])
    expect(mockQuery.mock.calls[2][1]).toEqual(['testnet', 30, RATE_PRUNE_BATCH_SIZE])
  })

  it('drains multiple bounded batches and reports cumulative progress', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 0 })
    const onProgress = vi.fn()

    const total = await pruneOldRates(30, 'mainnet', 4, onProgress)
    expect(total).toBe(6)
    expect(mockQuery.mock.calls.map(call => call[1])).toEqual([
      ['mainnet', 30, 4],
      ['mainnet', 30, 4],
      ['mainnet', 30, 4],
    ])
    expect(onProgress).toHaveBeenLastCalledWith({
      network: 'mainnet',
      batch: 2,
      batchRows: 2,
      totalPruned: 6,
    })
  })

  it('rejects an invalid batchSize with a RangeError', async () => {
    await expect(pruneOldRates(30, 'mainnet', 0)).rejects.toThrow(RangeError)
    await expect(pruneOldRates(30, 'mainnet', -5)).rejects.toThrow(RangeError)
    await expect(pruneOldRates(30, 'mainnet', NaN)).rejects.toThrow(RangeError)
  })
})

describe('pruneAllRateNetworks', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('prunes every enabled network independently', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    const counts = await pruneAllRateNetworks(30)
    expect(typeof counts).toBe('object')
    expect(mockQuery).toHaveBeenCalled()
  })
})
