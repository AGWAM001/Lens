import { Queue, Worker } from 'bullmq'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getEnabledNetworks } from '../network/enabledNetworks'
import {
  price_points_pruned_total,
  price_points_rolled_up_total,
} from '../metrics'
import { createLogger } from '../logger'

const log = createLogger('job:price-points-retention')

const QUEUE_NAME = `${activeNetwork}:price-points-retention`

/**
 * Retention window for raw price_points.
 *
 * Defaults to 30 days.
 *
 * Reasoning:
 * 1. Downstream volume endpoints (e.g. GET /volumes/:asset?window=30d) inspect
 *    raw price_points over windows up to 30 days. Pruning points younger than
 *    30 days would break 30-day volume calculations.
 * 2. 30 days aligns with SNAPSHOT_RETENTION_DAYS (30 days) across the service.
 * 3. Supabase storage limits: ingesters write tick-by-tick across all pairs,
 *    venues, and networks. Without retention, price_points grows without bound,
 *    risking table bloat and writes failing across Lens and sibling services.
 *    Points older than 30 days are rolled into 1-hour price_aggregates before
 *    deletion, preserving historical OHLCV, VWAP, venue volume breakdown, and
 *    trade count permanently while reclaiming >99% of storage.
 */
export const PRICE_POINTS_RETENTION_DAYS = Number(process.env.PRICE_POINTS_RETENTION_DAYS ?? 30)

/** Maximum rows removed by one database statement during a retention run. */
export const PRICE_POINTS_PRUNE_BATCH_SIZE = Number(process.env.PRICE_POINTS_PRUNE_BATCH_SIZE ?? 1_000)

/** Default pause in milliseconds between deletion batches to yield database locks. */
export const DEFAULT_PRUNE_PAUSE_MS = 50

export interface PricePointsPruneProgress {
  network: NetworkName
  batch: number
  batchRows: number
  totalPruned: number
}

export interface PricePointsPruneResult {
  network: NetworkName
  rolledUp: number
  pruned: number
  batches: number
}

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export function createPricePointsRetentionQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() })
}

/**
 * Rolls up raw price_points older than `retentionDays` into 1-hour buckets in
 * `price_aggregates` before they are pruned.
 *
 * Every query leads with the `network` predicate to leverage indexes and ensure
 * testnet and mainnet points are never blended into the same aggregate bucket.
 * Uses exact numeric arithmetic so decimal precision is never degraded.
 *
 * Returns the count of raw points rolled up and aggregate buckets created/updated.
 */
export async function rollupOldPricePoints(
  retentionDays: number = PRICE_POINTS_RETENTION_DAYS,
  network: NetworkName = activeNetwork
): Promise<{ rawCount: number; aggregateCount: number }> {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError('Retention days must be a non-negative number')
  }

  const result = await pgPool.query(
    `WITH points_to_rollup AS (
       SELECT network, pair_key, date_trunc('hour', timestamp) AS bucket,
              price, base_volume, source, timestamp
       FROM price_points
       WHERE network = $1 AND timestamp < NOW() - ($2 || ' days')::interval
     ),
     inserted AS (
       INSERT INTO price_aggregates (
         network, pair_key, window, bucket,
         vwap, sdex_vwap, amm_vwap,
         volume, sdex_volume, amm_volume,
         trade_count, open_price, close_price, high_price, low_price
       )
       SELECT
         network,
         pair_key,
         '1h' AS window,
         bucket,
         COALESCE(
           SUM(price * base_volume) / NULLIF(SUM(base_volume), 0),
           AVG(price)
         ) AS vwap,
         SUM(CASE WHEN source = 'SDEX' THEN price * base_volume ELSE 0 END) / NULLIF(SUM(CASE WHEN source = 'SDEX' THEN base_volume ELSE 0 END), 0) AS sdex_vwap,
         SUM(CASE WHEN source != 'SDEX' THEN price * base_volume ELSE 0 END) / NULLIF(SUM(CASE WHEN source != 'SDEX' THEN base_volume ELSE 0 END), 0) AS amm_vwap,
         COALESCE(SUM(base_volume), 0) AS volume,
         COALESCE(SUM(CASE WHEN source = 'SDEX' THEN base_volume ELSE 0 END), 0) AS sdex_volume,
         COALESCE(SUM(CASE WHEN source != 'SDEX' THEN base_volume ELSE 0 END), 0) AS amm_volume,
         COUNT(*)::int AS trade_count,
         (ARRAY_AGG(price ORDER BY timestamp ASC))[1] AS open_price,
         (ARRAY_AGG(price ORDER BY timestamp DESC))[1] AS close_price,
         MAX(price) AS high_price,
         MIN(price) AS low_price
       FROM points_to_rollup
       GROUP BY network, pair_key, bucket
       ON CONFLICT (network, pair_key, window, bucket) DO UPDATE SET
         vwap = EXCLUDED.vwap,
         sdex_vwap = COALESCE(EXCLUDED.sdex_vwap, price_aggregates.sdex_vwap),
         amm_vwap = COALESCE(EXCLUDED.amm_vwap, price_aggregates.amm_vwap),
         volume = EXCLUDED.volume,
         sdex_volume = COALESCE(EXCLUDED.sdex_volume, price_aggregates.sdex_volume),
         amm_volume = COALESCE(EXCLUDED.amm_volume, price_aggregates.amm_volume),
         trade_count = EXCLUDED.trade_count,
         open_price = COALESCE(EXCLUDED.open_price, price_aggregates.open_price),
         close_price = COALESCE(EXCLUDED.close_price, price_aggregates.close_price),
         high_price = GREATEST(EXCLUDED.high_price, price_aggregates.high_price),
         low_price = LEAST(EXCLUDED.low_price, price_aggregates.low_price)
       RETURNING 1
     )
     SELECT
       (SELECT COUNT(*) FROM points_to_rollup)::int AS raw_count,
       (SELECT COUNT(*) FROM inserted)::int AS aggregate_count`,
    [network, retentionDays]
  )

  const row = result.rows[0]
  const rawCount = Number(row?.raw_count ?? 0)
  const aggregateCount = Number(row?.aggregate_count ?? 0)

  if (rawCount > 0) {
    price_points_rolled_up_total.inc({ network }, rawCount)
    log.info(
      { network, rawCount, aggregateCount },
      'rolled up raw price points into aggregate buckets'
    )
  }

  return { rawCount, aggregateCount }
}

