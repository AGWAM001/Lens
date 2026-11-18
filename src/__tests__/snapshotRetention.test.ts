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

// The retention job logs batch progress through the structured logger; capture
// those calls without touching stdout.
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
  pruneOldSnapshots,
  pruneAllNetworks,
  SNAPSHOT_PRUNE_BATCH_SIZE,
  SNAPSHOT_RETENTION_DAYS,
} from '../jobs/snapshotRetention'
import { activeNetwork } from '../config'

describe('pruneOldSnapshots', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('defaults to the 30-day retention window', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 5 }).mockResolvedValueOnce({ rowCount: 0 })

    const pruned = await pruneOldSnapshots()

    expect(SNAPSHOT_RETENTION_DAYS).toBe(30)
    expect(pruned).toBe(5)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 30, SNAPSHOT_PRUNE_BATCH_SIZE])
    expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM price_snapshots AS snapshots/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/LIMIT \$3\s+FOR UPDATE SKIP LOCKED/)
    expect(mockQuery.mock.calls[0][0]).toMatch(/ts < NOW\(\) - \(\$2 \|\| ' days'\)::interval/)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('honors a custom retention window', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    const pruned = await pruneOldSnapshots(7)

    expect(pruned).toBe(0)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 7, SNAPSHOT_PRUNE_BATCH_SIZE])
  })

  it('returns 0 when rowCount is null', async () => {
    mockQuery.mockResolvedValue({ rowCount: null })

    expect(await pruneOldSnapshots()).toBe(0)
  })
})

describe('pruneOldSnapshots network argument', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('binds the requested network instead of the active one', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 0 })

    await pruneOldSnapshots(30, 'mainnet')
    await pruneOldSnapshots(30, 'testnet')

    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 30, SNAPSHOT_PRUNE_BATCH_SIZE])
    expect(mockQuery.mock.calls[2][1]).toEqual(['testnet', 30, SNAPSHOT_PRUNE_BATCH_SIZE])
  })

  it('drains multiple bounded batches and reports cumulative progress', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
    retentionLogger.info.mockClear()
    const onProgress = vi.fn()

    expect(await pruneOldSnapshots(14, 'mainnet', 2, onProgress)).toBe(3)
    expect(mockQuery.mock.calls.map(call => call[1])).toEqual([
      ['mainnet', 14, 2],
      ['mainnet', 14, 2],
      ['mainnet', 14, 2],
    ])
    expect(retentionLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'mainnet', batch: 2, rows: 1, total: 3 }),
      'pruned retention batch'
    )
    expect(onProgress).toHaveBeenLastCalledWith({ network: 'mainnet', batch: 2, batchRows: 1, totalPruned: 3 })
  })

  it('rejects an invalid batch size before querying', async () => {
    await expect(pruneOldSnapshots(30, activeNetwork, 0)).rejects.toThrow(/positive integer/)
    expect(mockQuery).not.toHaveBeenCalled()
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

  // Fake table keyed by network, so the test fails if any network is skipped.
  function fakeTable(rows: Record<string, number>) {
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      const network = params[0] as string
      const count = rows[network] ?? 0
      rows[network] = 0
      return { rowCount: count }
    })
    return rows
  }

  it('prunes both networks on a dual-network process and reports per-network counts', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    const rows = fakeTable({ testnet: 4, mainnet: 9 })

    const counts = await pruneAllNetworks()

    expect(counts).toEqual({ testnet: 4, mainnet: 9 })
    expect(rows).toEqual({ testnet: 0, mainnet: 0 })
    // Each network drains until a batch comes back empty, so it is visited
    // more than once; the order of networks is what this test is about.
    expect([...new Set(mockQuery.mock.calls.map(c => c[1][0]))]).toEqual(['testnet', 'mainnet'])
  })

  it('prunes only the active network when ENABLED_NETWORKS is unset', async () => {
    delete process.env.ENABLED_NETWORKS
    fakeTable({ testnet: 1, mainnet: 1 })

    const counts = await pruneAllNetworks()

    expect(Object.keys(counts)).toEqual([activeNetwork])
    expect([...new Set(mockQuery.mock.calls.map(c => c[1][0]))]).toEqual([activeNetwork])
  })

  it('still prunes the other network when one fails, then reports the failure', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    let mainnetBatches = 0
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[0] === 'testnet') throw new Error('boom')
      // One batch of rows, then empty: a mock that always reports rows would
      // keep the drain loop going forever.
      mainnetBatches += 1
      return { rowCount: mainnetBatches === 1 ? 3 : 0 }
    })

    await expect(pruneAllNetworks()).rejects.toThrow(/testnet: boom/)
    expect([...new Set(mockQuery.mock.calls.map(c => c[1][0]))]).toEqual(['testnet', 'mainnet'])
  })
})
