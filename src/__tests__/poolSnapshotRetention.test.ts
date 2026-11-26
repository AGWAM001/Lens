import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Unit tests for the batching loop and its guards. The SQL itself (newest row
// per pool survives, network scoping, age cutoff) runs against a real Postgres
// in poolSnapshotRetention.pg.test.ts.

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
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
  pruneOldPoolSnapshots,
  pruneAllPoolSnapshotNetworks,
  poolSnapshotHistoryLimitHours,
  poolSnapshotRetentionJob,
  PRUNE_BATCH_SQL,
  POOL_SNAPSHOT_PRUNE_BATCH_SIZE,
  POOL_SNAPSHOT_PRUNE_MAX_BATCHES,
  POOL_SNAPSHOT_PRUNE_PAUSE_MS,
  POOL_SNAPSHOT_RETENTION_DAYS,
  POOL_SNAPSHOT_RETENTION_ENABLED,
} from '../jobs/poolSnapshotRetention'
import { activeNetwork } from '../config'

/** A batch result as the prune statement returns it. */
const batch = (pruned: number, lastPoolId: string | null = pruned > 0 ? `pool-${pruned}` : null) => ({
  rows: [{ pruned, last_pool_id: lastPoolId }],
})

const noSleep = () => Promise.resolve()

describe('pool snapshot retention defaults', () => {
  it('is off by default, keeps 30 days, and drains in paused, capped batches', () => {
    expect(POOL_SNAPSHOT_RETENTION_ENABLED).toBe(false)
    expect(POOL_SNAPSHOT_RETENTION_DAYS).toBe(30)
    expect(POOL_SNAPSHOT_PRUNE_BATCH_SIZE).toBe(1_000)
    expect(POOL_SNAPSHOT_PRUNE_PAUSE_MS).toBe(100)
    expect(POOL_SNAPSHOT_PRUNE_MAX_BATCHES).toBe(100)
  })

  it('schedules hourly with a delayed first run', () => {
    expect(poolSnapshotRetentionJob.name).toBe('pool-snapshot-retention')
    expect(poolSnapshotRetentionJob.queueName).toBe(`${activeNetwork}:pool-snapshot-retention`)
    expect(poolSnapshotRetentionJob.everyMs).toBe(60 * 60 * 1000)
    expect(poolSnapshotRetentionJob.firstRunDelayMs).toBeGreaterThan(0)
  })
})

