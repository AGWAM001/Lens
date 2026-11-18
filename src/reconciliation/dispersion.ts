import { pgPool, prisma } from '../db'
import type { NetworkName } from '../config'

export interface VenueQuote {
  venue: string
  price: number
  timestamp: Date
}

export interface VenueEvaluation {
  venue: string
  price: number
  deviationPct: number
  ageSeconds: number
}

export type DispersionStatus = 'ok' | 'insufficient_venues'

export interface DispersionResult {
  pairKey: string
  status: DispersionStatus
  venueCount: number
  median: number | null
  dispersionPct: number | null
  spreadBps: number | null
  minPrice: number | null
  maxPrice: number | null
  outlierVenue: string | null
  outlierDeviationPct: number | null
  isAmbiguous: boolean
  freshVenues: string[]
  staleVenues: string[]
  venues: VenueEvaluation[]
  timestamp: Date
}

/**
 * Calculates the median of an array of numbers.
 * The input array must be non-empty.
 */
export function calculateMedian(values: number[]): number {
  if (values.length === 0) {
    throw new RangeError('Cannot calculate median of an empty array')
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[mid]
  }
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Computes cross-venue price dispersion for a watched pair.
 *
 * ## Dispersion Metric
 * We use Maximum Absolute Percentage Deviation (MAPD) from the median:
 *   deviationPct_i = (|price_i - median| / median) * 100
 *   dispersionPct  = max(deviationPct_i)
 *
 * ## Rationale
 * 1. Robustness: The median is outlier-resistant, unlike the mean which gets
 *    distorted by the very rogue quotes we want to detect.
 * 2. Scale-invariance: Percentage deviation normalizes dispersion across
 *    differently priced assets (e.g. XLM at $0.10 vs BTC at $60,000).
 * 3. Exact Outlier Attribution: Identifying the venue with the maximum
 *    absolute deviation pinpoints which venue has strayed furthest from
 *    consensus.
 *
 * ## Stale Venue Handling
 * Quotes older than `freshnessWindowSeconds` are excluded from the median and
 * dispersion calculations so dead feeds don't distort live prices. However,
 * their names are recorded in `staleVenues` so that their absence is visible
 * and actionable.
 *
 * ## Edge Cases
 * - Single-venue / zero-venue: Returns `status = 'insufficient_venues'` with null
 *   median/dispersion and no outlier.
 * - Two-venue pair: Both venues are equidistant from the median. Deterministic
 *   tie-breaking picks the venue with the lower alphabetical name, and marks
 *   `isAmbiguous = true`.
 */
export function computeDispersion(
  pairKey: string,
  quotes: VenueQuote[],
  freshnessWindowSeconds: number = 300,
  referenceTime: Date = new Date()
): DispersionResult {
  const refTimeMs = referenceTime.getTime()

  // Defensively filter valid quotes (finite, positive prices)
  const validQuotes = quotes.filter(
    (q) => Number.isFinite(q.price) && q.price > 0 && q.timestamp instanceof Date && !isNaN(q.timestamp.getTime())
  )

  const freshQuotes: VenueQuote[] = []
  const staleVenues: string[] = []

  for (const q of validQuotes) {
    const ageSeconds = Math.max(0, Math.floor((refTimeMs - q.timestamp.getTime()) / 1000))
    if (ageSeconds <= freshnessWindowSeconds) {
      freshQuotes.push(q)
    } else {
      staleVenues.push(q.venue)
    }
  }

  // Also include any originally passed quotes that were invalid in stale/unusable venues
  for (const q of quotes) {
    if (!validQuotes.includes(q) && !staleVenues.includes(q.venue)) {
      staleVenues.push(q.venue)
    }
  }

  staleVenues.sort()

  const freshVenues = freshQuotes.map((q) => q.venue).sort()
  const venueCount = freshQuotes.length

  // Insufficient venues: cannot calculate meaningful cross-venue dispersion
  if (venueCount < 2) {
    return {
      pairKey,
      status: 'insufficient_venues',
      venueCount,
      median: null,
      dispersionPct: null,
      spreadBps: null,
      minPrice: null,
      maxPrice: null,
      outlierVenue: null,
      outlierDeviationPct: null,
      isAmbiguous: false,
      freshVenues,
      staleVenues,
      venues: freshQuotes.map((q) => ({
        venue: q.venue,
        price: q.price,
        deviationPct: 0,
        ageSeconds: Math.max(0, Math.floor((refTimeMs - q.timestamp.getTime()) / 1000)),
      })),
      timestamp: referenceTime,
    }
  }

  const prices = freshQuotes.map((q) => q.price)
  const median = calculateMedian(prices)
  const minPrice = Math.min(...prices)
  const maxPrice = Math.max(...prices)
  const spreadBps = parseFloat((((maxPrice - minPrice) / median) * 10000).toFixed(2))

  const venueEvaluations: VenueEvaluation[] = freshQuotes.map((q) => {
    const deviationPct = parseFloat(((Math.abs(q.price - median) / median) * 100).toFixed(4))
    const ageSeconds = Math.max(0, Math.floor((refTimeMs - q.timestamp.getTime()) / 1000))
    return {
      venue: q.venue,
      price: q.price,
      deviationPct,
      ageSeconds,
    }
  })

  // Sort candidates to find the outlier:
  // 1. Primary: highest deviation from median (DESC)
  // 2. Tie-breaker: alphabetical by venue name (ASC) for full determinism
  const sortedByOutlier = [...venueEvaluations].sort((a, b) => {
    if (b.deviationPct !== a.deviationPct) {
      return b.deviationPct - a.deviationPct
    }
    return a.venue.localeCompare(b.venue)
  })

  const topOutlier = sortedByOutlier[0]
  const dispersionPct = topOutlier.deviationPct
  const outlierVenue = topOutlier.venue
  const outlierDeviationPct = topOutlier.deviationPct

  // In a 2-venue scenario, both venues are equidistant from the median by definition:
  // |p1 - (p1+p2)/2| == |p2 - (p1+p2)/2| == |p1 - p2|/2
  const isAmbiguous =
    venueCount === 2 ||
    (sortedByOutlier.length > 1 && sortedByOutlier[0].deviationPct === sortedByOutlier[1].deviationPct)

  return {
    pairKey,
    status: 'ok',
    venueCount,
    median: parseFloat(median.toFixed(8)),
    dispersionPct,
    spreadBps,
    minPrice,
    maxPrice,
    outlierVenue,
    outlierDeviationPct,
    isAmbiguous,
    freshVenues,
    staleVenues,
    venues: venueEvaluations,
    timestamp: referenceTime,
  }
}

/**
 * Fetches the latest price quotes per venue for a pair from `price_points`.
 * Leverages the indexed column order `(network, pair_key, source, timestamp DESC)`.
 */
export async function fetchLatestVenueQuotes(
  pairKey: string,
  network: NetworkName
): Promise<VenueQuote[]> {
  const result = await pgPool.query(
    `SELECT DISTINCT ON (source)
       source AS venue,
       price::numeric AS price,
       timestamp
     FROM price_points
     WHERE network = $1
       AND pair_key = $2
     ORDER BY source, timestamp DESC`,
    [network, pairKey]
  )

  return result.rows.map((row: any) => ({
    venue: row.venue as string,
    price: parseFloat(row.price),
    timestamp: new Date(row.timestamp),
  }))
}

/**
 * Persists a reconciliation run row to `venue_dispersions`.
 */
export async function recordDispersionRun(
  result: DispersionResult,
  network: NetworkName
) {
  return await prisma.venueDispersion.create({
    data: {
      network,
      pairKey: result.pairKey,
      timestamp: result.timestamp,
      venueCount: result.venueCount,
      median: result.median !== null ? result.median.toString() : null,
      dispersionPct: result.dispersionPct !== null ? result.dispersionPct.toString() : null,
      spreadBps: result.spreadBps !== null ? result.spreadBps.toString() : null,
      minPrice: result.minPrice !== null ? result.minPrice.toString() : null,
      maxPrice: result.maxPrice !== null ? result.maxPrice.toString() : null,
      outlierVenue: result.outlierVenue,
      outlierDeviation:
        result.outlierDeviationPct !== null ? result.outlierDeviationPct.toString() : null,
      status: result.status,
      isAmbiguous: result.isAmbiguous,
      freshVenues: result.freshVenues,
      staleVenues: result.staleVenues,
      venues: result.venues as any,
    },
  })
}

export interface DispersionQueryFilter {
  pairKey?: string
  network: NetworkName
  from?: Date
  to?: Date
  limit?: number
}

/**
 * Queries dispersion history over time.
 * Leverages index `(network, pair_key, timestamp DESC)`.
 */
export async function queryDispersionHistory(filter: DispersionQueryFilter) {
  const { pairKey, network, from, to, limit = 50 } = filter

  const whereClause: any = { network }
  if (pairKey) {
    whereClause.pairKey = pairKey
  }
  if (from || to) {
    whereClause.timestamp = {}
    if (from) whereClause.timestamp.gte = from
    if (to) whereClause.timestamp.lte = to
  }

  const boundedLimit = Math.max(1, Math.min(limit, 500))

  const records = await prisma.venueDispersion.findMany({
    where: whereClause,
    orderBy: { timestamp: 'desc' },
    take: boundedLimit,
  })

  return records.map((r) => ({
    id: r.id,
    network: r.network,
    pairKey: r.pairKey,
    timestamp: r.timestamp.toISOString(),
    venueCount: r.venueCount,
    median: r.median ? parseFloat(r.median.toString()) : null,
    dispersionPct: r.dispersionPct ? parseFloat(r.dispersionPct.toString()) : null,
    spreadBps: r.spreadBps ? parseFloat(r.spreadBps.toString()) : null,
    minPrice: r.minPrice ? parseFloat(r.minPrice.toString()) : null,
    maxPrice: r.maxPrice ? parseFloat(r.maxPrice.toString()) : null,
    outlierVenue: r.outlierVenue,
    outlierDeviation: r.outlierDeviation ? parseFloat(r.outlierDeviation.toString()) : null,
    status: r.status,
    isAmbiguous: r.isAmbiguous,
    freshVenues: r.freshVenues,
    staleVenues: r.staleVenues,
    venues: r.venues,
  }))
}
