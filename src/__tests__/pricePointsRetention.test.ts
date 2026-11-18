import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

// bullmq pulls in ioredis at import time; stub it so the unit under test loads
// without a live Redis connection.
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
}))

import {
  pruneOldPricePoints,
  rollupOldPricePoints,
  pruneAllNetworks,
  PRICE_POINTS_RETENTION_DAYS,
  PRICE_POINTS_PRUNE_BATCH_SIZE,
} from '../jobs/pricePointsRetention'
import {
  price_points_pruned_total,
  price_points_rolled_up_total,
} from '../metrics'
import { activeNetwork } from '../config'

describe('pricePointsRetention configuration & defaults', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('defaults to 30-day retention window and 1000 batch size', () => {
    expect(PRICE_POINTS_RETENTION_DAYS).toBe(30)
    expect(PRICE_POINTS_PRUNE_BATCH_SIZE).toBe(1000)
  })

  it('rejects an invalid batch size before querying', async () => {
    await expect(pruneOldPricePoints(30, activeNetwork, 0)).rejects.toThrow(/positive integer/)
    await expect(pruneOldPricePoints(30, activeNetwork, -5)).rejects.toThrow(/positive integer/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects an invalid retention window before querying', async () => {
    await expect(pruneOldPricePoints(-1, activeNetwork)).rejects.toThrow(/non-negative/)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('rollupOldPricePoints', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('rolls raw points older than the window into 1h price_aggregates leading with network predicate', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ raw_count: 42, aggregate_count: 2 }],
      rowCount: 1,
    })

    const result = await rollupOldPricePoints(30, 'testnet')

    expect(result).toEqual({ rawCount: 42, aggregateCount: 2 })
    expect(mockQuery).toHaveBeenCalledTimes(1)

    const [sql, params] = mockQuery.mock.calls[0]
    expect(params).toEqual(['testnet', 30])

    // Query must target price_points and price_aggregates
    expect(sql).toMatch(/INSERT INTO price_aggregates/i)
    expect(sql).toMatch(/FROM price_points/i)

    // Leading network predicate
    expect(sql).toMatch(/WHERE network = \$1/i)
    expect(sql).toMatch(/timestamp < NOW\(\) - \(\$2 \|\| ' days'\)::interval/i)

    // Groups into hourly buckets ('1h' window)
    expect(sql).toMatch(/'1h'/i)
    expect(sql).toMatch(/date_trunc\('hour',\s*timestamp\)/i)

    // Aggregates OHLCV & VWAP with exact numeric arithmetic
    expect(sql).toMatch(/SUM\(price \* base_volume\)/i)
    expect(sql).toMatch(/MAX\(price\)/i)
    expect(sql).toMatch(/MIN\(price\)/i)
    expect(sql).toMatch(/ON CONFLICT \(network, pair_key, window, bucket\) DO UPDATE/i)
  })

  it('honors custom retention window and network', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ raw_count: 0, aggregate_count: 0 }],
      rowCount: 1,
    })

    const result = await rollupOldPricePoints(14, 'mainnet')

    expect(result).toEqual({ rawCount: 0, aggregateCount: 0 })
    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 14])
  })
})

