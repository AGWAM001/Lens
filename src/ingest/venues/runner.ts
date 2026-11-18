import { activeNetwork, type NetworkName } from '../../config'
import { getActivePairs } from '../../pairsRegistry'
import { upsertPricePoints } from '../../db'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import { createLogger } from '../../logger'
import { runCycleWithDeadline } from '../cycleDeadline'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import { ingest_cycle_duration_seconds, ingest_errors_total, markIngestSuccess } from '../../metrics'

const log = createLogger('ingester:runner')

// ── Centralized Last Price Cache ──────────────────────────────────────────────
// Keyed by `${venue}:${network}:${pairKey}`
const lastPrice = new Map<string, number>()

export function resetLastPrice(venue?: string): void {
  if (venue) {
    for (const key of lastPrice.keys()) {
      if (key.startsWith(`${venue}:`)) {
        lastPrice.delete(key)
      }
    }
  } else {
    lastPrice.clear()
  }
}

export function getLastPrice(venue: string, network: NetworkName, pairKey: string): number | undefined {
  return lastPrice.get(`${venue}:${network}:${pairKey}`)
}

export function setLastPrice(
  venue: string,
  network: NetworkName,
  pairKey: string,
  price: number
): { previousPrice: number; currentPrice: number } {
  const key = `${venue}:${network}:${pairKey}`
  const previousPrice = lastPrice.get(key) ?? price
  lastPrice.set(key, price)
  return { previousPrice, currentPrice: price }
}

// ── Shared Price Point Writer & Dispatcher ────────────────────────────────────

export async function writeVenuePricePoints(
  venue: string,
  points: VenuePricePoint[],
  pair: WatchedPair,
  network: NetworkName,
  signal?: AbortSignal
): Promise<void> {
  if (points.length === 0) return

  // Cycle-deadline checkpoint (#351): an abandoned cycle skips the write it
  // has not started yet. The checkpoint is before the unit's only statement,
  // never between statements — `upsertPricePoints` is a single
  // `createMany(skipDuplicates)`, so it writes all of these points or none of
  // them, and the events below fire only for points that actually landed.
  if (signal?.aborted) return

  const res = await upsertPricePoints(points as any, network)
  markIngestSuccess(venue, network)
  const acceptedPoints: VenuePricePoint[] = (res && typeof res === 'object' && 'acceptedPoints' in res)
    ? (res as any).acceptedPoints
    : points

  if (acceptedPoints.length === 0) return

  const latest = acceptedPoints[acceptedPoints.length - 1]
  const { previousPrice, currentPrice } = setLastPrice(venue, network, pair.pairKey, latest.price)

  publishPriceUpdate({
    pair: pair.pairKey,
    price: currentPrice,
    ts: latest.observedAt ? latest.observedAt.toISOString() : (latest.timestamp ? latest.timestamp.toISOString() : new Date().toISOString()),
    network,
  })

  dispatchPriceUpdate({
    assetA: pair.assetA.code,
    assetB: pair.assetB.code,
    previousPrice,
    currentPrice,
    network,
  }).catch((err) =>
    createLogger(`ingester:${venue.toLowerCase()}`).error({ err }, 'webhook dispatch error')
  )
}

// ── Sleep Helper ──────────────────────────────────────────────────────────────

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Scheduling, Retry & Error Handling Runner ─────────────────────────────────

/**
 * Options for a venue adapter's polling loop.
 */
export interface VenueAdapterLoopOptions {
  /**
   * Stops the loop cleanly at the next cycle boundary instead of running
   * forever. Production leaves it unset (loops live until the process exits);
   * tests use it to return from the otherwise-infinite loop.
   */
  stopSignal?: AbortSignal
}

/**
 * Runs an individual venue adapter polling loop.
 *
 * Implements:
 * - Network-enable checking
 * - Scheduling loop based on adapter's getPollIntervalMs()
 * - A per-cycle deadline: a cycle over its deadline is aborted, abandoned and
 *   counted (#351) rather than stalling the loop until the upstream recovers
 * - Exponential backoff retry on cycle failure
 * - Fault isolation: errors are caught, logged, and backed off without crashing the host
 */
