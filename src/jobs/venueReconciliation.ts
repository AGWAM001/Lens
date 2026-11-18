import { Queue, Worker } from 'bullmq'
import { config, getPairReconciliationThreshold, type NetworkName } from '../config'
import { getActivePairs, parseAssetStr } from '../pairsRegistry'
import {
  computeDispersion,
  fetchLatestVenueQuotes,
  recordDispersionRun,
  type DispersionResult,
  type VenueQuote,
} from '../reconciliation/dispersion'
import {
  buildDispersionAlertPayload,
  dispatchDispersionAlert,
  isAlertSuppressed,
  recordAlertFired,
  clearAlertState,
  type VenueDispersionAlertPayload,
} from '../alerts/dispersion'
import { createLogger } from '../logger'

const log = createLogger('reconciliation')

export interface ReconcileOptions {
  freshnessWindowSeconds?: number
  thresholdPct?: number
  cooldownSeconds?: number
  referenceTime?: Date
  quotesOverride?: VenueQuote[]
  onAlert?: (payload: VenueDispersionAlertPayload) => void
}

function queueName(network: NetworkName): string {
  return `${network}:venue-reconciliation`
}

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

/**
 * Reconciles venue quotes for a single watched pair on a given network.
 */
export async function reconcilePair(
  pairKey: string,
  network: NetworkName,
  options: ReconcileOptions = {}
): Promise<{
  result: DispersionResult
  alerted: boolean
  alertPayload?: VenueDispersionAlertPayload
}> {
  const freshnessWindow =
    options.freshnessWindowSeconds ?? config.reconciliation.freshnessWindowSeconds
  const threshold = options.thresholdPct ?? getPairReconciliationThreshold(pairKey)
  const cooldown = options.cooldownSeconds ?? config.reconciliation.cooldownSeconds
  const referenceTime = options.referenceTime ?? new Date()

  const quotes = options.quotesOverride ?? (await fetchLatestVenueQuotes(pairKey, network))

  const result = computeDispersion(pairKey, quotes, freshnessWindow, referenceTime)

  // Persist the reconciliation run row
  await recordDispersionRun(result, network)

  let alerted = false
  let alertPayload: VenueDispersionAlertPayload | undefined

  const alertKey = `${network}:${pairKey}`

  // Check alert condition
  if (result.status === 'ok' && result.dispersionPct !== null && result.outlierVenue !== null) {
    if (result.dispersionPct >= threshold) {
      const suppressed = isAlertSuppressed(alertKey, cooldown, referenceTime.getTime())
      if (!suppressed) {
        // Extract asset codes for the alert payload
        const [rawA, rawB] = pairKey.split('/')
        const parsedA = parseAssetStr(rawA)
        const parsedB = parseAssetStr(rawB)
        const assetA = parsedA?.code ?? rawA ?? ''
        const assetB = parsedB?.code ?? rawB ?? ''

        alertPayload = buildDispersionAlertPayload({
          pairKey,
          assetA,
          assetB,
          network,
          dispersionPct: result.dispersionPct,
          thresholdPct: threshold,
          outlyingVenue: result.outlierVenue,
          outlierDeviationPct: result.outlierDeviationPct ?? result.dispersionPct,
          median: result.median ?? 0,
          venueCount: result.venueCount,
          venues: result.venues,
          staleVenues: result.staleVenues,
          isAmbiguous: result.isAmbiguous,
          timestamp: referenceTime.toISOString(),
        })

        recordAlertFired(alertKey, referenceTime.getTime())
        await dispatchDispersionAlert(alertPayload)
        options.onAlert?.(alertPayload)
        alerted = true

        log.warn(
          {
            network,
            pairKey,
            dispersionPct: result.dispersionPct,
            thresholdPct: threshold,
            outlierVenue: result.outlierVenue,
            outlierDeviationPct: result.outlierDeviationPct,
          },
          'cross-venue dispersion exceeds threshold'
        )
      } else {
        log.info(
          { network, pairKey, dispersionPct: result.dispersionPct, thresholdPct: threshold },
          'cross-venue dispersion exceeds threshold; alert suppressed (cooldown active)'
        )
      }
    } else {
      // Condition cleared: reset suppression state so future crosses alert immediately
      clearAlertState(alertKey)
    }
  }

  return { result, alerted, alertPayload }
}

/**
 * Reconciles all active watched pairs for a given network.
 */
export async function reconcileAllPairs(
  network: NetworkName,
  options: ReconcileOptions = {}
): Promise<Array<{ pairKey: string; result: DispersionResult; alerted: boolean }>> {
  const pairs = getActivePairs()
  const results: Array<{ pairKey: string; result: DispersionResult; alerted: boolean }> = []

  for (const pair of pairs) {
    try {
      const outcome = await reconcilePair(pair.pairKey, network, options)
      results.push({ pairKey: pair.pairKey, ...outcome })
    } catch (err) {
      log.error({ err, network, pairKey: pair.pairKey }, 'venue reconciliation failed for pair')
    }
  }

  return results
}

export function createVenueReconciliationQueue(network: NetworkName) {
  return new Queue(queueName(network), { connection: redisConnection() })
}

export function startVenueReconciliationWorker(network: NetworkName) {
  const worker = new Worker(
    queueName(network),
    async () => {
      try {
        await reconcileAllPairs(network)
      } catch (err) {
        log.error({ err, network }, 'venue reconciliation worker cycle failed')
      }
    },
    { connection: redisConnection(), concurrency: 1 }
  )

  worker.on('failed', (job, err) => {
    log.error({ err, network, jobId: job?.id }, 'venue reconciliation job failed')
  })

  return worker
}

export async function scheduleVenueReconciliation(queue: Queue, network: NetworkName) {
  const intervalMs = config.reconciliation.intervalMs
  await queue.add(
    'reconcile',
    { network },
    { repeat: { every: intervalMs }, jobId: `reconciliation:${network}` }
  )
  // Also run immediately on startup
  await queue.add('reconcile', { network })
}

/**
 * Starts an in-process reconciliation timer fallback when Redis is unavailable.
 */
export function startInProcessVenueReconciliation(network: NetworkName) {
  const intervalMs = config.reconciliation.intervalMs
  return setInterval(() => {
    void reconcileAllPairs(network)
  }, intervalMs).unref()
}
