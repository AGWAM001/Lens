import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { createLogger } from '../logger'
import { scheduleRetentionJob } from './scheduleRetentionJob'

const log = createLogger('job:audit-retention')

const QUEUE_NAME = `${activeNetwork}:audit-retention`

export type AuditTable = 'venue_dispersions' | 'quarantined_price_points' | 'oracle_publications'

/**
 * Minimum retention window per table, in days. A window below the floor is
 * rejected — never silently honoured — because pruning is irreversible and
 * the previous guard (`retentionDays < 0`) let an empty environment variable
 * through: `Number('')` is 0, and a 0-day window deletes every row in the
 * table. The floors are:
 *
 * - `venue_dispersions` / `quarantined_price_points` — 1 day. Operational
 *   records; a day still leaves room for a deliberately short window while
 *   making "delete everything" unrepresentable.
 * - `oracle_publications` — 30 days. These rows are the only record of what
 *   Lens actually wrote on chain (see the model comment in
 *   `prisma/schema.prisma`), so their floor is far higher: even a
 *   misconfigured environment cannot erase the most recent month of
 *   on-chain evidence.
 */
export const MIN_RETENTION_DAYS: Record<AuditTable, number> = {
  venue_dispersions: 1,
  quarantined_price_points: 1,
  oracle_publications: 30,
}

/**
 * Resolves one table's retention window from its raw environment value.
 *
 * An unset or empty value means the default — an operator blanking a
 * variable in a dashboard must get the documented window, not a 0-day
 * delete-everything window. A non-numeric value, or one below the table's
 * floor, throws: a retention misconfiguration has to fail loudly at
 * startup rather than prune with a window nobody chose.
 */
export function resolveRetentionDays(
  rawValue: string | undefined,
  defaultDays: number,
  minDays: number,
  envName: string
): number {
  if (rawValue === undefined || rawValue.trim() === '') return defaultDays
  const days = Number(rawValue)
  if (!Number.isFinite(days)) {
    throw new RangeError(`${envName} must be a number of days, got ${JSON.stringify(rawValue)}`)
  }
  if (days < minDays) {
    throw new RangeError(
      `${envName} must be at least ${minDays} day(s) for this table, got ${days}; refusing a retention window below the floor`
    )
  }
  return days
}

/**
 * Resolves an integer tuning knob (batch size, batch cap, batch pause) from
 * its raw environment value, with the same rules as the retention windows:
 * unset or empty means the default, anything invalid throws at startup.
 */
export function resolveIntEnv(
  rawValue: string | undefined,
  defaultValue: number,
  minValue: number,
  envName: string
): number {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue
  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < minValue) {
    throw new RangeError(`${envName} must be an integer of at least ${minValue}, got ${JSON.stringify(rawValue)}`)
  }
  return value
}

/**
 * Retention windows for the three append-only audit tables pruned by this
 * job. Each window is read from the environment so an operator can widen or
 * narrow one table without touching the others, subject to the per-table
 * floors in MIN_RETENTION_DAYS.
 *
 * Defaults, and why they are safe:
 *
 * - `venue_dispersions` — 30 days. The only reader is the dispersion history
 *   route (`src/routes/dispersion.ts`), which returns at most 500 of the
 *   most recent rows per pair (50 by default) and offers no fixed long-range
 *   window. At the default reconciliation interval (60 s) those 500 rows
 *   cover roughly the last eight hours, so 30 days is far beyond anything a
 *   route serves, and it matches the snapshot / lending-rate / price-points
 *   retention already used across the service.
 * - `quarantined_price_points` — 30 days. Nothing serves these rows over the
 *   API; they are the diagnostic record of why ingest rejected a price
 *   point. Thirty days keeps a month of rejection evidence for investigating
 *   a misbehaving venue or a bad plausibility bound, on the same window as
 *   the price points they were rejected alongside.
 * - `oracle_publications` — 90 days. These rows are the audit evidence for
 *   every value Lens actually wrote on chain (see the model comment in
 *   `prisma/schema.prisma`), so they outlive the operational tables. They
 *   are written once per publish attempt — far less often than the other
 *   two — so the longer window costs little storage.
 */
export const VENUE_DISPERSION_RETENTION_DAYS = resolveRetentionDays(
  process.env.VENUE_DISPERSION_RETENTION_DAYS,
  30,
  MIN_RETENTION_DAYS.venue_dispersions,
  'VENUE_DISPERSION_RETENTION_DAYS'
)
export const QUARANTINED_PRICE_POINT_RETENTION_DAYS = resolveRetentionDays(
  process.env.QUARANTINED_PRICE_POINT_RETENTION_DAYS,
  30,
  MIN_RETENTION_DAYS.quarantined_price_points,
  'QUARANTINED_PRICE_POINT_RETENTION_DAYS'
)
export const ORACLE_PUBLICATION_RETENTION_DAYS = resolveRetentionDays(
  process.env.ORACLE_PUBLICATION_RETENTION_DAYS,
  90,
  MIN_RETENTION_DAYS.oracle_publications,
  'ORACLE_PUBLICATION_RETENTION_DAYS'
)
/** Maximum rows removed by one database statement during a retention run. */
export const AUDIT_PRUNE_BATCH_SIZE = resolveIntEnv(process.env.AUDIT_PRUNE_BATCH_SIZE, 1_000, 1, 'AUDIT_PRUNE_BATCH_SIZE')
/**
 * Maximum batches one run may execute per table and network. A run that
 * hits the cap stops and leaves the rest for the next scheduled run, so a
 * huge backlog drains over several hours instead of monopolising the
 * database in one sitting. At the default batch size this is 100,000 rows
 * per table per network per run.
 */
