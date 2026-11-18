import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { createLogger } from '../logger'

const log = createLogger('job:snapshot-retention')

const QUEUE_NAME = `${activeNetwork}:snapshot-retention`

/** Snapshots older than this many days are pruned by the retention job. */
export const SNAPSHOT_RETENTION_DAYS = 30
/** Maximum rows removed by one database statement during a retention run. */
export const SNAPSHOT_PRUNE_BATCH_SIZE = Number(process.env.SNAPSHOT_PRUNE_BATCH_SIZE ?? 1_000)

export interface SnapshotPruneProgress {
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

export function createSnapshotRetentionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

/**
 * Deletes one network's old price_snapshots rows in bounded batches. Locked
 * rows are skipped so concurrent retention workers can make progress without
 * contending for the same batch. Returns the total number of rows pruned.
 * `network` defaults to the active network; `batchSize` defaults to the
 * SNAPSHOT_PRUNE_BATCH_SIZE environment setting (or 1,000 rows).
 * Batch totals are logged and optionally sent to `onProgress` as they complete.
 * Exported separately from the worker so it can be unit tested and invoked
 * manually.
 */
export async function pruneOldSnapshots(
  retentionDays: number = SNAPSHOT_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = SNAPSHOT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: SnapshotPruneProgress) => void
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Snapshot prune batch size must be a positive integer')
  }

  let totalPruned = 0
  let batchNumber = 0

  while (true) {
    const result = await pgPool.query(
      `WITH batch AS (
         SELECT ctid
         FROM price_snapshots
         WHERE network = $1 AND ts < NOW() - ($2 || ' days')::interval
         ORDER BY ts
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM price_snapshots AS snapshots
       USING batch
       WHERE snapshots.ctid = batch.ctid`,
      [network, retentionDays, batchSize]
    )
    const pruned = result.rowCount ?? 0
    if (pruned === 0) break

    totalPruned += pruned
    batchNumber += 1
    log.info(
      { network, batch: batchNumber, rows: pruned, total: totalPruned },
      'pruned retention batch'
    )
    onProgress?.({ network, batch: batchNumber, batchRows: pruned, totalPruned })

    // Give other jobs and requests a chance to run between database batches.
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  return totalPruned
}

/**
 * Prunes every network in `getEnabledNetworks()` and returns the pruned row
 * count per network. A failure on one network does not stop the others from
 * being pruned; the failures are rethrown together once all have been tried.
 */
export async function pruneAllNetworks(
  retentionDays: number = SNAPSHOT_RETENTION_DAYS
): Promise<Partial<Record<NetworkName, number>>> {
  const counts: Partial<Record<NetworkName, number>> = {}
  const errors: Error[] = []
  for (const network of getEnabledNetworks()) {
    try {
      counts[network] = await pruneOldSnapshots(retentionDays, network)
    } catch (err) {
      errors.push(new Error(`${network}: ${(err as Error).message}`))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }
  return counts
}

export function startSnapshotRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const counts = await pruneAllNetworks()
        for (const [network, pruned] of Object.entries(counts)) {
          if (pruned > 0) {
            log.info(
              { network, pruned, retentionDays: SNAPSHOT_RETENTION_DAYS },
              'pruned snapshots older than retention window'
            )
          }
        }
      } catch (err) {
        log.error({ err }, 'snapshot prune failed')
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    log.error({ err }, 'snapshot retention job failed')
  })

  return worker
}

/** Schedules the retention prune to run hourly (and once on startup). */
export async function scheduleSnapshotRetention(queue: Queue) {
  await queue.add(
    'prune',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'snapshot-retention:prune' }
  )
  await queue.add('prune', {})
}
