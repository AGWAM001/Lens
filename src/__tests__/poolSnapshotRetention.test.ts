import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  pruneOldPoolSnapshots,
  pruneAllPoolSnapshotNetworks,
  POOL_SNAPSHOT_PRUNE_BATCH_SIZE,
  POOL_SNAPSHOT_RETENTION_DAYS,
} from '../jobs/poolSnapshotRetention'
import { activeNetwork } from '../config'

describe('pruneOldPoolSnapshots', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('defaults to a 30-day retention window and preserves each pool latest snapshot in batched SQL', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 4 }).mockResolvedValueOnce({ rowCount: 0 })

    const pruned = await pruneOldPoolSnapshots()

    expect(POOL_SNAPSHOT_RETENTION_DAYS).toBe(30)
    expect(pruned).toBe(4)
    expect(mockQuery.mock.calls[0][1]).toEqual([activeNetwork, 30, POOL_SNAPSHOT_PRUNE_BATCH_SIZE])

    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toMatch(/SELECT DISTINCT ON \(pool_id\) id\s+FROM pool_snapshots\s+WHERE network = \$1/s)
    expect(sql).toMatch(/AND NOT EXISTS/)
    expect(sql).toMatch(/DELETE FROM pool_snapshots AS snapshots/)
    expect(sql).toMatch(/LIMIT \$3\s+FOR UPDATE SKIP LOCKED/)
    expect(sql).toMatch(/ps\.timestamp < NOW\(\) - \(\$2 \|\| ' days'\)::interval/)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('honors a custom retention window and returns 0 when rowCount is null', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: null })

    const pruned = await pruneOldPoolSnapshots(14, 'mainnet')

    expect(pruned).toBe(0)
    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 14, POOL_SNAPSHOT_PRUNE_BATCH_SIZE])
  })

  it('rejects non-positive or non-integer retentionDays or batchSize before querying', async () => {
    await expect(pruneOldPoolSnapshots(0)).rejects.toThrow(/positive integer/)
    await expect(pruneOldPoolSnapshots(-5)).rejects.toThrow(/positive integer/)
    await expect(pruneOldPoolSnapshots(30, activeNetwork, 0)).rejects.toThrow(/positive integer/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('drains multiple bounded batches and reports cumulative progress', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
    retentionLogger.info.mockClear()
    const onProgress = vi.fn()

    expect(await pruneOldPoolSnapshots(30, 'mainnet', 2, onProgress)).toBe(3)
    expect(mockQuery.mock.calls.map(call => call[1])).toEqual([
      ['mainnet', 30, 2],
      ['mainnet', 30, 2],
      ['mainnet', 30, 2],
    ])
    expect(retentionLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'mainnet', batch: 2, rows: 1, total: 3 }),
      'pruned pool snapshot retention batch'
    )
    expect(onProgress).toHaveBeenLastCalledWith({
      network: 'mainnet',
      batch: 2,
      batchRows: 1,
      totalPruned: 3,
    })
  })

  it('preserves at least the newest row per pool even when a pool only has expired snapshots', async () => {
    type Row = { id: number; network: string; pool_id: string; timestamp: Date }
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const table: Row[] = [
      // Pool A: dormant for 45 days (single old snapshot must stay)
      { id: 1, network: 'testnet', pool_id: 'pool-dormant', timestamp: new Date(now - 45 * dayMs) },
      // Pool B: inactive for 40 days with 2 old snapshots -> id 2 deleted, id 3 kept
      { id: 2, network: 'testnet', pool_id: 'pool-two-old', timestamp: new Date(now - 50 * dayMs) },
      { id: 3, network: 'testnet', pool_id: 'pool-two-old', timestamp: new Date(now - 40 * dayMs) },
      // Pool C: active -> id 4 deleted (40d), id 5 kept (1d)
      { id: 4, network: 'testnet', pool_id: 'pool-active', timestamp: new Date(now - 40 * dayMs) },
      { id: 5, network: 'testnet', pool_id: 'pool-active', timestamp: new Date(now - 1 * dayMs) },
      // Other network rows untouched when pruning testnet
      { id: 6, network: 'mainnet', pool_id: 'pool-dormant', timestamp: new Date(now - 60 * dayMs) },
    ]

    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      const [network, days, limit] = params as [string, number, number]
      expect(sql).toMatch(/latest_per_pool/)
      const cutoff = now - days * dayMs

      const latestByPool = new Map<string, Row>()
      for (const row of table) {
        if (row.network !== network) continue
        const prev = latestByPool.get(row.pool_id)
        if (!prev || row.timestamp > prev.timestamp || (row.timestamp.getTime() === prev.timestamp.getTime() && row.id > prev.id)) {
          latestByPool.set(row.pool_id, row)
        }
      }
      const protectedIds = new Set([...latestByPool.values()].map(r => r.id))

      const eligible = table
        .filter(r => r.network === network && r.timestamp.getTime() < cutoff && !protectedIds.has(r.id))
        .slice(0, limit)
      const deleteIds = new Set(eligible.map(r => r.id))
      for (let i = table.length - 1; i >= 0; i--) {
        if (deleteIds.has(table[i].id)) table.splice(i, 1)
      }
      return { rowCount: deleteIds.size }
    })

    const pruned = await pruneOldPoolSnapshots(30, 'testnet', 1)

    expect(pruned).toBe(2)
    expect(table.map(r => r.id)).toEqual([1, 3, 5, 6])
  })
})

describe('pruneAllPoolSnapshotNetworks', () => {
  const saved = process.env.ENABLED_NETWORKS

  beforeEach(() => {
    mockQuery.mockReset()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.ENABLED_NETWORKS
    else process.env.ENABLED_NETWORKS = saved
  })

  it('prunes all configured networks and collects errors without skipping healthy networks', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    let mainnetBatches = 0
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[0] === 'testnet') throw new Error('db timeout')
      mainnetBatches += 1
      return { rowCount: mainnetBatches === 1 ? 3 : 0 }
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
      return { rowCount: count }
    })

    const counts = await pruneAllPoolSnapshotNetworks()

    expect(counts).toEqual({ testnet: 5, mainnet: 2 })
  })
})
