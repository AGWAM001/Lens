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
  scheduleAuditRetention,
  resolveRetentionDays,
  resolveIntEnv,
  MIN_RETENTION_DAYS,
  AUDIT_PRUNE_BATCH_SIZE,
  AUDIT_PRUNE_MAX_BATCHES,
  AUDIT_PRUNE_BATCH_PAUSE_MS,
  VENUE_DISPERSION_RETENTION_DAYS,
  QUARANTINED_PRICE_POINT_RETENTION_DAYS,
  ORACLE_PUBLICATION_RETENTION_DAYS,
} from '../jobs/auditRetention'
import { activeNetwork } from '../config'

/**
 * Fake database for the prune queries. `state[table][pairKey]` is the queue
 * of rowCounts successive DELETE batches for that pair return; an exhausted
 * or missing queue means the pair is drained (rowCount 0). The pair-listing
 * query answers with the pairs present in the state, so a test fails if the
 * prune skips a pair or a table.
 */
type FakeState = Record<string, Record<string, (number | null)[]>>

function fakeDb(state: FakeState) {
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('SELECT DISTINCT pair_key')) {
      const table = /FROM (\w+)/.exec(sql)?.[1] ?? 'unknown'
      const pairs = Object.keys(state[table] ?? {})
      return { rows: pairs.map(pair_key => ({ pair_key })), rowCount: pairs.length }
    }
    const table = /DELETE FROM (\w+) AS audit_rows/.exec(sql)?.[1] ?? 'unknown'
    const queue = state[table]?.[params[1] as string]
    const rowCount = queue && queue.length > 0 ? queue.shift() : 0
    return { rowCount }
  })
  return state
}

function deleteCalls() {
  return mockQuery.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM'))
}

function pairListCalls() {
  return mockQuery.mock.calls.filter(([sql]) => String(sql).includes('SELECT DISTINCT pair_key'))
}

describe('audit retention defaults', () => {
  it('keeps venue dispersions and quarantined points for 30 days, publications for 90', () => {
    expect(VENUE_DISPERSION_RETENTION_DAYS).toBe(30)
    expect(QUARANTINED_PRICE_POINT_RETENTION_DAYS).toBe(30)
    expect(ORACLE_PUBLICATION_RETENTION_DAYS).toBe(90)
  })

  it('floors retention at 1 day, with a higher 30-day floor for oracle_publications', () => {
    expect(MIN_RETENTION_DAYS).toEqual({
      venue_dispersions: 1,
      quarantined_price_points: 1,
      oracle_publications: 30,
    })
  })

  it('defaults the batch size, per-run batch cap and batch pause', () => {
    expect(AUDIT_PRUNE_BATCH_SIZE).toBe(1_000)
    expect(AUDIT_PRUNE_MAX_BATCHES).toBe(100)
    expect(AUDIT_PRUNE_BATCH_PAUSE_MS).toBe(250)
  })
})

describe('resolveRetentionDays', () => {
  beforeEach(() => {
    auditLogger.error.mockClear()
  })

  it('treats an unset or empty value as the default', () => {
    expect(resolveRetentionDays(undefined, 30, 1, 'X_DAYS')).toBe(30)
    expect(resolveRetentionDays('', 30, 1, 'X_DAYS')).toBe(30)
    expect(resolveRetentionDays('   ', 90, 30, 'X_DAYS')).toBe(90)
    expect(auditLogger.error).not.toHaveBeenCalled()
  })

  it('accepts a value at or above the floor', () => {
    expect(resolveRetentionDays('45', 30, 1, 'X_DAYS')).toBe(45)
    expect(resolveRetentionDays('1', 30, 1, 'X_DAYS')).toBe(1)
    expect(resolveRetentionDays('30', 90, 30, 'X_DAYS')).toBe(30)
    expect(auditLogger.error).not.toHaveBeenCalled()
  })

  // A bad value must never throw: this resolver runs at module load, and
  // the module is imported by src/index.ts, so a throw would stop the
  // whole service booting. Each bad case logs an error and falls back to
  // the default (which is always at or above the floor).

  it('falls back to the default for 0 — the empty-variable delete-everything case', () => {
    expect(resolveRetentionDays('0', 30, 1, 'X_DAYS')).toBe(30)
    expect(resolveRetentionDays('0', 90, 30, 'X_DAYS')).toBe(90)
    expect(auditLogger.error).toHaveBeenCalledTimes(2)
  })

  it('falls back to the default for a negative value', () => {
    expect(resolveRetentionDays('-5', 30, 1, 'X_DAYS')).toBe(30)
    expect(auditLogger.error).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default for a non-numeric value', () => {
    expect(resolveRetentionDays('abc', 30, 1, 'X_DAYS')).toBe(30)
    expect(auditLogger.error).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default for a value with a unit suffix', () => {
    expect(resolveRetentionDays('30d', 30, 1, 'X_DAYS')).toBe(30)
    expect(auditLogger.error).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default for a value below the per-table floor', () => {
    expect(resolveRetentionDays('0.5', 30, 1, 'X_DAYS')).toBe(30)
    expect(auditLogger.error).toHaveBeenCalledTimes(1)
  })

  it('falls back to the 90-day default for ORACLE_PUBLICATION_RETENTION_DAYS=7, below the 30-day floor', () => {
    expect(resolveRetentionDays('7', 90, 30, 'ORACLE_PUBLICATION_RETENTION_DAYS')).toBe(90)
    expect(auditLogger.error).toHaveBeenCalledTimes(1)
    expect(auditLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ env: 'ORACLE_PUBLICATION_RETENTION_DAYS', value: '7' }),
      expect.stringContaining('below the minimum')
    )
  })
})