describe('pruneOldPricePoints - rollup before prune, batching, and yielding', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('ensures raw points are rolled up before being pruned', async () => {
    const callOrder: string[] = []
    let deleteCount = 0

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO price_aggregates')) {
        callOrder.push('rollup')
        return { rows: [{ raw_count: 10, aggregate_count: 1 }] }
      }
      if (sql.includes('DELETE FROM price_points')) {
        callOrder.push('prune')
        deleteCount += 1
        return { rowCount: deleteCount === 1 ? 10 : 0 }
      }
      return { rowCount: 0 }
    })

    const result = await pruneOldPricePoints(30, 'testnet', 100, 0)

    expect(callOrder[0]).toBe('rollup')
    expect(callOrder[1]).toBe('prune')
    expect(result.rolledUp).toBe(10)
    expect(result.pruned).toBe(10)
  })

  it('aborts deletion if rollup fails to protect history', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Rollup failed: disk full'))

    await expect(pruneOldPricePoints(30, 'testnet')).rejects.toThrow('Rollup failed: disk full')

    // Only rollup attempted; delete must never be invoked
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO price_aggregates/i)
  })

  it('honors batch size, drains multiple batches, and yields between batches', async () => {
    // Call 1: rollup
    mockQuery.mockResolvedValueOnce({ rows: [{ raw_count: 5, aggregate_count: 1 }] })
    // Call 2: delete batch 1 (2 rows)
    mockQuery.mockResolvedValueOnce({ rowCount: 2 })
    // Call 3: delete batch 2 (2 rows)
    mockQuery.mockResolvedValueOnce({ rowCount: 2 })
    // Call 4: delete batch 3 (1 row)
    mockQuery.mockResolvedValueOnce({ rowCount: 1 })
    // Call 5: delete batch 4 (0 rows -> done)
    mockQuery.mockResolvedValueOnce({ rowCount: 0 })

    const yieldFn = vi.fn().mockResolvedValue(undefined)
    const onProgress = vi.fn()

    const result = await pruneOldPricePoints(30, 'mainnet', 2, 0, onProgress, yieldFn)

    expect(result).toEqual({
      network: 'mainnet',
      rolledUp: 5,
      pruned: 5,
      batches: 3,
    })

    // Batch size of 2 must be honoured in all delete calls
    const deleteCalls = mockQuery.mock.calls.slice(1)
    expect(deleteCalls.length).toBe(4)
    for (const call of deleteCalls) {
      expect(call[1]).toEqual(['mainnet', 30, 2])
      expect(call[0]).toMatch(/DELETE FROM price_points AS points/i)
      expect(call[0]).toMatch(/LIMIT \$3\s+FOR UPDATE SKIP LOCKED/i)
      expect(call[0]).toMatch(/network = \$1/i)
    }

    // yieldFn must be called between batches (3 batches with rows -> yielded 3 times)
    expect(yieldFn).toHaveBeenCalledTimes(3)
    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress).toHaveBeenLastCalledWith({
      network: 'mainnet',
      batch: 3,
      batchRows: 1,
      totalPruned: 5,
    })
  })
})

describe('metrics export', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('exports deleted rows and rolled up rows as prometheus metrics', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ raw_count: 50, aggregate_count: 3 }] })
    mockQuery.mockResolvedValueOnce({ rowCount: 50 })
    mockQuery.mockResolvedValueOnce({ rowCount: 0 })

    const prunedMetricSpy = vi.spyOn(price_points_pruned_total, 'inc')
    const rolledUpMetricSpy = vi.spyOn(price_points_rolled_up_total, 'inc')

    try {
      await pruneOldPricePoints(30, 'mainnet', 100, 0)

      expect(rolledUpMetricSpy).toHaveBeenCalledWith({ network: 'mainnet' }, 50)
      expect(prunedMetricSpy).toHaveBeenCalledWith({ network: 'mainnet' }, 50)
    } finally {
      prunedMetricSpy.mockRestore()
      rolledUpMetricSpy.mockRestore()
    }
  })
})

describe('pruneAllNetworks', () => {
  const saved = process.env.ENABLED_NETWORKS

  beforeEach(() => {
    mockQuery.mockReset()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.ENABLED_NETWORKS
    else process.env.ENABLED_NETWORKS = saved
  })

  it('prunes both networks on a dual-network deployment and reports results', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'

    // Mock rollup & delete for testnet, then mainnet
    mockQuery
      // testnet rollup
      .mockResolvedValueOnce({ rows: [{ raw_count: 10, aggregate_count: 1 }] })
      // testnet delete batch 1
      .mockResolvedValueOnce({ rowCount: 10 })
      // testnet delete batch 2 (done)
      .mockResolvedValueOnce({ rowCount: 0 })
      // mainnet rollup
      .mockResolvedValueOnce({ rows: [{ raw_count: 20, aggregate_count: 2 }] })
      // mainnet delete batch 1
      .mockResolvedValueOnce({ rowCount: 20 })
      // mainnet delete batch 2 (done)
      .mockResolvedValueOnce({ rowCount: 0 })

    const results = await pruneAllNetworks(30)

    expect(results.testnet?.pruned).toBe(10)
    expect(results.testnet?.rolledUp).toBe(10)
    expect(results.mainnet?.pruned).toBe(20)
    expect(results.mainnet?.rolledUp).toBe(20)

    // Must visit both networks in order
    const networksCalled = [...new Set(mockQuery.mock.calls.map(c => c[1][0]))]
    expect(networksCalled).toEqual(['testnet', 'mainnet'])
  })

  it('still prunes other networks if one network fails, then throws AggregateError', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'

    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[0] === 'testnet') {
        throw new Error('testnet db connection lost')
      }
      if (_sql.includes('INSERT INTO price_aggregates')) {
        return { rows: [{ raw_count: 15, aggregate_count: 1 }] }
      }
      // mainnet delete
      return { rowCount: 0 }
    })

    await expect(pruneAllNetworks(30)).rejects.toThrow(/testnet: testnet db connection lost/)

    const networksCalled = [...new Set(mockQuery.mock.calls.map(c => c[1][0]))]
    expect(networksCalled).toEqual(['testnet', 'mainnet'])
  })
})
