import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { createLogger } from '../logger'

const log = createLogger('job:oracle-retention')

const QUEUE_NAME = `${activeNetwork}:oracle-retention`

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

/** Oracle comparisons older than this many days are pruned by retention. */
export const ORACLE_COMPARISON_RETENTION_DAYS = 30
/** Maximum rows removed by one database statement during a retention run. */
export const ORACLE_COMPARISON_PRUNE_BATCH_SIZE = Number(
  process.env.ORACLE_COMPARISON_PRUNE_BATCH_SIZE ?? 1_000
)

export interface OraclePruneProgress {
  network: NetworkName
  batch: number
  batchRows: number
  totalPruned: number
}

/**
 * Deletes one network's old oracle_comparisons rows in bounded batches.
 * Locked rows are skipped to avoid contending with concurrent writes.
 * Returns the total number of rows pruned.
 */
export async function pruneOldOracleComparisons(
  retentionDays: number = ORACLE_COMPARISON_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = ORACLE_COMPARISON_PRUNE_BATCH_SIZE,
  onProgress?: (progress: OraclePruneProgress) => void
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Oracle comparison prune batch size must be a positive integer')
  }

  let totalPruned = 0
  let batchNumber = 0

  while (true) {
    const result = await pgPool.query(
      `WITH batch AS (
         SELECT ctid
         FROM oracle_comparisons
         WHERE network = $1 AND timestamp < NOW() - ($2 || ' days')::interval
         ORDER BY timestamp
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM oracle_comparisons AS oc
       USING batch
       WHERE oc.ctid = batch.ctid`,
      [network, retentionDays, batchSize]
    )
    const pruned = result.rowCount ?? 0
    if (pruned === 0) break

    totalPruned += pruned
    batchNumber += 1
    log.info(
      { network, batch: batchNumber, rows: pruned, total: totalPruned },
      'pruned oracle comparisons retention batch'
    )
    onProgress?.({ network, batch: batchNumber, batchRows: pruned, totalPruned })

    await new Promise<void>(resolve => setImmediate(resolve))
  }

  return totalPruned
}

/**
 * Prunes oracle comparisons across all enabled networks.
 */
export async function pruneAllNetworksOracleComparisons(
  retentionDays: number = ORACLE_COMPARISON_RETENTION_DAYS
): Promise<Partial<Record<NetworkName, number>>> {
  const counts: Partial<Record<NetworkName, number>> = {}
  const errors: Error[] = []
  for (const network of getEnabledNetworks()) {
    try {
      counts[network] = await pruneOldOracleComparisons(retentionDays, network)
    } catch (err) {
      errors.push(new Error(`${network}: ${(err as Error).message}`))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }
  return counts
}

export function createOracleRetentionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

export function startOracleRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const counts = await pruneAllNetworksOracleComparisons()
        for (const [network, pruned] of Object.entries(counts)) {
          if (pruned && pruned > 0) {
            log.info(
              { network, pruned, retentionDays: ORACLE_COMPARISON_RETENTION_DAYS },
              'pruned oracle comparisons older than retention window'
            )
          }
        }
      } catch (err) {
        log.error({ err }, 'oracle comparisons prune failed')
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    log.error({ err }, 'oracle comparisons retention job failed')
  })

  return worker
}

export async function scheduleOracleRetention(queue: Queue) {
  await queue.add(
    'prune',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'oracle-retention:prune' }
  )
  await queue.add('prune', {})
}
