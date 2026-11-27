import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { createLogger } from '../logger'
import { runJob, recordJobRowsDeleted } from './jobMetrics'
import type { ScheduledJobDefinition } from './scheduledJob'

const log = createLogger('job:pool-snapshot-retention')

const JOB_NAME = 'pool-snapshot-retention'

/**
 * The prune deletes rows and cannot be undone, and pool_snapshots has never
 * been pruned, so it is opt-in for now: nothing is deleted unless
 * POOL_SNAPSHOT_RETENTION_ENABLED=true.
 */
export const POOL_SNAPSHOT_RETENTION_ENABLED = process.env.POOL_SNAPSHOT_RETENTION_ENABLED === 'true'

/**
 * Pool snapshots older than this many days are pruned by the retention job
 * (except each pool's latest snapshot, which is always preserved).
 * Defaults to 30 days, exceeding the 24h historical lookbacks in /pools and /tvl.
 */
export const POOL_SNAPSHOT_RETENTION_DAYS = Number(
  process.env.POOL_SNAPSHOT_RETENTION_DAYS ?? 30
)

/** Maximum rows removed by one database statement during a pool snapshot retention run. */
export const POOL_SNAPSHOT_PRUNE_BATCH_SIZE = Number(
  process.env.POOL_SNAPSHOT_PRUNE_BATCH_SIZE ?? 1_000
)

/** Pause between batches, in milliseconds, so requests and ingesters get the database in between. */
export const POOL_SNAPSHOT_PRUNE_PAUSE_MS = Number(
  process.env.POOL_SNAPSHOT_PRUNE_PAUSE_MS ?? 100
)

/**
 * Most batches one run deletes per network. A backlog larger than
 * batch size x this cap drains over several hourly runs instead of in one go.
 */
export const POOL_SNAPSHOT_PRUNE_MAX_BATCHES = Number(
  process.env.POOL_SNAPSHOT_PRUNE_MAX_BATCHES ?? 100
)

/** Delay before the first run after boot. */
const FIRST_RUN_DELAY_MS = 60 * 1000
const RUN_EVERY_MS = 60 * 60 * 1000

/**
 * Hours of pool_snapshots history that are guaranteed to be complete, or
 * `null` when retention is off (nothing is pruned, so nothing is cut off).
 * Read from the environment on each call so it always matches what the job
 * is configured to delete.
 */
export function poolSnapshotHistoryLimitHours(env: NodeJS.ProcessEnv = process.env): number | null {
  if (env.POOL_SNAPSHOT_RETENTION_ENABLED !== 'true') return null
  const days = Number(env.POOL_SNAPSHOT_RETENTION_DAYS ?? 30)
  // An invalid value makes the job refuse to run, so no history is lost.
  if (!Number.isSafeInteger(days) || days <= 0) return null
  return days * 24
}

export interface PoolSnapshotPruneProgress {
  network: NetworkName
  batch: number
  batchRows: number
  totalPruned: number
}

export interface PoolSnapshotPruneOptions {
  /** Rows removed per DELETE. */
  batchSize?: number
  /** Pause between batches, in milliseconds. */
  pauseMs?: number
  /** Stop after this many batches; the rest is left for the next run. */
  maxBatches?: number
  onProgress?: (progress: PoolSnapshotPruneProgress) => void
  /** Test seam for the pause between batches. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => {
    if (ms > 0) setTimeout(resolve, ms)
    else setImmediate(resolve)
  })

/**
 * One batch. A row is deleted only when it is older than the cutoff AND a
 * strictly newer row exists for the same (network, pool_id), so each pool's
 * newest snapshot always survives. Both checks are served by the existing
 * (network, pool_id, timestamp DESC) index: the batch walks it in index order
 * (no sort), and the EXISTS probe is a single index lookup per row. The
 * DELETE matches the batch with `ctid = ANY(ARRAY(...))`, which plans as a TID
 * scan; a `USING batch` join can be planned as a hash join over a full scan
 * of the table, once per batch.
 *
 * `$4` is a pool_id cursor. Every eligible row of a pool below it was already
 * deleted by an earlier batch of this run, so each batch resumes where the
 * last one stopped instead of rescanning from the start of the network. The
 * cursor is MAX(pool_id) computed in SQL, so it follows the column's collation.
 *
 * Locked rows are skipped so concurrent instances and ingesters never wait on
 * each other; anything skipped is picked up by the next run.
 */
export const PRUNE_BATCH_SQL = `WITH deleted AS (
         DELETE FROM pool_snapshots
         WHERE ctid = ANY(ARRAY(
           SELECT ps.ctid
           FROM pool_snapshots ps
           WHERE ps.network = $1
             AND ps.pool_id >= $4
             AND ps.timestamp < NOW() - ($2 || ' days')::interval
             AND EXISTS (
               SELECT 1
               FROM pool_snapshots newer
               WHERE newer.network = ps.network
                 AND newer.pool_id = ps.pool_id
                 AND newer.timestamp > ps.timestamp
             )
           ORDER BY ps.pool_id, ps.timestamp DESC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         ))
         RETURNING pool_id
       )
       SELECT COUNT(*)::int AS pruned, MAX(pool_id) AS last_pool_id
       FROM deleted`

/**
 * Deletes one network's old pool_snapshots rows in bounded batches while always
 * retaining each pool's latest snapshot on that network so /tvl, /pools, /depth,
 * and /screener remain populated for inactive pools.
 *
 * Pauses between batches and stops after `maxBatches`, so a large backlog
 * drains gradually across runs. Returns the number of rows pruned by this run.
 */
export async function pruneOldPoolSnapshots(
  retentionDays: number = POOL_SNAPSHOT_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  options: PoolSnapshotPruneOptions = {}
): Promise<number> {
  const {
    batchSize = POOL_SNAPSHOT_PRUNE_BATCH_SIZE,
    pauseMs = POOL_SNAPSHOT_PRUNE_PAUSE_MS,
    maxBatches = POOL_SNAPSHOT_PRUNE_MAX_BATCHES,
    onProgress,
    sleep = defaultSleep,
  } = options

  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    throw new RangeError('Pool snapshot retention days must be a positive integer')
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Pool snapshot prune batch size must be a positive integer')
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches <= 0) {
    throw new RangeError('Pool snapshot prune max batches must be a positive integer')
  }
  if (!Number.isFinite(pauseMs) || pauseMs < 0) {
    throw new RangeError('Pool snapshot prune pause must be a non-negative number of milliseconds')
  }