describe('pruneOldPoolSnapshots', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    retentionLogger.info.mockClear()
  })

  it('uses a per-row EXISTS check on the (network, pool_id, timestamp) index instead of a per-batch DISTINCT ON scan', () => {
    expect(PRUNE_BATCH_SQL).not.toMatch(/DISTINCT ON/)
    expect(PRUNE_BATCH_SQL).toMatch(/AND EXISTS \(\s*SELECT 1\s+FROM pool_snapshots newer\s+WHERE newer\.network = ps\.network\s+AND newer\.pool_id = ps\.pool_id\s+AND newer\.timestamp > ps\.timestamp/s)
    expect(PRUNE_BATCH_SQL).toMatch(/ORDER BY ps\.pool_id, ps\.timestamp DESC\s+LIMIT \$3\s+FOR UPDATE SKIP LOCKED/s)
  })

  it('passes network, retention days, batch size and an empty starting cursor', async () => {
    mockQuery.mockResolvedValueOnce(batch(4))

    const pruned = await pruneOldPoolSnapshots(undefined, undefined, { sleep: noSleep })

    expect(pruned).toBe(4)
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 30, POOL_SNAPSHOT_PRUNE_BATCH_SIZE, ''])
  })

  it('honors a custom retention window and returns 0 when nothing is eligible', async () => {
    mockQuery.mockResolvedValueOnce(batch(0))

    expect(await pruneOldPoolSnapshots(14, 'mainnet')).toBe(0)
    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 14, POOL_SNAPSHOT_PRUNE_BATCH_SIZE, ''])
  })

  it('treats an empty result set as nothing pruned', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await pruneOldPoolSnapshots(30, 'testnet')).toBe(0)
  })

  it('rejects invalid retention days, batch size, batch cap or pause before querying', async () => {
    await expect(pruneOldPoolSnapshots(0)).rejects.toThrow(/positive integer/)
    await expect(pruneOldPoolSnapshots(-5)).rejects.toThrow(/positive integer/)
    await expect(pruneOldPoolSnapshots(Number.NaN)).rejects.toThrow(/positive integer/)
    await expect(pruneOldPoolSnapshots(30, activeNetwork, { batchSize: 0 })).rejects.toThrow(/batch size/)
    await expect(pruneOldPoolSnapshots(30, activeNetwork, { maxBatches: 0 })).rejects.toThrow(/max batches/)
    await expect(pruneOldPoolSnapshots(30, activeNetwork, { pauseMs: -1 })).rejects.toThrow(/pause/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('resumes each batch from the pool cursor the previous batch returned', async () => {
    mockQuery
      .mockResolvedValueOnce(batch(2, 'pool-b'))
      .mockResolvedValueOnce(batch(2, 'pool-d'))
      .mockResolvedValueOnce(batch(0))
    const onProgress = vi.fn()

    expect(await pruneOldPoolSnapshots(30, 'mainnet', { batchSize: 2, onProgress, sleep: noSleep })).toBe(4)
    expect(mockQuery.mock.calls.map(call => call[1])).toEqual([
      ['mainnet', 30, 2, ''],
      ['mainnet', 30, 2, 'pool-b'],
      ['mainnet', 30, 2, 'pool-d'],
    ])
    expect(retentionLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'mainnet', batch: 2, rows: 2, total: 4 }),
      'pruned pool snapshot retention batch'
    )
    expect(onProgress).toHaveBeenLastCalledWith({ network: 'mainnet', batch: 2, batchRows: 2, totalPruned: 4 })
  })

  it('stops after a short batch without another query', async () => {
    mockQuery.mockResolvedValueOnce(batch(2, 'pool-b')).mockResolvedValueOnce(batch(1, 'pool-c'))

    expect(await pruneOldPoolSnapshots(30, 'testnet', { batchSize: 2, sleep: noSleep })).toBe(3)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('pauses between batches, not after the last one', async () => {
    mockQuery
      .mockResolvedValueOnce(batch(2))
      .mockResolvedValueOnce(batch(2))
      .mockResolvedValueOnce(batch(1))
    const sleep = vi.fn(noSleep)

    await pruneOldPoolSnapshots(30, 'testnet', { batchSize: 2, pauseMs: 250, sleep })

    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(250)
  })

  it('stops at the per-run batch cap and leaves the rest for the next run', async () => {
    mockQuery.mockResolvedValue(batch(2))
    const sleep = vi.fn(noSleep)

    expect(await pruneOldPoolSnapshots(30, 'testnet', { batchSize: 2, maxBatches: 3, sleep })).toBe(6)
    expect(mockQuery).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(retentionLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'testnet', batches: 3, total: 6 }),
      expect.stringMatching(/per-run batch cap/)
    )
  })
})

describe('pruneAllPoolSnapshotNetworks', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  afterEach(() => {
    delete process.env.ENABLED_NETWORKS
  })

  it('prunes all configured networks and collects errors without skipping healthy networks', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[0] === 'testnet') throw new Error('db timeout')
      return batch(3)
    })

    await expect(pruneAllPoolSnapshotNetworks()).rejects.toThrow(/testnet: db timeout/)
    expect([...new Set(mockQuery.mock.calls.map(c => c[1][0]))]).toEqual(['testnet', 'mainnet'])
  })

  it('returns per-network prune counts across enabled networks', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    const remaining: Record<string, number> = { testnet: 5, mainnet: 2 }
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      const net = params[0] as string
      const count = remaining[net] ?? 0
      remaining[net] = 0
      return batch(count)
    })

    expect(await pruneAllPoolSnapshotNetworks()).toEqual({ testnet: 5, mainnet: 2 })
  })
})

describe('poolSnapshotHistoryLimitHours', () => {
  it('is null while retention is off, since nothing is pruned', () => {
    expect(poolSnapshotHistoryLimitHours({})).toBeNull()
    expect(poolSnapshotHistoryLimitHours({ POOL_SNAPSHOT_RETENTION_ENABLED: 'false', POOL_SNAPSHOT_RETENTION_DAYS: '7' })).toBeNull()
  })

  it('is the retention period in hours while retention is on', () => {
    expect(poolSnapshotHistoryLimitHours({ POOL_SNAPSHOT_RETENTION_ENABLED: 'true' })).toBe(30 * 24)
    expect(poolSnapshotHistoryLimitHours({ POOL_SNAPSHOT_RETENTION_ENABLED: 'true', POOL_SNAPSHOT_RETENTION_DAYS: '7' })).toBe(7 * 24)
  })

  it('is null for a retention value the job would refuse to run with', () => {
    expect(poolSnapshotHistoryLimitHours({ POOL_SNAPSHOT_RETENTION_ENABLED: 'true', POOL_SNAPSHOT_RETENTION_DAYS: '0' })).toBeNull()
    expect(poolSnapshotHistoryLimitHours({ POOL_SNAPSHOT_RETENTION_ENABLED: 'true', POOL_SNAPSHOT_RETENTION_DAYS: 'abc' })).toBeNull()
  })
})
