import { createLogger } from '../logger'
import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

const log = createLogger('correlation')

/**
 * Supported correlation windows and their duration in minutes.
 */
export const CORRELATION_WINDOWS: Record<string, number> = {
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '24h': 1440,
  '7d': 10080,
  '30d': 43200,
} as const

export type CorrelationWindow = keyof typeof CORRELATION_WINDOWS
export const SUPPORTED_WINDOWS = Object.keys(CORRELATION_WINDOWS) as CorrelationWindow[]

/**
 * Minimum overlapping samples required to compute a meaningful Pearson correlation coefficient.
 * When overlapping samples are fewer than 3, the sample variance or covariance has 0 degrees of freedom,
 * or insufficient statistical significance.
 */
export const MIN_CORRELATION_SAMPLES = 3

export interface PairProvenance {
  sampleCount: number
  venues: string[]
  oldestSample: string | null
  newestSample: string | null
}

export type PairStatus = 'computed' | 'insufficient'

export interface CorrelationCell {
  assetA: string
  assetB: string
  coefficient: number | null
  status: PairStatus
  sampleCount: number
  provenance: PairProvenance
}

/**
 * Computes Pearson correlation coefficient between two numeric series of equal length.
 * r = Σ((x - x̄)(y - ȳ)) / sqrt(Σ(x - x̄)² * Σ(y - ȳ)²)
 */
export function computePearsonCorrelation(x: number[], y: number[]): number | null {
  const n = x.length
  if (n !== y.length || n < MIN_CORRELATION_SAMPLES) return null

  let sumX = 0
  let sumY = 0
  for (let i = 0; i < n; i++) {
    sumX += x[i]
    sumY += y[i]
  }
  const meanX = sumX / n
  const meanY = sumY / n

  let num = 0
  let denX = 0
  let denY = 0

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX
    const dy = y[i] - meanY
    num += dx * dy
    denX += dx * dx
    denY += dy * dy
  }

  const den = Math.sqrt(denX * denY)
  // If variance is 0 (constant price series), correlation is undefined / 0
  if (den === 0 || !Number.isFinite(den)) return 0

  const r = num / den
  // Bound to [-1, 1] against floating point inaccuracies
  return Math.max(-1, Math.min(1, parseFloat(r.toFixed(6))))
}

