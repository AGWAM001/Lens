import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { createLogger } from '../logger'

const log = createLogger('job:audit-retention')

const QUEUE_NAME = `${activeNetwork}:audit-retention`

/**
 * Retention windows for the three append-only audit tables pruned by this
 * job. Each window is read from the environment so an operator can widen or
 * narrow one table without touching the others.
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
export const VENUE_DISPERSION_RETENTION_DAYS = Number(
  process.env.VENUE_DISPERSION_RETENTION_DAYS ?? 30
)
export const QUARANTINED_PRICE_POINT_RETENTION_DAYS = Number(
  process.env.QUARANTINED_PRICE_POINT_RETENTION_DAYS ?? 30
)
export const ORACLE_PUBLICATION_RETENTION_DAYS = Number(
  process.env.ORACLE_PUBLICATION_RETENTION_DAYS ?? 90
)
/** Maximum rows removed by one database statement during a retention run. */
export const AUDIT_PRUNE_BATCH_SIZE = Number(process.env.AUDIT_PRUNE_BATCH_SIZE ?? 1_000)

export type AuditTable = 'venue_dispersions' | 'quarantined_price_points' | 'oracle_publications'

interface AuditTableConfig {
  table: AuditTable
  /** Time column the retention cutoff is applied to. Each table has its own. */
  timeColumn: string
  retentionDays: number
}

/**
 * The tables this job prunes. Table and column names are fixed here and
 * never come from input, so interpolating them into the DELETE is safe;
 * every value (network, days, batch size) stays a bound parameter.
 */
export const AUDIT_TABLES: readonly AuditTableConfig[] = [
  { table: 'venue_dispersions', timeColumn: 'timestamp', retentionDays: VENUE_DISPERSION_RETENTION_DAYS },
  { table: 'quarantined_price_points', timeColumn: 'quarantined_at', retentionDays: QUARANTINED_PRICE_POINT_RETENTION_DAYS },
  { table: 'oracle_publications', timeColumn: 'created_at', retentionDays: ORACLE_PUBLICATION_RETENTION_DAYS },
]

export interface AuditPruneProgress {
  table: AuditTable
  network: NetworkName
  batch: number
  batchRows: number
  totalPruned: number
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
 * Deletes one network's old rows from one audit table in bounded batches.
 * Locked rows are skipped so concurrent retention workers can make progress
 * without contending for the same batch. Returns the total rows pruned.
 * Exported separately from the worker so it can be unit tested and invoked
 * manually.
 */
export async function pruneAuditTable(
  config: AuditTableConfig,
  network: NetworkName = activeNetwork,
  batchSize: number = AUDIT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: AuditPruneProgress) => void
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Audit prune batch size must be a positive integer')
  }
  if (!Number.isFinite(config.retentionDays) || config.retentionDays < 0) {
    throw new RangeError(`Retention days for ${config.table} must be a non-negative number`)
  }

  let totalPruned = 0
  let batchNumber = 0

  while (true) {
    const result = await pgPool.query(
      `WITH batch AS (
         SELECT ctid
         FROM ${config.table}
         WHERE network = $1 AND ${config.timeColumn} < NOW() - ($2 || ' days')::interval
         ORDER BY ${config.timeColumn}
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM ${config.table} AS audit_rows
       USING batch
       WHERE audit_rows.ctid = batch.ctid`,
      [network, config.retentionDays, batchSize]
    )
    const pruned = result.rowCount ?? 0
    if (pruned === 0) break

    totalPruned += pruned
    batchNumber += 1
    log.info(
      { table: config.table, network, batch: batchNumber, rows: pruned, total: totalPruned },
      'pruned audit retention batch'
    )
    onProgress?.({ table: config.table, network, batch: batchNumber, batchRows: pruned, totalPruned })

    // Give other jobs and requests a chance to run between database batches.
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  return totalPruned
}

/** Prunes old `venue_dispersions` rows for one network. */
export async function pruneOldVenueDispersions(
  retentionDays: number = VENUE_DISPERSION_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = AUDIT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: AuditPruneProgress) => void
): Promise<number> {
  return pruneAuditTable({ table: 'venue_dispersions', timeColumn: 'timestamp', retentionDays }, network, batchSize, onProgress)
}

/** Prunes old `quarantined_price_points` rows for one network. */
export async function pruneOldQuarantinedPricePoints(
  retentionDays: number = QUARANTINED_PRICE_POINT_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = AUDIT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: AuditPruneProgress) => void
): Promise<number> {
  return pruneAuditTable({ table: 'quarantined_price_points', timeColumn: 'quarantined_at', retentionDays }, network, batchSize, onProgress)
}

/** Prunes old `oracle_publications` rows for one network. */
export async function pruneOldOraclePublications(
  retentionDays: number = ORACLE_PUBLICATION_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = AUDIT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: AuditPruneProgress) => void
): Promise<number> {
  return pruneAuditTable({ table: 'oracle_publications', timeColumn: 'created_at', retentionDays }, network, batchSize, onProgress)
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
  await queue.add(
    'prune',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'audit-retention:prune' }
  )
  await queue.add('prune', {})
}
