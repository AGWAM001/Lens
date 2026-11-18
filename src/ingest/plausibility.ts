import { type NetworkName } from '../config'
import { median } from '../pricing/twap'
import { prisma as defaultPrisma, pgPool } from '../db'
import { createLogger } from '../logger'

const log = createLogger('ingest:plausibility')

export const DEFAULT_PLAUSIBILITY_THRESHOLD = 0.20 // 20% max deviation
export const DEFAULT_PLAUSIBILITY_WINDOW_MINUTES = 60 // 60-minute rolling window
export const DEFAULT_PLAUSIBILITY_MIN_SAMPLES = 1 // at least 1 sample needed

export function getPlausibilityThreshold(): number {
  if (process.env.INGEST_PLAUSIBILITY_THRESHOLD) {
    const parsed = parseFloat(process.env.INGEST_PLAUSIBILITY_THRESHOLD)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_PLAUSIBILITY_THRESHOLD
}

export function getPlausibilityWindowMinutes(): number {
  if (process.env.INGEST_PLAUSIBILITY_WINDOW_MINUTES) {
    const parsed = parseInt(process.env.INGEST_PLAUSIBILITY_WINDOW_MINUTES, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_PLAUSIBILITY_WINDOW_MINUTES
}

export function getPlausibilityMinSamples(): number {
  if (process.env.INGEST_PLAUSIBILITY_MIN_SAMPLES) {
    const parsed = parseInt(process.env.INGEST_PLAUSIBILITY_MIN_SAMPLES, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_PLAUSIBILITY_MIN_SAMPLES
}

export interface PlausibilityCheckResult {
  isPlausible: boolean
  referenceMedian: number | null
  deviation: number | null
  threshold: number
  reason?: string
}

export function checkPricePointPlausibility(
  price: number,
  referenceMedian: number | null,
  threshold: number = getPlausibilityThreshold()
): PlausibilityCheckResult {
  if (referenceMedian === null || !Number.isFinite(referenceMedian) || referenceMedian <= 0) {
    return {
      isPlausible: true,
      referenceMedian: null,
      deviation: null,
      threshold,
    }
  }

  const deviation = Math.abs(price - referenceMedian) / referenceMedian
  const isPlausible = deviation <= threshold

  return {
    isPlausible,
    referenceMedian,
    deviation,
    threshold,
    reason: isPlausible
      ? undefined
      : `PRICE_DEVIATION_EXCEEDS_BOUND: deviation ${(deviation * 100).toFixed(2)}% exceeds bound ${(threshold * 100).toFixed(2)}% (reference median: ${referenceMedian})`,
  }
}

/**
 * Computes the recent median price for a (network, pairKey) over a rolling window.
 * Enforces the network predicate for index alignment and cross-chain isolation.
 */
export async function getRecentMedianPrice(
  network: NetworkName,
  pairKey: string,
  options?: {
    windowMinutes?: number
    minSamples?: number
    prismaClient?: any
  }
): Promise<number | null> {
  const windowMinutes = options?.windowMinutes ?? getPlausibilityWindowMinutes()
  const minSamples = options?.minSamples ?? getPlausibilityMinSamples()
  const prismaInstance = options?.prismaClient ?? (globalThis as any).prisma ?? defaultPrisma

  const cutoff = new Date(Date.now() - windowMinutes * 60_000)
  let prices: number[] = []

  // 1. Try querying via Prisma if available
  if (prismaInstance?.pricePoint?.findMany) {
    try {
      const rows = await prismaInstance.pricePoint.findMany({
        where: {
          network,
          pairKey,
          timestamp: { gte: cutoff },
        },
        select: { price: true },
        orderBy: { timestamp: 'desc' },
        take: 100,
      })

      if (Array.isArray(rows)) {
        prices = rows
          .map((r: any) => parseFloat(r.price?.toString() ?? '0'))
          .filter((p: number) => Number.isFinite(p) && p > 0)
      }

      // If no points within the strict time window, check recent points without time filter
      if (prices.length === 0) {
        const fallbackRows = await prismaInstance.pricePoint.findMany({
          where: {
            network,
            pairKey,
          },
          select: { price: true },
          orderBy: { timestamp: 'desc' },
          take: 50,
        })
        if (Array.isArray(fallbackRows)) {
          prices = fallbackRows
            .map((r: any) => parseFloat(r.price?.toString() ?? '0'))
            .filter((p: number) => Number.isFinite(p) && p > 0)
        }
      }
    } catch (err) {
      log.debug({ err, pairKey, network }, 'Prisma query for recent median encountered error; falling back to pgPool')
    }
  }

  // 2. Fallback to pgPool query if Prisma returned no prices and pgPool is available
  if (prices.length === 0 && pgPool?.query) {
    try {
      const result = await pgPool.query(
        `SELECT price::numeric as price
         FROM price_points
         WHERE network = $1
           AND pair_key = $2
           AND timestamp >= $3
         ORDER BY timestamp DESC
         LIMIT 100`,
        [network, pairKey, cutoff]
      )

      if (result?.rows && result.rows.length > 0) {
        prices = result.rows
          .map((r: any) => parseFloat(r.price))
          .filter((p: number) => Number.isFinite(p) && p > 0)
      } else {
        // Fallback to recent points without cutoff
        const fallbackRes = await pgPool.query(
          `SELECT price::numeric as price
           FROM price_points
           WHERE network = $1
             AND pair_key = $2
           ORDER BY timestamp DESC
           LIMIT 50`,
          [network, pairKey]
        )
        if (fallbackRes?.rows && fallbackRes.rows.length > 0) {
          prices = fallbackRes.rows
            .map((r: any) => parseFloat(r.price))
            .filter((p: number) => Number.isFinite(p) && p > 0)
        }
      }
    } catch {
      // Ignore fallback failures in test environments
    }
  }

  if (prices.length < minSamples) {
    return null
  }

  return median(prices)
}

export interface IngestPricePointInput {
  assetA: string
  assetB: string
  pairKey: string
  source: string
  poolId?: string | null
  price: number
  baseVolume: number
  counterVolume: number
  ledger: number
  timestamp: Date
  eventId?: string | null
}

export interface QuarantinedPointPayload extends IngestPricePointInput {
  referenceMedian: number
  rejectionReason: string
  rejectionBound: number
  quarantinedAt: Date
}

export interface PartitionedPointsResult {
  accepted: IngestPricePointInput[]
  quarantined: QuarantinedPointPayload[]
}

/**
 * Partitions incoming points into accepted and quarantined subsets based on rolling median plausibility.
 */
export async function partitionPricePointsByPlausibility(
  points: IngestPricePointInput[],
  network: NetworkName,
  options?: {
    prismaClient?: any
    threshold?: number
  }
): Promise<PartitionedPointsResult> {
  const threshold = options?.threshold ?? getPlausibilityThreshold()
  const accepted: IngestPricePointInput[] = []
  const quarantined: QuarantinedPointPayload[] = []

  // Group by pairKey to maintain sequential rolling median
  const byPair = new Map<string, IngestPricePointInput[]>()
  for (const pt of points) {
    const list = byPair.get(pt.pairKey) ?? []
    list.push(pt)
    byPair.set(pt.pairKey, list)
  }

  for (const [pairKey, pairPoints] of byPair.entries()) {
    // Reference median comes only from persisted history (getRecentMedianPrice).
    // A cold start with no history leaves this null, and a null reference means
    // every point is plausible: there is no basis to judge the first batch
    // against itself, and self-referencing it would quarantine legitimately
    // distinct observations (see #237). Once history exists, later batches are
    // checked against it.
    const currentMedian = await getRecentMedianPrice(network, pairKey, {
      prismaClient: options?.prismaClient,
    })

    for (const point of pairPoints) {
      const check = checkPricePointPlausibility(point.price, currentMedian, threshold)

      if (check.isPlausible) {
        accepted.push(point)
      } else {
        log.warn(
          {
            network,
            pairKey,
            price: point.price,
            referenceMedian: check.referenceMedian,
            deviation: check.deviation,
            source: point.source,
          },
          'price point failed plausibility check — diverting to quarantine'
        )
        quarantined.push({
          ...point,
          referenceMedian: check.referenceMedian!,
          rejectionReason: check.reason ?? 'PRICE_DEVIATION_EXCEEDS_BOUND',
          rejectionBound: check.threshold,
          quarantinedAt: new Date(),
        })
      }
    }
  }

  return { accepted, quarantined }
}