export async function registerCorrelationRoutes(app: FastifyInstance) {
  /**
   * GET /correlation?assets=XLM,USDC,EURC&window=24h&network=testnet
   * Or: GET /correlation?assets=XLM&assets=USDC
   */
  app.get<{
    Querystring: {
      assets?: string | string[]
      window?: string
      network?: string
    }
  }>('/correlation', async (req, reply) => {
    const rawAssets = req.query.assets
    let assetList: string[] = []

    if (rawAssets) {
      if (Array.isArray(rawAssets)) {
        for (const item of rawAssets) {
          assetList.push(...item.split(',').map(s => s.trim()))
        }
      } else {
        assetList.push(...rawAssets.split(',').map(s => s.trim()))
      }
    }

    // Filter empties and deduplicate preserving casing/normalized
    assetList = Array.from(new Set(assetList.filter(Boolean).map(a => a.toUpperCase())))

    if (assetList.length === 0) {
      return reply.status(400).send({ error: 'assets parameter is required' })
    }
    if (assetList.length < 2) {
      return reply.status(400).send({ error: 'At least 2 assets are required to compute correlation' })
    }

    const rawWindow = req.query.window ?? '24h'
    if (!(rawWindow in CORRELATION_WINDOWS)) {
      return reply.status(400).send({
        error: `window must be one of: ${SUPPORTED_WINDOWS.join(', ')}`,
      })
    }

    const requestedNetwork = req.query.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }

    const network: NetworkName = req.network ?? (requestedNetwork as NetworkName) ?? activeNetwork
    const windowMinutes = CORRELATION_WINDOWS[rawWindow as CorrelationWindow]
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - windowMinutes * 60 * 1000)

    try {
      // Query raw price points for the requested assets within the window on this network.
      // We select price points where asset_a or asset_b matches one of the assets.
      const { rows } = await pgPool.query(
        `SELECT
           asset_a,
           asset_b,
           source,
           price::numeric AS price,
           timestamp
         FROM price_points
         WHERE network = $1
           AND timestamp >= $2
           AND (asset_a = ANY($3::text[]) OR asset_b = ANY($3::text[]))
         ORDER BY timestamp ASC`,
        [network, startTime, assetList]
      )

      // Map rows into per-asset observation streams: { timestampMs: number, price: number, source: string }
      // For a trade between asset_a and asset_b, if asset matches asset_a, price is price;
      // if asset matches asset_b, price is 1 / price.
      const assetObservations = new Map<string, Array<{ ts: number; price: number; source: string; timestampIso: string }>>()
      for (const a of assetList) {
        assetObservations.set(a, [])
      }

      for (const row of rows) {
        const p = parseFloat(row.price)
        if (!Number.isFinite(p) || p <= 0) continue
        const ts = new Date(row.timestamp).getTime()
        const timestampIso = new Date(row.timestamp).toISOString()
        const source = String(row.source)

        const aA = String(row.asset_a).toUpperCase()
        const aB = String(row.asset_b).toUpperCase()

        if (assetObservations.has(aA)) {
          assetObservations.get(aA)!.push({ ts, price: p, source, timestampIso })
        }
        if (assetObservations.has(aB)) {
          assetObservations.get(aB)!.push({ ts, price: 1 / p, source, timestampIso })
        }
      }

      // Bucket or interpolate observations into synchronized intervals to compute overlap.
      // If window <= 1h, use 1-minute buckets (60s).
      // If window <= 24h, use 5-minute buckets (300s).
      // If window <= 7d, use 1-hour buckets (3600s).
      // If window > 7d, use 4-hour buckets (14400s).
      let bucketSecs = 60
      if (windowMinutes > 60 && windowMinutes <= 1440) {
        bucketSecs = 300
      } else if (windowMinutes > 1440 && windowMinutes <= 10080) {
        bucketSecs = 3600
      } else if (windowMinutes > 10080) {
        bucketSecs = 14400
      }

      const bucketMs = bucketSecs * 1000

      // For each asset, build a Map<bucketIndex, { lastPrice: number, venues: Set<string>, oldest: string, newest: string }>
      const assetBuckets = new Map<string, Map<number, { price: number; venues: Set<string>; oldest: string; newest: string }>>()

      for (const [asset, obs] of assetObservations.entries()) {
        const buckets = new Map<number, { price: number; venues: Set<string>; oldest: string; newest: string }>()
        for (const item of obs) {
          const bIdx = Math.floor(item.ts / bucketMs)
          const existing = buckets.get(bIdx)
          if (!existing) {
            buckets.set(bIdx, {
              price: item.price,
              venues: new Set([item.source]),
              oldest: item.timestampIso,
              newest: item.timestampIso,
            })
          } else {
            existing.price = item.price // latest in bucket
            existing.venues.add(item.source)
            existing.newest = item.timestampIso
          }
        }
        assetBuckets.set(asset, buckets)
      }

      // Build correlation matrix
      const matrix: Record<string, Record<string, number | null>> = {}
      const sampleCounts: Record<string, Record<string, number>> = {}
      const cells: CorrelationCell[] = []

      for (const a of assetList) {
        matrix[a] = {}
        sampleCounts[a] = {}
      }

      for (let i = 0; i < assetList.length; i++) {
        const assetA = assetList[i]
        const bucketsA = assetBuckets.get(assetA)!

        for (let j = 0; j < assetList.length; j++) {
          const assetB = assetList[j]
          const bucketsB = assetBuckets.get(assetB)!

          if (i === j) {
            // Correlation of asset with itself
            const sampleCount = bucketsA.size
            const allVenues = new Set<string>()
            let oldest: string | null = null
            let newest: string | null = null

            for (const b of bucketsA.values()) {
              b.venues.forEach(v => allVenues.add(v))
              if (!oldest || b.oldest < oldest) oldest = b.oldest
              if (!newest || b.newest > newest) newest = b.newest
            }

            const isSufficient = sampleCount >= MIN_CORRELATION_SAMPLES
            const coeff = isSufficient ? 1.0 : null
            const status: PairStatus = isSufficient ? 'computed' : 'insufficient'

            matrix[assetA][assetB] = coeff
            sampleCounts[assetA][assetB] = sampleCount

            cells.push({
              assetA,
              assetB,
              coefficient: coeff,
              status,
              sampleCount,
              provenance: {
                sampleCount,
                venues: Array.from(allVenues).sort(),
                oldestSample: oldest,
                newestSample: newest,
              },
            })
          } else if (i < j) {
            // Find overlapping buckets
            const commonBucketIndices: number[] = []
            for (const bIdx of bucketsA.keys()) {
              if (bucketsB.has(bIdx)) {
                commonBucketIndices.push(bIdx)
              }
            }
            commonBucketIndices.sort((x, y) => x - y)

            const sampleCount = commonBucketIndices.length
            sampleCounts[assetA][assetB] = sampleCount
            sampleCounts[assetB][assetA] = sampleCount

            const allVenues = new Set<string>()
            let oldest: string | null = null
            let newest: string | null = null

            const seriesA: number[] = []
            const seriesB: number[] = []

            for (const bIdx of commonBucketIndices) {
              const bA = bucketsA.get(bIdx)!
              const bB = bucketsB.get(bIdx)!

              seriesA.push(bA.price)
              seriesB.push(bB.price)

              bA.venues.forEach(v => allVenues.add(v))
              bB.venues.forEach(v => allVenues.add(v))

              if (!oldest || bA.oldest < oldest) oldest = bA.oldest
              if (!oldest || bB.oldest < oldest) oldest = bB.oldest
              if (!newest || bA.newest > newest) newest = bA.newest
              if (!newest || bB.newest > newest) newest = bB.newest
            }

            const venuesList = Array.from(allVenues).sort()

            if (sampleCount < MIN_CORRELATION_SAMPLES) {
              // Insufficient overlap reported, not computed
              matrix[assetA][assetB] = null
              matrix[assetB][assetA] = null

              const cellAB: CorrelationCell = {
                assetA,
                assetB,
                coefficient: null,
                status: 'insufficient',
                sampleCount,
                provenance: {
                  sampleCount,
                  venues: venuesList,
                  oldestSample: oldest,
                  newestSample: newest,
                },
              }
              const cellBA: CorrelationCell = {
                assetA: assetB,
                assetB: assetA,
                coefficient: null,
                status: 'insufficient',
                sampleCount,
                provenance: {
                  sampleCount,
                  venues: venuesList,
                  oldestSample: oldest,
                  newestSample: newest,
                },
              }
              cells.push(cellAB, cellBA)
            } else {
              const coeff = computePearsonCorrelation(seriesA, seriesB)
              matrix[assetA][assetB] = coeff
              matrix[assetB][assetA] = coeff

              const cellAB: CorrelationCell = {
                assetA,
                assetB,
                coefficient: coeff,
                status: 'computed',
                sampleCount,
                provenance: {
                  sampleCount,
                  venues: venuesList,
                  oldestSample: oldest,
                  newestSample: newest,
                },
              }
              const cellBA: CorrelationCell = {
                assetA: assetB,
                assetB: assetA,
                coefficient: coeff,
                status: 'computed',
                sampleCount,
                provenance: {
                  sampleCount,
                  venues: venuesList,
                  oldestSample: oldest,
                  newestSample: newest,
                },
              }
              cells.push(cellAB, cellBA)
            }
          }
        }
      }

      return {
        network,
        window: rawWindow,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        assets: assetList,
        matrix,
        sampleCounts,
        pairs: cells,
      }
    } catch (err) {
      log.error({ err }, 'correlation computation failed')
      return reply.status(500).send({ error: 'Correlation computation failed' })
    }
  })
}
