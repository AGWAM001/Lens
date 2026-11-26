import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork } from '../config'
import {
  ensurePricePointsPartitions,
  dropExpiredPricePointsPartitions,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_PRECREATE_DAYS,
  type PartitionCreationResult,
  type PartitionRetentionResult,
} from '../partitioning/pricePoints'
import { createLogger } from '../logger'
import { runJob } from './jobMetrics'

const log = createLogger('job:price-points-partition')

const QUEUE_NAME = `${activeNetwork}:price-points-partition`

export const PRICE_POINTS_RETENTION_DAYS = process.env.PRICE_POINTS_RETENTION_DAYS
  ? parseInt(process.env.PRICE_POINTS_RETENTION_DAYS, 10)
  : DEFAULT_RETENTION_DAYS

export const PRICE_POINTS_PRECREATE_DAYS = process.env.PRICE_POINTS_PRECREATE_DAYS
  ? parseInt(process.env.PRICE_POINTS_PRECREATE_DAYS, 10)
  : DEFAULT_PRECREATE_DAYS

export const PRICE_POINTS_DROP_EXPIRED = process.env.PRICE_POINTS_DROP_EXPIRED === 'true'

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export function createPricePointsPartitionQueue() {
  // One attempt, pinned: BullMQ's default is already 1, but a failed hourly
  // run must be stored as failed, not retried forever — the next repeat
  // fires on schedule. See src/jobs/jobMetrics.ts.
  return new Queue(QUEUE_NAME, {
    connection: redisConnection(),
    defaultJobOptions: { attempts: 1 },
  })
}

export interface PartitionMaintenanceResult {
  created: string[]
  existing: string[]
  dropped: string[]
  retained: string[]
}

/**
 * Runs partition maintenance for price_points:
 * 1. Automatically creates future daily partitions ahead of need (precreateDays).
 * 2. Opt-in drops expired partitions older than the retention threshold using DROP TABLE
 *    when dropExpired is enabled (defaults to PRICE_POINTS_DROP_EXPIRED, which is false by default).
 */
export async function runPricePointsMaintenance(
  retentionDays: number = PRICE_POINTS_RETENTION_DAYS,
  precreateDays: number = PRICE_POINTS_PRECREATE_DAYS,
  dropExpired: boolean = PRICE_POINTS_DROP_EXPIRED
): Promise<PartitionMaintenanceResult> {
  // Recorded here, so both the queue worker below and the in-process
  // fallback timer in src/index.ts (safeMaintainPartitions) report the
  // same run — wrapping in either caller would double-count it. Partition
  // maintenance is one global run, not one per network (partitions are cut
  // by timestamp across all networks), so it is labelled with the active
  // network its queue is pinned to, matching QUEUE_NAME above.
  return runJob('price-points-partition', activeNetwork, async () => {
    const creationRes: PartitionCreationResult = await ensurePricePointsPartitions(pgPool, {
      precreateDays,
      daysBack: 1, // ensure today and yesterday are guaranteed
    })

    let retentionRes: PartitionRetentionResult = { dropped: [], retained: [] }
    if (dropExpired) {
      retentionRes = await dropExpiredPricePointsPartitions(
        pgPool,
        retentionDays
      )
    }

    return {
      created: creationRes.created,
      existing: creationRes.existing,
      dropped: retentionRes.dropped,
      retained: retentionRes.retained,
    }
  })
}

export function startPricePointsPartitionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // No try/catch: runJob() inside runPricePointsMaintenance() already
      // records the failure, and this handler must reject so BullMQ stores
      // the job as failed (worker.on('failed') below can then fire).
      const result = await runPricePointsMaintenance()
      if (result.created.length > 0) {
        log.info({ count: result.created.length, partitions: result.created }, 'pre-created price_points partitions')
      }
      if (result.dropped.length > 0) {
        log.info(
          { count: result.dropped.length, partitions: result.dropped, retentionDays: PRICE_POINTS_RETENTION_DAYS },
          'dropped expired price_points partitions',
        )
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    log.error({ err }, 'price_points partition job failed')
  })

  return worker
}

/** Schedules partition maintenance to run every hour and once immediately on startup */
export async function schedulePricePointsPartitionMaintenance(queue: Queue) {
  await queue.add(
    'maintain',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'price-points-partition:maintain' }
  )
  await queue.add('maintain', {})
}