export async function startVenueAdapter(
  adapter: VenueAdapter,
  network: NetworkName = activeNetwork,
  options: VenueAdapterLoopOptions = {}
): Promise<void> {
  if (!adapter.sourceTimeCapability || !adapter.sourceTimeCapability.status) {
    throw new Error(`Venue adapter "${adapter.name}" must declare sourceTimeCapability`)
  }

  if (!adapter.isEnabled(network)) {
    log.info({ venue: adapter.name, network }, 'venue adapter is disabled — ingester not started')
    return
  }

  log.info({ venue: adapter.name, network }, 'starting venue adapter')

  const ingestLog = createLogger(`ingester:${adapter.name.toLowerCase()}`)
  let consecutiveErrors = 0
  while (!options.stopSignal?.aborted) {
    const cycleStartedAt = Date.now()
    // Pair the cycle is working on, so a failure can say which pair it died on.
    let currentPair: string | undefined
    try {
      // One cycle = one round over every active pair, bounded by the venue's
      // per-cycle deadline (#351). See src/ingest/cycleDeadline.ts: on
      // expiry the cycle is aborted and counted, and the next cycle starts
      // only after this one has unwound, so two cycles against the same venue
      // can never overlap.
      await runCycleWithDeadline({
        venue: adapter.name,
        network,
        cycle: async (signal) => {
          const pairs = getActivePairs()
          for (const pair of pairs) {
            // Abandonment checkpoint (#351): the deadline has fired — do not
            // start another pair. Pairs already in flight keep their own
            // checkpoints inside the adapter (one write unit each), so the
            // cycle stops at a unit boundary and no write is left half-done.
            if (signal.aborted) break
            currentPair = pair.pairKey
            await adapter.ingestPair(pair, network, signal)
          }
        },
      })
      // Observed for an abandoned cycle too: a cycle that hit its deadline is
      // exactly the one whose duration an operator needs in the histogram, and
      // runCycleWithDeadline resolves rather than throwing on expiry.
      ingest_cycle_duration_seconds.observe(
        { venue: adapter.name, network },
        (Date.now() - cycleStartedAt) / 1000,
      )
      consecutiveErrors = 0
    } catch (err) {
      const error = err as Error
      const category = /429|rate.?limit/i.test(error.message) ? 'rate_limit' :
        /timeout|timed out|abort/i.test(error.message) ? 'timeout' : 'other'
      ingest_errors_total.inc({ venue: adapter.name, network, category })
      ingest_cycle_duration_seconds.observe(
        { venue: adapter.name, network },
        (Date.now() - cycleStartedAt) / 1000,
      )
      consecutiveErrors++
      const backoffMs = Math.min(10_000 * Math.pow(2, consecutiveErrors - 1), 60_000)
      ingestLog.error(
        {
          venue: adapter.name,
          network,
          pair: currentPair,
          attempt: consecutiveErrors,
          retryMs: backoffMs,
          durationMs: Date.now() - cycleStartedAt,
          err,
        },
        'venue ingestion cycle failed'
      )
      await sleep(backoffMs)
      continue
    }

    const pollInterval = adapter.getPollIntervalMs(network)
    await sleep(pollInterval)
  }
}

/**
 * Starts all registered venue adapters on a given network.
 * Adding a venue adapter to the registry requires no changes to this runner logic.
 */
export async function startAllVenueAdapters(
  adapters: VenueAdapter[],
  network: NetworkName = activeNetwork
): Promise<void> {
  log.info({ count: adapters.length, network }, 'launching venue adapters')
  for (const adapter of adapters) {
    void startVenueAdapter(adapter, network).catch((err) => {
      log.error({ venue: adapter.name, network, err }, 'unhandled error starting venue adapter')
    })
  }
}
