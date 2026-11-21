import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { createLogger } from '../logger'

const log = createLogger('job:pool-snapshot-retention')

const QUEUE_NAME = `${activeNetwork}:pool-snapshot-retention`

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

export interface PoolSnapshotPruneProgress {
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

export function createPoolSnapshotRetentionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

/**
 * Deletes one network's old pool_snapshots rows in bounded batches while always
 * retaining each pool's latest snapshot on that network so /tvl, /pools, /depth,
 * and /screener remain populated for inactive pools.
 *
 * Locked rows are skipped so concurrent workers can make progress without blocking
 * ingesters. Returns the total number of rows pruned.
 */
export async function pruneOldPoolSnapshots(
  retentionDays: number = POOL_SNAPSHOT_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = POOL_SNAPSHOT_PRUNE_BATCH_SIZE,
  onProgress?: (progress: PoolSnapshotPruneProgress) => void
): Promise<number> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    throw new RangeError('Pool snapshot retention days must be a positive integer')
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Pool snapshot prune batch size must be a positive integer')
  }

  let totalPruned = 0
  let batchNumber = 0

  while (true) {
    const result = await pgPool.query(
      `WITH latest_per_pool AS (
         SELECT DISTINCT ON (pool_id) id
         FROM pool_snapshots
         WHERE network = $1
         ORDER BY pool_id, timestamp DESC, id DESC
       ),
       batch AS (
         SELECT ps.ctid
         FROM pool_snapshots ps
         WHERE ps.network = $1
           AND ps.timestamp < NOW() - ($2 || ' days')::interval
           AND NOT EXISTS (
             SELECT 1
             FROM latest_per_pool l
             WHERE l.id = ps.id
           )
         ORDER BY ps.timestamp
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM pool_snapshots AS snapshots
       USING batch
       WHERE snapshots.ctid = batch.ctid`,
      [network, retentionDays, batchSize]
    )
    const pruned = result.rowCount ?? 0
    if (pruned === 0) break

    totalPruned += pruned
    batchNumber += 1
    log.info({ network, batch: batchNumber, rows: pruned, total: totalPruned }, 'pruned pool snapshot retention batch')
    onProgress?.({ network, batch: batchNumber, batchRows: pruned, totalPruned })

    // Yield between batches so requests and ingesters do not starve.
    await new Promise<void>(resolve => setImmediate(resolve))
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
      counts[network] = await pruneOldPoolSnapshots(retentionDays, network)
    } catch (err) {
      errors.push(new Error(`${network}: ${(err as Error).message}`))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }
  return counts
}

export function startPoolSnapshotRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const counts = await pruneAllPoolSnapshotNetworks()
        for (const [network, pruned] of Object.entries(counts)) {
          if (pruned > 0) {
            log.info(
              { network, pruned, retentionDays: POOL_SNAPSHOT_RETENTION_DAYS },
              'pruned old pool snapshots'
            )
          }
        }
      } catch (err) {
        log.error({ err }, 'pool snapshot retention prune failed')
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    log.error({ err }, 'pool snapshot retention job failed')
  })

  return worker
}

/** Schedules the pool snapshot retention prune to run hourly (and once on startup). */
export async function schedulePoolSnapshotRetention(queue: Queue) {
  await queue.add(
    'prune',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'pool-snapshot-retention:prune' }
  )
  await queue.add('prune', {})
}
