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

const { auditLogger } = vi.hoisted(() => ({
  auditLogger: {
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
  createLogger: () => auditLogger,
  logger: auditLogger,
  loggerOptions: () => ({}),
  createDestination: () => ({ write: () => {} }),
}))

import {
  pruneOldVenueDispersions,
  pruneOldQuarantinedPricePoints,
  pruneOldOraclePublications,
  pruneAllAuditTables,
  AUDIT_PRUNE_BATCH_SIZE,
  VENUE_DISPERSION_RETENTION_DAYS,
  QUARANTINED_PRICE_POINT_RETENTION_DAYS,
  ORACLE_PUBLICATION_RETENTION_DAYS,
} from '../jobs/auditRetention'
import { activeNetwork } from '../config'

describe('audit retention defaults', () => {
  it('keeps venue dispersions and quarantined points for 30 days, publications for 90', () => {
    expect(VENUE_DISPERSION_RETENTION_DAYS).toBe(30)
    expect(QUARANTINED_PRICE_POINT_RETENTION_DAYS).toBe(30)
    expect(ORACLE_PUBLICATION_RETENTION_DAYS).toBe(90)
  })
})

describe('per-table deletes', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('prunes venue_dispersions on its timestamp column', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 5 }).mockResolvedValueOnce({ rowCount: 0 })

    const pruned = await pruneOldVenueDispersions()

    expect(pruned).toBe(5)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/DELETE FROM venue_dispersions AS audit_rows/)
    expect(sql).toMatch(/timestamp < NOW\(\) - \(\$2 \|\| ' days'\)::interval/)
    expect(sql).toMatch(/LIMIT \$3\s+FOR UPDATE SKIP LOCKED/)
    expect(params).toEqual([activeNetwork, 30, AUDIT_PRUNE_BATCH_SIZE])
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('prunes quarantined_price_points on its quarantined_at column', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 3 }).mockResolvedValueOnce({ rowCount: 0 })

    const pruned = await pruneOldQuarantinedPricePoints()

    expect(pruned).toBe(3)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/DELETE FROM quarantined_price_points AS audit_rows/)
    expect(sql).toMatch(/quarantined_at < NOW\(\) - \(\$2 \|\| ' days'\)::interval/)
    expect(params).toEqual([activeNetwork, 30, AUDIT_PRUNE_BATCH_SIZE])
  })

  it('prunes oracle_publications on its created_at column with the 90-day default', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 2 }).mockResolvedValueOnce({ rowCount: 0 })

    const pruned = await pruneOldOraclePublications()

    expect(pruned).toBe(2)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/DELETE FROM oracle_publications AS audit_rows/)
    expect(sql).toMatch(/created_at < NOW\(\) - \(\$2 \|\| ' days'\)::interval/)
    expect(params).toEqual([activeNetwork, 90, AUDIT_PRUNE_BATCH_SIZE])
  })

  it('returns 0 when there is nothing to delete', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    await expect(pruneOldVenueDispersions()).resolves.toBe(0)
    await expect(pruneOldQuarantinedPricePoints()).resolves.toBe(0)
    await expect(pruneOldOraclePublications()).resolves.toBe(0)
    // One empty batch per table — the drain loop stops immediately.
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('returns 0 when rowCount is null', async () => {
    mockQuery.mockResolvedValue({ rowCount: null })

    expect(await pruneOldVenueDispersions()).toBe(0)
  })

  it('honours a custom retention window and network', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })

    await pruneOldOraclePublications(7, 'mainnet')

    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 7, AUDIT_PRUNE_BATCH_SIZE])
  })

  it('drains multiple bounded batches and reports cumulative progress', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
    const onProgress = vi.fn()

    expect(await pruneOldVenueDispersions(14, 'mainnet', 2, onProgress)).toBe(3)
    expect(mockQuery.mock.calls.map(call => call[1])).toEqual([
      ['mainnet', 14, 2],
      ['mainnet', 14, 2],
      ['mainnet', 14, 2],
    ])
    expect(onProgress).toHaveBeenLastCalledWith({
      table: 'venue_dispersions',
      network: 'mainnet',
      batch: 2,
      batchRows: 1,
      totalPruned: 3,
    })
  })

  it('rejects an invalid batch size before querying', async () => {
    await expect(pruneOldVenueDispersions(30, activeNetwork, 0)).rejects.toThrow(/positive integer/)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('pruneAllAuditTables', () => {
  const saved = process.env.ENABLED_NETWORKS

  beforeEach(() => {
    mockQuery.mockReset()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.ENABLED_NETWORKS
    else process.env.ENABLED_NETWORKS = saved
  })

  // Fake database keyed by table name parsed from the SQL, so the test fails
  // if any table is skipped. Each table drains after its first batch.
  function fakeTables(rows: Record<string, number>) {
    mockQuery.mockImplementation(async (sql: string) => {
      const table = /FROM (\w+) AS audit_rows/.exec(sql)?.[1] ?? 'unknown'
      const count = rows[table] ?? 0
      rows[table] = 0
      return { rowCount: count }
    })
    return rows
  }

  it('prunes all three tables and reports per-table counts', async () => {
    delete process.env.ENABLED_NETWORKS
    const rows = fakeTables({ venue_dispersions: 4, quarantined_price_points: 6, oracle_publications: 1 })

    const counts = await pruneAllAuditTables()

    expect(counts).toEqual({
      venue_dispersions: { [activeNetwork]: 4 },
      quarantined_price_points: { [activeNetwork]: 6 },
      oracle_publications: { [activeNetwork]: 1 },
    })
    expect(rows).toEqual({ venue_dispersions: 0, quarantined_price_points: 0, oracle_publications: 0 })
  })

  it('prunes every enabled network for each table', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    fakeTables({ venue_dispersions: 0, quarantined_price_points: 0, oracle_publications: 0 })

    await pruneAllAuditTables()

    const networks = [...new Set(mockQuery.mock.calls.map(c => c[1][0]))]
    expect(networks).toEqual(['testnet', 'mainnet'])
    // 3 tables x 2 networks, one empty batch each.
    expect(mockQuery).toHaveBeenCalledTimes(6)
  })

  it('still prunes the other tables when one table fails, then reports the failure', async () => {
    delete process.env.ENABLED_NETWORKS
    const attempted: string[] = []
    mockQuery.mockImplementation(async (sql: string) => {
      const table = /FROM (\w+) AS audit_rows/.exec(sql)?.[1] ?? 'unknown'
      attempted.push(table)
      if (table === 'quarantined_price_points') throw new Error('boom')
      return { rowCount: 0 }
    })

    await expect(pruneAllAuditTables()).rejects.toThrow(/quarantined_price_points/)
    expect(attempted).toEqual(['venue_dispersions', 'quarantined_price_points', 'oracle_publications'])
  })
})