describe('resolveIntEnv', () => {
  beforeEach(() => {
    auditLogger.error.mockClear()
  })

  it('treats an unset or empty value as the default', () => {
    expect(resolveIntEnv(undefined, 1_000, 1, 'X')).toBe(1_000)
    expect(resolveIntEnv('', 250, 0, 'X')).toBe(250)
    expect(auditLogger.error).not.toHaveBeenCalled()
  })

  it('accepts a valid integer at or above the minimum', () => {
    expect(resolveIntEnv('500', 1_000, 1, 'X')).toBe(500)
    expect(resolveIntEnv('0', 250, 0, 'X')).toBe(0)
    expect(auditLogger.error).not.toHaveBeenCalled()
  })

  it('falls back to the default for a bad batch size', () => {
    expect(resolveIntEnv('0', 1_000, 1, 'AUDIT_PRUNE_BATCH_SIZE')).toBe(1_000)
    expect(resolveIntEnv('-10', 1_000, 1, 'AUDIT_PRUNE_BATCH_SIZE')).toBe(1_000)
    expect(resolveIntEnv('2.5', 1_000, 1, 'AUDIT_PRUNE_BATCH_SIZE')).toBe(1_000)
    expect(resolveIntEnv('abc', 1_000, 1, 'AUDIT_PRUNE_BATCH_SIZE')).toBe(1_000)
    expect(auditLogger.error).toHaveBeenCalledTimes(4)
  })

  it('falls back to the default for a bad max-batches value', () => {
    expect(resolveIntEnv('0', 100, 1, 'AUDIT_PRUNE_MAX_BATCHES')).toBe(100)
    expect(resolveIntEnv('-1', 100, 1, 'AUDIT_PRUNE_MAX_BATCHES')).toBe(100)
    expect(resolveIntEnv('abc', 100, 1, 'AUDIT_PRUNE_MAX_BATCHES')).toBe(100)
    expect(auditLogger.error).toHaveBeenCalledTimes(3)
  })

  it('falls back to the default for a bad batch-pause value', () => {
    expect(resolveIntEnv('-1', 250, 0, 'AUDIT_PRUNE_BATCH_PAUSE_MS')).toBe(250)
    expect(resolveIntEnv('abc', 250, 0, 'AUDIT_PRUNE_BATCH_PAUSE_MS')).toBe(250)
    expect(resolveIntEnv('30d', 250, 0, 'AUDIT_PRUNE_BATCH_PAUSE_MS')).toBe(250)
    expect(auditLogger.error).toHaveBeenCalledTimes(3)
  })
})

