import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: vi.fn() },
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

/**
 * The retention settings are resolved at module load, and the module is
 * imported by src/index.ts — so a bad environment value must never make
 * the import throw, or one mistyped variable would stop the whole service
 * booting. These tests set the environment before importing the module
 * fresh and assert the resolved constants.
 */
describe('audit retention environment at module load', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    auditLogger.error.mockClear()
  })

  it('imports cleanly and falls back to the defaults when every value is bad', async () => {
    vi.stubEnv('VENUE_DISPERSION_RETENTION_DAYS', '0')
    vi.stubEnv('QUARANTINED_PRICE_POINT_RETENTION_DAYS', 'abc')
    vi.stubEnv('ORACLE_PUBLICATION_RETENTION_DAYS', '7')
    vi.stubEnv('AUDIT_PRUNE_BATCH_SIZE', '-5')
    vi.stubEnv('AUDIT_PRUNE_MAX_BATCHES', '30d')
    vi.stubEnv('AUDIT_PRUNE_BATCH_PAUSE_MS', 'soon')

    const mod = await import('../jobs/auditRetention')

    expect(mod.VENUE_DISPERSION_RETENTION_DAYS).toBe(30)
    expect(mod.QUARANTINED_PRICE_POINT_RETENTION_DAYS).toBe(30)
    // 7 is below the 30-day floor for oracle_publications, so the 90-day
    // default applies — the floor still cannot be pruned under.
    expect(mod.ORACLE_PUBLICATION_RETENTION_DAYS).toBe(90)
    expect(mod.AUDIT_PRUNE_BATCH_SIZE).toBe(1_000)
    expect(mod.AUDIT_PRUNE_MAX_BATCHES).toBe(100)
    expect(mod.AUDIT_PRUNE_BATCH_PAUSE_MS).toBe(250)
    expect(mod.AUDIT_TABLES.map(t => t.retentionDays)).toEqual([30, 30, 90])
    expect(auditLogger.error).toHaveBeenCalledTimes(6)
  })

  it('imports cleanly and uses the defaults when every value is empty', async () => {
    vi.stubEnv('VENUE_DISPERSION_RETENTION_DAYS', '')
    vi.stubEnv('QUARANTINED_PRICE_POINT_RETENTION_DAYS', '')
    vi.stubEnv('ORACLE_PUBLICATION_RETENTION_DAYS', '')
    vi.stubEnv('AUDIT_PRUNE_BATCH_SIZE', '')
    vi.stubEnv('AUDIT_PRUNE_MAX_BATCHES', '')
    vi.stubEnv('AUDIT_PRUNE_BATCH_PAUSE_MS', '')

    const mod = await import('../jobs/auditRetention')

    expect(mod.VENUE_DISPERSION_RETENTION_DAYS).toBe(30)
    expect(mod.ORACLE_PUBLICATION_RETENTION_DAYS).toBe(90)
    expect(mod.AUDIT_PRUNE_BATCH_SIZE).toBe(1_000)
    expect(auditLogger.error).not.toHaveBeenCalled()
  })

  it('honours valid values at or above the floors', async () => {
    vi.stubEnv('VENUE_DISPERSION_RETENTION_DAYS', '45')
    vi.stubEnv('ORACLE_PUBLICATION_RETENTION_DAYS', '30')
    vi.stubEnv('AUDIT_PRUNE_BATCH_SIZE', '500')

    const mod = await import('../jobs/auditRetention')

    expect(mod.VENUE_DISPERSION_RETENTION_DAYS).toBe(45)
    expect(mod.ORACLE_PUBLICATION_RETENTION_DAYS).toBe(30)
    expect(mod.AUDIT_PRUNE_BATCH_SIZE).toBe(500)
    expect(auditLogger.error).not.toHaveBeenCalled()
  })
})