export const AUDIT_PRUNE_MAX_BATCHES = resolveIntEnv(process.env.AUDIT_PRUNE_MAX_BATCHES, 100, 1, 'AUDIT_PRUNE_MAX_BATCHES')
/**
 * Pause between two delete batches of one run. A real delay, not just an
 * event-loop yield: while a backlog drains, the database still has to serve
 * ingest and API reads between batches.
 */
export const AUDIT_PRUNE_BATCH_PAUSE_MS = resolveIntEnv(process.env.AUDIT_PRUNE_BATCH_PAUSE_MS, 250, 0, 'AUDIT_PRUNE_BATCH_PAUSE_MS')

interface AuditTableConfig {
  table: AuditTable
  /** Time column the retention cutoff is applied to. Each table has its own. */
  timeColumn: string
  retentionDays: number
  /** Floor the retention window is validated against; see MIN_RETENTION_DAYS. */
  minRetentionDays: number
}

/**
 * The tables this job prunes. Table and column names are fixed here and
 * never come from input, so interpolating them into the DELETE is safe;
 * every value (network, pair key, days, batch size) stays a bound parameter.
 */
export const AUDIT_TABLES: readonly AuditTableConfig[] = [
  {
    table: 'venue_dispersions',
    timeColumn: 'timestamp',
    retentionDays: VENUE_DISPERSION_RETENTION_DAYS,
    minRetentionDays: MIN_RETENTION_DAYS.venue_dispersions,
  },
  {
    table: 'quarantined_price_points',
    timeColumn: 'quarantined_at',
    retentionDays: QUARANTINED_PRICE_POINT_RETENTION_DAYS,
    minRetentionDays: MIN_RETENTION_DAYS.quarantined_price_points,
  },
  {
    table: 'oracle_publications',
    timeColumn: 'created_at',
    retentionDays: ORACLE_PUBLICATION_RETENTION_DAYS,
    minRetentionDays: MIN_RETENTION_DAYS.oracle_publications,
  },
]

export interface AuditPruneProgress {
  table: AuditTable
  network: NetworkName
  pairKey: string
  batch: number
  batchRows: number
  totalPruned: number
}

export interface AuditPruneOptions {
  /** Cap on batches executed by this run. Defaults to AUDIT_PRUNE_MAX_BATCHES. */
  maxBatches?: number
  /** Pause between batches, in milliseconds. Defaults to AUDIT_PRUNE_BATCH_PAUSE_MS. */
  batchPauseMs?: number
  /** Sleep implementation; injectable so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export function createAuditRetentionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

/**
 * Deletes one network's old rows from one audit table, one pair at a time
 * in bounded batches. Each batch filters on (network, pair_key, time) so it
 * is served by the table's existing `(network, pair_key, <time> DESC)`
 * index; the previous shape — network + time across every pair at once —
 * matched no index and scanned and sorted the whole network's expired rows
 * per batch. Locked rows are skipped so concurrent retention workers can
 * make progress without contending for the same batch.
 *
 * A run pauses between batches and stops after `maxBatches` batches,
 * leaving any remaining backlog for the next scheduled run. Returns the
 * total rows pruned. Exported separately from the worker so it can be unit
 * tested and invoked manually.
 */
export async function pruneAuditTable(
  config: AuditTableConfig,
  network: NetworkName = activeNetwork,
  batchSize: number = AUDIT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: AuditPruneProgress) => void,
  options: AuditPruneOptions = {}
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Audit prune batch size must be a positive integer')
  }
  if (!Number.isFinite(config.retentionDays) || config.retentionDays < config.minRetentionDays) {
    throw new RangeError(
      `Retention days for ${config.table} must be at least ${config.minRetentionDays}, got ${config.retentionDays}`
    )
  }
  const maxBatches = options.maxBatches ?? AUDIT_PRUNE_MAX_BATCHES
  if (!Number.isSafeInteger(maxBatches) || maxBatches <= 0) {
    throw new RangeError('Audit prune max batches must be a positive integer')
  }
  const batchPauseMs = options.batchPauseMs ?? AUDIT_PRUNE_BATCH_PAUSE_MS
  if (!Number.isFinite(batchPauseMs) || batchPauseMs < 0) {
    throw new RangeError('Audit prune batch pause must be a non-negative number of milliseconds')
  }
  const sleep = options.sleep ?? defaultSleep

  // The pairs that actually have expired rows, so pairs with nothing to
  // prune cost no delete at all. Ordered for deterministic progress logs.
  const pairResult = await pgPool.query(
    `SELECT DISTINCT pair_key
     FROM ${config.table}
     WHERE network = $1 AND ${config.timeColumn} < NOW() - ($2 || ' days')::interval
     ORDER BY pair_key`,
    [network, config.retentionDays]
  )
  const pairKeys = (pairResult.rows as { pair_key: string }[]).map(row => row.pair_key)

  let totalPruned = 0
  let batchNumber = 0
  let capped = false

  pairLoop:
  for (const pairKey of pairKeys) {
    while (true) {
      if (batchNumber >= maxBatches) {
        capped = true
        break pairLoop
      }
      // A real pause between batches — not before the run's first batch.
      if (batchNumber > 0 && batchPauseMs > 0) {
        await sleep(batchPauseMs)
      }
      const result = await pgPool.query(
        `WITH batch AS (
           SELECT ctid
           FROM ${config.table}
           WHERE network = $1 AND pair_key = $2 AND ${config.timeColumn} < NOW() - ($3 || ' days')::interval
           ORDER BY ${config.timeColumn}
           LIMIT $4
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM ${config.table} AS audit_rows
         USING batch
         WHERE audit_rows.ctid = batch.ctid`,
        [network, pairKey, config.retentionDays, batchSize]
      )
      const pruned = result.rowCount ?? 0
      if (pruned === 0) break

      totalPruned += pruned
      batchNumber += 1
      log.info(
        { table: config.table, network, pairKey, batch: batchNumber, rows: pruned, total: totalPruned },
        'pruned audit retention batch'
      )
      onProgress?.({ table: config.table, network, pairKey, batch: batchNumber, batchRows: pruned, totalPruned })
    }
  }

  if (capped) {
    log.warn(
      { table: config.table, network, maxBatches, totalPruned },
      'audit prune hit the per-run batch cap; remaining expired rows will be pruned by the next run'
    )
  }

  return totalPruned
}

