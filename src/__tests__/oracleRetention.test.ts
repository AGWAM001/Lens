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

const { retentionLogger } = vi.hoisted(() => ({
  retentionLogger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => retentionLogger,
  logger: retentionLogger,
  loggerOptions: () => ({}),
  createDestination: () => ({ write: () => {} }),
}))

import {
  pruneOldOracleComparisons,
  pruneAllNetworksOracleComparisons,
  ORACLE_COMPARISON_PRUNE_BATCH_SIZE,
  ORACLE_COMPARISON_RETENTION_DAYS,
  type OraclePruneProgress,
} from '../jobs/oracleRetention'
import { activeNetwork } from '../config'

describe('pruneOldOracleComparisons', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('defaults to the 30-day retention window', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 12 }).mockResolvedValueOnce({ rowCount: 0 })

    const pruned = await pruneOldOracleComparisons()

    expect(ORACLE_COMPARISON_RETENTION_DAYS).toBe(30)
    expect(pruned).toBe(12)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 30, ORACLE_COMPARISON_PRUNE_BATCH_SIZE])
    expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM oracle_comparisons AS oc/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/LIMIT \$3\s+FOR UPDATE SKIP LOCKED/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/timestamp < NOW\(\) - \(\$2 \|\| ' days'\)::interval/)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('honors a custom retention window', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    const pruned = await pruneOldOracleComparisons(14)

    expect(pruned).toBe(0)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 14, ORACLE_COMPARISON_PRUNE_BATCH_SIZE])
  })

  it('returns 0 when rowCount is null', async () => {
    mockQuery.mockResolvedValue({ rowCount: null })

    expect(await pruneOldOracleComparisons()).toBe(0)
  })

  it('binds the requested network instead of the active one', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 0 })

    await pruneOldOracleComparisons(30, 'mainnet')
    await pruneOldOracleComparisons(30, 'testnet')

    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 30, ORACLE_COMPARISON_PRUNE_BATCH_SIZE])
    expect(mockQuery.mock.calls[2][1]).toEqual(['testnet', 30, ORACLE_COMPARISON_PRUNE_BATCH_SIZE])
  })

  it('drains multiple bounded batches and invokes onProgress', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 50 })
      .mockResolvedValueOnce({ rowCount: 30 })
      .mockResolvedValueOnce({ rowCount: 0 })

    const progress: OraclePruneProgress[] = []
    const pruned = await pruneOldOracleComparisons(30, 'testnet', 50, p => progress.push({ ...p }))

    expect(pruned).toBe(80)
    expect(progress).toEqual([
      { network: 'testnet', batch: 1, batchRows: 50, totalPruned: 50 },
      { network: 'testnet', batch: 2, batchRows: 30, totalPruned: 80 },
    ])
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('rejects an invalid batch size', async () => {
    await expect(pruneOldOracleComparisons(30, 'testnet', 0)).rejects.toThrow(RangeError)
    await expect(pruneOldOracleComparisons(30, 'testnet', -5)).rejects.toThrow(RangeError)
    await expect(pruneOldOracleComparisons(30, 'testnet', 1.5)).rejects.toThrow(RangeError)
  })
})

describe('pruneAllNetworksOracleComparisons', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('prunes all configured networks and returns summary counts', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    const result = await pruneAllNetworksOracleComparisons(30)
    expect(result).toHaveProperty('testnet')
  })
})