describe('per-table deletes', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('prunes venue_dispersions per pair on its timestamp column', async () => {
    fakeDb({ venue_dispersions: { 'XLM/USDC': [5] } })

    const pruned = await pruneOldVenueDispersions()

    expect(pruned).toBe(5)
    const [listSql, listParams] = pairListCalls()[0]
    expect(listSql).toMatch(/FROM venue_dispersions/)
    expect(listSql).toMatch(/timestamp < NOW\(\) - \(\$2 \|\| ' days'\)::interval/)
    expect(listParams).toEqual([activeNetwork, 30])
    const [sql, params] = deleteCalls()[0]
    expect(sql).toMatch(/DELETE FROM venue_dispersions AS audit_rows/)
    expect(sql).toMatch(/pair_key = \$2/)
    expect(sql).toMatch(/timestamp < NOW\(\) - \(\$3 \|\| ' days'\)::interval/)
    expect(sql).toMatch(/LIMIT \$4\s+FOR UPDATE SKIP LOCKED/)
    expect(params).toEqual([activeNetwork, 'XLM/USDC', 30, AUDIT_PRUNE_BATCH_SIZE])
    // One full batch, then the empty batch that ends the pair's drain.
    expect(deleteCalls()).toHaveLength(2)
  })

  it('prunes quarantined_price_points on its quarantined_at column', async () => {
    fakeDb({ quarantined_price_points: { 'XLM/USDC': [3] } })

    const pruned = await pruneOldQuarantinedPricePoints()

    expect(pruned).toBe(3)
    const [sql, params] = deleteCalls()[0]
    expect(sql).toMatch(/DELETE FROM quarantined_price_points AS audit_rows/)
    expect(sql).toMatch(/quarantined_at < NOW\(\) - \(\$3 \|\| ' days'\)::interval/)
    expect(params).toEqual([activeNetwork, 'XLM/USDC', 30, AUDIT_PRUNE_BATCH_SIZE])
  })

  it('prunes oracle_publications on its created_at column with the 90-day default', async () => {
    fakeDb({ oracle_publications: { 'XLM/USDC': [2] } })

    const pruned = await pruneOldOraclePublications()

    expect(pruned).toBe(2)
    const [sql, params] = deleteCalls()[0]
    expect(sql).toMatch(/DELETE FROM oracle_publications AS audit_rows/)
    expect(sql).toMatch(/created_at < NOW\(\) - \(\$3 \|\| ' days'\)::interval/)
    expect(params).toEqual([activeNetwork, 'XLM/USDC', 90, AUDIT_PRUNE_BATCH_SIZE])
  })

  it('loops over each pair in turn instead of scanning the whole network at once', async () => {
    fakeDb({ venue_dispersions: { 'AAA/BBB': [3], 'CCC/DDD': [4] } })

    const pruned = await pruneOldVenueDispersions()

    expect(pruned).toBe(7)
    expect(pairListCalls()).toHaveLength(1)
    // Each pair is drained (full batch, then the empty batch) before the
    // next pair starts, so every DELETE carries exactly one pair key.
    expect(deleteCalls().map(call => call[1][1])).toEqual(['AAA/BBB', 'AAA/BBB', 'CCC/DDD', 'CCC/DDD'])
  })

  it('returns 0 when there is nothing to delete', async () => {
    fakeDb({})

    await expect(pruneOldVenueDispersions()).resolves.toBe(0)
    await expect(pruneOldQuarantinedPricePoints()).resolves.toBe(0)
    await expect(pruneOldOraclePublications()).resolves.toBe(0)
    // Only the pair-listing query per table — no pair, no DELETE.
    expect(pairListCalls()).toHaveLength(3)
    expect(deleteCalls()).toHaveLength(0)
  })

  it('treats a null rowCount as a drained pair', async () => {
    fakeDb({ venue_dispersions: { 'XLM/USDC': [null] } })

    expect(await pruneOldVenueDispersions()).toBe(0)
  })

  it('honours a custom retention window and network', async () => {
    fakeDb({ oracle_publications: { 'XLM/USDC': [0] } })

    await pruneOldOraclePublications(45, 'mainnet')

    expect(deleteCalls()[0][1]).toEqual(['mainnet', 'XLM/USDC', 45, AUDIT_PRUNE_BATCH_SIZE])
  })

  it('drains multiple bounded batches, pausing between them and reporting cumulative progress', async () => {
    fakeDb({ venue_dispersions: { 'XLM/USDC': [2, 1] } })
    const sleep = vi.fn(async (_ms: number) => {})
    const onProgress = vi.fn()

    const pruned = await pruneOldVenueDispersions(14, 'mainnet', 2, onProgress, { batchPauseMs: 123, sleep })

    expect(pruned).toBe(3)
    expect(deleteCalls().map(call => call[1])).toEqual([
      ['mainnet', 'XLM/USDC', 14, 2],
      ['mainnet', 'XLM/USDC', 14, 2],
      ['mainnet', 'XLM/USDC', 14, 2],
    ])
    expect(onProgress).toHaveBeenLastCalledWith({
      table: 'venue_dispersions',
      network: 'mainnet',
      pairKey: 'XLM/USDC',
      batch: 2,
      batchRows: 1,
      totalPruned: 3,
    })
    // A pause before every batch after the first, none before the first.
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(123)
  })

  it('stops at the per-run batch cap and leaves the rest for the next run', async () => {
    fakeDb({ venue_dispersions: { 'XLM/USDC': [2, 2, 2, 2] } })

    const pruned = await pruneOldVenueDispersions(30, activeNetwork, 2, undefined, {
      maxBatches: 2,
      batchPauseMs: 0,
    })

    expect(pruned).toBe(4)
    expect(deleteCalls()).toHaveLength(2)
  })
})

