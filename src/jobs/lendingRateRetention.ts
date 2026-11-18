import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { createLogger } from '../logger'

const log = createLogger('job:rate-retention')

const QUEUE_NAME = `${activeNetwork}:rate-retention`

/** Lending rates older than this many days are pruned by the retention job. */
export const RATE_RETENTION_DAYS = 30
/** Maximum rows removed by one database statement during a retention run. */
export const RATE_PRUNE_BATCH_SIZE = Number(process.env.RATE_PRUNE_BATCH_SIZE ?? 1_000)

export interface RatePruneProgress {
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

export function createRateRetentionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

/**
 * Deletes one network's old lending_rates rows in bounded batches. Locked
 * rows are skipped so concurrent retention workers can make progress without
 * contending for the same batch. Returns the total number of rows pruned.
 */
export async function pruneOldRates(
  retentionDays: number = RATE_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = RATE_PRUNE_BATCH_SIZE,
  onProgress?: (progress: RatePruneProgress) => void
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Rate prune batch size must be a positive integer')
  }

  let totalPruned = 0
  let batchNumber = 0

  while (true) {
    const result = await pgPool.query(
      `WITH batch AS (
         SELECT ctid
         FROM lending_rates
         WHERE network = $1 AND timestamp < NOW() - ($2 || ' days')::interval
         ORDER BY timestamp
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM lending_rates AS rates
       USING batch
       WHERE rates.ctid = batch.ctid`,
      [network, retentionDays, batchSize]
    )
    const pruned = result.rowCount ?? 0
    if (pruned === 0) break

    totalPruned += pruned
    batchNumber += 1
    log.info({ network, batch: batchNumber, batchRows: pruned, totalPruned }, 'pruned lending rate batch')
    onProgress?.({ network, batch: batchNumber, batchRows: pruned, totalPruned })

    // Give other jobs and requests a chance to run between database batches.
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  return totalPruned
}

/**
 * Prunes every network in `getEnabledNetworks()` and returns the pruned row
 * count per network.
 */
export async function pruneAllRateNetworks(
  retentionDays: number = RATE_RETENTION_DAYS
): Promise<Partial<Record<NetworkName, number>>> {
  const counts: Partial<Record<NetworkName, number>> = {}
  const errors: Error[] = []
  for (const network of getEnabledNetworks()) {
    try {
      counts[network] = await pruneOldRates(retentionDays, network)
    } catch (err) {
      errors.push(new Error(`${network}: ${(err as Error).message}`))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }
  return counts
}

export function startRateRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const counts = await pruneAllRateNetworks()
        for (const [network, pruned] of Object.entries(counts)) {
          if (pruned > 0) log.info({ network, pruned, retentionDays: RATE_RETENTION_DAYS }, 'pruned old lending rates')
        }
      } catch (err) {
        log.error({ err }, 'lending rate prune failed')
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    log.error({ err }, 'lending rate retention job failed')
  })

  return worker
}

/** Schedules the rate retention prune to run hourly (and once on startup). */
export async function scheduleRateRetention(queue: Queue) {
  await queue.add(
    'prune',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'rate-retention:prune' }
  )
  await queue.add('prune', {})
}