/**
 * Prunes raw price_points older than `retentionDays` in bounded batches.
 *
 * CRITICAL: Points are rolled into price_aggregates BEFORE any deletion occurs.
 * If the rollup fails, deletion is aborted immediately to protect history.
 *
 * Deletion is executed in bounded batches using `FOR UPDATE SKIP LOCKED` and
 * yields between batches to prevent holding prolonged locks on the table.
 *
 * Deleted rows and rolled up rows are exported to Prometheus metrics.
 */
export async function pruneOldPricePoints(
  retentionDays: number = PRICE_POINTS_RETENTION_DAYS,
  network: NetworkName = activeNetwork,
  batchSize: number = PRICE_POINTS_PRUNE_BATCH_SIZE,
  pauseMs: number = DEFAULT_PRUNE_PAUSE_MS,
  onProgress?: (progress: PricePointsPruneProgress) => void,
  yieldFn?: () => Promise<void>
): Promise<PricePointsPruneResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Price points prune batch size must be a positive integer')
  }
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError('Retention days must be a non-negative number')
  }

  // 1. Roll up raw points before pruning — history is the product!
  const { rawCount } = await rollupOldPricePoints(retentionDays, network)

  // 2. Delete raw points in bounded batches, yielding between batches.
  let totalPruned = 0
  let batchNumber = 0

  while (true) {
    const result = await pgPool.query(
      `WITH batch AS (
         SELECT ctid
         FROM price_points
         WHERE network = $1 AND timestamp < NOW() - ($2 || ' days')::interval
         ORDER BY timestamp
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM price_points AS points
       USING batch
       WHERE points.ctid = batch.ctid`,
      [network, retentionDays, batchSize]
    )

    const pruned = result.rowCount ?? 0
    if (pruned === 0) break

    totalPruned += pruned
    batchNumber += 1
    price_points_pruned_total.inc({ network }, pruned)

    log.info(
      { network, batch: batchNumber, batchRows: pruned, totalPruned },
      'pruned a batch of raw price points'
    )
    onProgress?.({ network, batch: batchNumber, batchRows: pruned, totalPruned })

    // Yield / pause between database batches to let concurrent queries proceed.
    if (yieldFn) {
      await yieldFn()
    } else if (pauseMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, pauseMs))
    } else {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  return {
    network,
    rolledUp: rawCount,
    pruned: totalPruned,
    batches: batchNumber,
  }
}

/**
 * Prunes every network in `getEnabledNetworks()` and returns the results per network.
 * A failure on one network does not abort pruning on the others; failures are
 * collected and thrown together as an AggregateError once all networks have been tried.
 */
export async function pruneAllNetworks(
  retentionDays: number = PRICE_POINTS_RETENTION_DAYS
): Promise<Partial<Record<NetworkName, PricePointsPruneResult>>> {
  const results: Partial<Record<NetworkName, PricePointsPruneResult>> = {}
  const errors: Error[] = []

  for (const network of getEnabledNetworks()) {
    try {
      results[network] = await pruneOldPricePoints(retentionDays, network)
    } catch (err) {
      errors.push(new Error(`${network}: ${(err as Error).message}`))
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(e => e.message).join('; '))
  }

  return results
}

export function startPricePointsRetentionWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      try {
        const results = await pruneAllNetworks()
        for (const [network, res] of Object.entries(results)) {
          if (res && (res.pruned > 0 || res.rolledUp > 0)) {
            log.info(
              { network, rolledUp: res.rolledUp, pruned: res.pruned, retentionDays: PRICE_POINTS_RETENTION_DAYS },
              'retention run complete'
            )
          }
        }
      } catch (err) {
        log.error({ err }, 'prune failed')
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (_job, err) => {
    log.error({ err }, 'retention job failed')
  })

  return worker
}

/** Schedules the retention prune to run hourly (and once on startup). */
export async function schedulePricePointsRetention(queue: Queue) {
  await queue.add(
    'prune',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'price-points-retention:prune' }
  )
  await queue.add('prune', {})
}