describe('retention floors enforced at prune time', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('rejects a 0-day window before querying', async () => {
    await expect(pruneOldVenueDispersions(0)).rejects.toThrow(/at least 1/)
    await expect(pruneOldQuarantinedPricePoints(0)).rejects.toThrow(/at least 1/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects an oracle_publications window below its 30-day floor', async () => {
    await expect(pruneOldOraclePublications(7)).rejects.toThrow(/at least 30/)
    await expect(pruneOldOraclePublications(29)).rejects.toThrow(/at least 30/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('accepts an oracle_publications window at exactly its floor', async () => {
    fakeDb({})

    await expect(pruneOldOraclePublications(30)).resolves.toBe(0)
  })

  it('rejects an invalid batch size before querying', async () => {
    await expect(pruneOldVenueDispersions(30, activeNetwork, 0)).rejects.toThrow(/positive integer/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects an invalid batch cap before querying', async () => {
    await expect(
      pruneOldVenueDispersions(30, activeNetwork, AUDIT_PRUNE_BATCH_SIZE, undefined, { maxBatches: 0 })
    ).rejects.toThrow(/max batches/)
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

  it('prunes all three tables and reports per-table counts', async () => {
    delete process.env.ENABLED_NETWORKS
    fakeDb({
      venue_dispersions: { 'XLM/USDC': [4] },
      quarantined_price_points: { 'XLM/USDC': [6] },
      oracle_publications: { 'XLM/USDC': [1] },
    })

    const counts = await pruneAllAuditTables()

    expect(counts).toEqual({
      venue_dispersions: { [activeNetwork]: 4 },
      quarantined_price_points: { [activeNetwork]: 6 },
      oracle_publications: { [activeNetwork]: 1 },
    })
  })

  it('prunes every enabled network for each table', async () => {
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
    fakeDb({})

    await pruneAllAuditTables()

    const networks = [...new Set(pairListCalls().map(c => c[1][0]))]
    expect(networks).toEqual(['testnet', 'mainnet'])
    // 3 tables x 2 networks, one pair-listing query each, no DELETEs.
    expect(pairListCalls()).toHaveLength(6)
    expect(deleteCalls()).toHaveLength(0)
  })

  it('still prunes the other tables when one table fails, then reports the failure', async () => {
    delete process.env.ENABLED_NETWORKS
    const attempted: string[] = []
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT pair_key')) {
        const table = /FROM (\w+)/.exec(sql)?.[1] ?? 'unknown'
        attempted.push(table)
        return { rows: [{ pair_key: 'XLM/USDC' }], rowCount: 1 }
      }
      const table = /DELETE FROM (\w+) AS audit_rows/.exec(sql)?.[1] ?? 'unknown'
      if (table === 'quarantined_price_points') throw new Error('boom')
      return { rowCount: 0 }
    })

    await expect(pruneAllAuditTables()).rejects.toThrow(/quarantined_price_points/)
    expect(attempted).toEqual(['venue_dispersions', 'quarantined_price_points', 'oracle_publications'])
  })
})

describe('scheduleAuditRetention', () => {
  it('schedules the hourly prune and one immediate run via the shared helper', async () => {
    const queue = { add: vi.fn(async () => {}) } as any

    await scheduleAuditRetention(queue)

    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'prune',
      {},
      { repeat: { every: 60 * 60 * 1000 }, jobId: 'audit-retention:prune' }
    )
    expect(queue.add).toHaveBeenNthCalledWith(2, 'prune', {})
  })
})