/** Prunes old `venue_dispersions` rows for one network. */
export async function pruneOldVenueDispersions(
  retentionDays: number = VENUE_DISPERSION_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = AUDIT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: AuditPruneProgress) => void,
  options?: AuditPruneOptions
): Promise<number> {
  return pruneAuditTable(
    {
      table: 'venue_dispersions',
      timeColumn: 'timestamp',
      retentionDays,
      minRetentionDays: MIN_RETENTION_DAYS.venue_dispersions,
    },
    network,
    batchSize,
    onProgress,
    options
  )
}

/** Prunes old `quarantined_price_points` rows for one network. */
export async function pruneOldQuarantinedPricePoints(
  retentionDays: number = QUARANTINED_PRICE_POINT_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = AUDIT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: AuditPruneProgress) => void,
  options?: AuditPruneOptions
): Promise<number> {
  return pruneAuditTable(
    {
      table: 'quarantined_price_points',
      timeColumn: 'quarantined_at',
      retentionDays,
      minRetentionDays: MIN_RETENTION_DAYS.quarantined_price_points,
    },
    network,
    batchSize,
    onProgress,
    options
  )
}

/** Prunes old `oracle_publications` rows for one network. */
export async function pruneOldOraclePublications(
  retentionDays: number = ORACLE_PUBLICATION_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = AUDIT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: AuditPruneProgress) => void,
  options?: AuditPruneOptions
): Promise<number> {
  return pruneAuditTable(
    {
      table: 'oracle_publications',
      timeColumn: 'created_at',
      retentionDays,
      minRetentionDays: MIN_RETENTION_DAYS.oracle_publications,
    },
    network,
    batchSize,
    onProgress,
    options
  )
}

export type AuditPruneCounts = Record<AuditTable, Partial<Record<NetworkName, number>>>

/**
 * Prunes all three audit tables for every enabled network and returns the
 * pruned row count per table per network. A failure on one table (or one
 * network) does not stop the others; the failures are rethrown together
 * once everything has been tried.
 */
export async function pruneAllAuditTables(): Promise<AuditPruneCounts> {
  const counts: AuditPruneCounts = {
    venue_dispersions: {},
    quarantined_price_points: {},
    oracle_publications: {},
  }
  const errors: Error[] = []
  for (const config of AUDIT_TABLES) {
    for (const network of getEnabledNetworks()) {
      try {
        counts[config.table][network] = await pruneAuditTable(config, network)
      } catch (err) {
        errors.push(new Error(`${config.table}/${network}: ${(err as Error).message}`))
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }
  return counts
}

export function startAuditRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const counts = await pruneAllAuditTables()
        for (const config of AUDIT_TABLES) {
          for (const [network, pruned] of Object.entries(counts[config.table])) {
            if (pruned > 0) {
              log.info(
                { table: config.table, network, pruned, retentionDays: config.retentionDays },
                'pruned audit rows older than retention window'
              )
            }
          }
        }
      } catch (err) {
        log.error({ err }, 'audit prune failed')
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    log.error({ err }, 'audit retention job failed')
  })

  return worker
}

/** Schedules the audit retention prune to run hourly (and once on startup). */
export async function scheduleAuditRetention(queue: Queue) {
  await scheduleRetentionJob(queue, { jobName: 'prune', jobId: 'audit-retention:prune' })
}