  let totalPruned = 0
  let batchNumber = 0
  let cursor = ''

  while (true) {
    const result = await pgPool.query<{ pruned: number | string; last_pool_id: string | null }>(
      PRUNE_BATCH_SQL,
      [network, retentionDays, batchSize, cursor]
    )
    const row = result.rows[0]
    const pruned = Number(row?.pruned ?? 0)
    if (pruned === 0) break

    totalPruned += pruned
    batchNumber += 1
    if (row?.last_pool_id) cursor = row.last_pool_id
    recordJobRowsDeleted(JOB_NAME, network, pruned)
    log.info({ network, batch: batchNumber, rows: pruned, total: totalPruned }, 'pruned pool snapshot retention batch')
    onProgress?.({ network, batch: batchNumber, batchRows: pruned, totalPruned })

    // A short batch means nothing eligible is left past the cursor.
    if (pruned < batchSize) break
    if (batchNumber >= maxBatches) {
      log.info(
        { network, batches: batchNumber, total: totalPruned },
        'pool snapshot prune reached its per-run batch cap; remaining rows are pruned on the next run'
      )
      break
    }

    await sleep(pauseMs)
  }

  return totalPruned
}

/**
 * Prunes every network in `getEnabledNetworks()` and returns the pruned row
 * count per network. Collects failures across networks so one network's error
 * does not skip pruning the others.
 */
export async function pruneAllPoolSnapshotNetworks(
  retentionDays: number = POOL_SNAPSHOT_RETENTION_DAYS
): Promise<Partial<Record<NetworkName, number>>> {
  const counts: Partial<Record<NetworkName, number>> = {}
  const errors: Error[] = []
  for (const network of getEnabledNetworks()) {
    try {
      // Recorded per network, here, so the queue worker and the in-process
      // fallback report the same run; wrapping in a caller would double-count.
      counts[network] = await runJob(JOB_NAME, network, () =>
        pruneOldPoolSnapshots(retentionDays, network)
      )
    } catch (err) {
      errors.push(new Error(`${network}: ${(err as Error).message}`))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }
  return counts
}

/** One scheduled run: prune every enabled network and log what was removed. Rejects on failure. */
export async function runPoolSnapshotRetention(): Promise<void> {
  const counts = await pruneAllPoolSnapshotNetworks()
  for (const [network, pruned] of Object.entries(counts)) {
    if (pruned && pruned > 0) {
      log.info(
        { network, pruned, retentionDays: POOL_SNAPSHOT_RETENTION_DAYS },
        'pruned old pool snapshots'
      )
    }
  }
}

/** Hourly schedule for the prune, started with `startScheduledJob()` when retention is enabled. */
export const poolSnapshotRetentionJob: ScheduledJobDefinition = {
  name: JOB_NAME,
  queueName: `${activeNetwork}:${JOB_NAME}`,
  everyMs: RUN_EVERY_MS,
  firstRunDelayMs: FIRST_RUN_DELAY_MS,
  run: runPoolSnapshotRetention,
}
