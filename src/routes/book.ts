import { Asset } from '@stellar/stellar-sdk'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'
import { getHorizonServer } from '../network/clients'
import { aggregateBookLevels, generateAmmBookLevels, type AmmBookPool, type RawBookLevel } from '../pricing/book'
import { bookResponseSchema } from '../api/schemas'

const BookQuerySchema = z.object({
  depth: z.coerce.number().min(0).max(0.5).default(0.1),
  step: z.coerce.number().min(0.001).max(0.1).default(0.01),
  network: z.enum(['testnet', 'mainnet']).optional(),
})

const HORIZON_LEVEL_LIMIT = 200

interface ParsedAsset {
  code: string
  issuer: string | null
  canonical: string
  horizon: Asset
}

interface SnapshotRow {
  pool_id: string
  asset_a: string
  asset_b: string
  reserve_a: string | number
  reserve_b: string | number
  fee_bp: number
  timestamp: Date | string
}

interface HorizonLevel {
  price: string | number
  amount: string | number
}

interface BookSource {
  status: 'available' | 'no_liquidity' | 'unavailable'
  sampleCount: number
  observedAt: string | null
  dataAgeSeconds: number | null
  truncated: boolean
}

function parseAsset(raw: string): ParsedAsset {
  const normalized = raw.trim()
  if (!normalized || normalized.includes('/')) throw new Error('Invalid asset')
  const parts = normalized.split(':')
  if (parts.length > 2 || !parts[0]) throw new Error('Invalid asset')
  const code = parts[0].toUpperCase()
  const issuer = parts[1] || null

  if (code === 'XLM' && (!issuer || issuer.toLowerCase() === 'native')) {
    return { code, issuer: null, canonical: 'XLM', horizon: Asset.native() }
  }
  if (!issuer || issuer.toLowerCase() === 'native') {
    throw new Error('Non-native assets must include their issuer (CODE:ISSUER)')
  }

  const horizon = new Asset(code, issuer)
  return { code, issuer, canonical: `${code}:${issuer}`, horizon }
}

function makePairKey(assetA: ParsedAsset, assetB: ParsedAsset): string {
  return [assetA.canonical, assetB.canonical].sort().join('/')
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sourceProvenance(
  sampleCount: number,
  observedAt: string | null,
  now: Date,
  truncated = false,
): BookSource {
  return {
    status: sampleCount > 0 ? 'available' : 'no_liquidity',
    sampleCount,
    observedAt,
    dataAgeSeconds: observedAt ? Math.max(0, (now.getTime() - new Date(observedAt).getTime()) / 1000) : null,
    truncated,
  }
}

async function readSdexBook(assetA: Asset, assetB: Asset, network: NetworkName) {
  const result = await (getHorizonServer(network) as unknown as {
    orderbook: (base: Asset, counter: Asset) => {
      limit: (count: number) => { call: () => Promise<{ asks: HorizonLevel[]; bids: HorizonLevel[] }> }
    }
  }).orderbook(assetA, assetB).limit(HORIZON_LEVEL_LIMIT).call()
  const observedAt = new Date().toISOString()
  const levels: { asks: HorizonLevel[]; bids: HorizonLevel[] } = { asks: result.asks ?? [], bids: result.bids ?? [] }
  return {
    levels,
    observedAt,
    sampleCount: levels.asks.length + levels.bids.length,
    truncated: levels.asks.length >= HORIZON_LEVEL_LIMIT || levels.bids.length >= HORIZON_LEVEL_LIMIT,
  }
}

async function readAmmPools(pairKey: string, network: NetworkName): Promise<SnapshotRow[]> {
  const { rows } = await pgPool.query<SnapshotRow>(
    `SELECT DISTINCT ON (ps.pool_id)
            ps.pool_id, ps.asset_a, ps.asset_b, ps.reserve_a, ps.reserve_b,
            ps.fee_bp, ps.timestamp
       FROM pool_snapshots ps
       JOIN (
         SELECT DISTINCT pool_id
           FROM price_points
          WHERE network = $1
            AND pair_key = $2
            AND source = 'AMM'
            AND pool_id IS NOT NULL
       ) known_pools ON known_pools.pool_id = ps.pool_id
      WHERE ps.network = $1
      ORDER BY ps.pool_id, ps.timestamp DESC`,
    [network, pairKey],
  )
  return rows
}

/**
 * GET /book/:assetA/:assetB?depth=0.1&step=0.01&network=testnet
 * `depth` is a fractional price distance from spot; `step` is the reserve
 * fraction used for each synthetic AMM rung.
 */
export async function registerBookRoutes(app: FastifyInstance) {
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { depth?: string; step?: string; network?: string }
  }>('/book/:assetA/:assetB', { schema: { response: { 200: bookResponseSchema, 503: bookResponseSchema } } }, async (req, reply) => {
    const parsedQuery = BookQuerySchema.safeParse(req.query)
    if (!parsedQuery.success) {
      return reply.status(400).send({ error: parsedQuery.error.issues[0]?.message ?? 'Invalid book parameters' })
    }

    let assetA: ParsedAsset
    let assetB: ParsedAsset
    try {
      assetA = parseAsset(req.params.assetA)
      assetB = parseAsset(req.params.assetB)
      if (assetA.canonical === assetB.canonical) throw new Error('Assets must be different')
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }

    const network: NetworkName = req.network ?? activeNetwork
    const { depth, step } = parsedQuery.data
    const pairKey = makePairKey(assetA, assetB)

    const [sdexResult, ammResult] = await Promise.allSettled([
      readSdexBook(assetA.horizon, assetB.horizon, network),
      readAmmPools(pairKey, network),
    ])

    const now = new Date()
    const sdex = sdexResult.status === 'fulfilled' ? sdexResult.value : null
    const snapshots = ammResult.status === 'fulfilled' ? ammResult.value : []
    const rawAsks: RawBookLevel[] = []
    const rawBids: RawBookLevel[] = []

    if (sdex) {
      for (const level of sdex.levels.asks) {
        const price = asFiniteNumber(level.price)
        const size = asFiniteNumber(level.amount)
        if (price !== null && size !== null && price > 0 && size > 0) rawAsks.push({ price, size, venue: 'SDEX', synthetic: false })
      }
      for (const level of sdex.levels.bids) {
        const price = asFiniteNumber(level.price)
        const size = asFiniteNumber(level.amount)
        if (price !== null && size !== null && price > 0 && size > 0) rawBids.push({ price, size, venue: 'SDEX', synthetic: false })
      }
    }

    const ammPools: AmmBookPool[] = snapshots.flatMap(row => {
      const storedReserveA = asFiniteNumber(row.reserve_a)
      const storedReserveB = asFiniteNumber(row.reserve_b)
      if (storedReserveA === null || storedReserveB === null) return []
      const isForward = row.asset_a.toUpperCase() === assetA.code
      const reserveA = isForward ? storedReserveA : storedReserveB
      const reserveB = isForward ? storedReserveB : storedReserveA
      if (row.asset_a.toUpperCase() !== assetA.code && row.asset_b.toUpperCase() !== assetA.code) return []
      return [{ poolId: row.pool_id, reserveA, reserveB, feeBp: Number(row.fee_bp) }]
    })

    const sdexBestAsk = rawAsks.filter(level => !level.synthetic).sort((a, b) => a.price - b.price)[0]?.price
    const sdexBestBid = rawBids.filter(level => !level.synthetic).sort((a, b) => b.price - a.price)[0]?.price
    const ammBase = ammPools.reduce((total, pool) => total + pool.reserveA, 0)
    const ammQuote = ammPools.reduce((total, pool) => total + pool.reserveB, 0)
    const ammSpot = ammBase > 0 ? ammQuote / ammBase : null
    const spotPrice = sdexBestAsk !== undefined && sdexBestBid !== undefined
      ? (sdexBestAsk + sdexBestBid) / 2
      : sdexBestAsk ?? sdexBestBid ?? ammSpot
    const spotSource = sdexBestAsk !== undefined && sdexBestBid !== undefined
      ? 'SDEX_MID'
      : sdexBestAsk !== undefined
        ? 'SDEX_ASK'
        : sdexBestBid !== undefined
          ? 'SDEX_BID'
          : ammSpot !== null
            ? 'AMM_RESERVES'
            : null

    if (spotPrice !== null && spotPrice > 0) {
      for (const pool of ammPools) {
        const levels = generateAmmBookLevels(pool, depth, step, spotPrice)
        rawAsks.push(...levels.asks)
        rawBids.push(...levels.bids)
      }
    }

    // Restrict real order-book levels to the same price band used to walk AMMs.
    const boundedAsks = spotPrice === null
      ? []
      : rawAsks.filter(level => level.price <= spotPrice * (1 + depth))
    const boundedBids = spotPrice === null
      ? []
      : rawBids.filter(level => level.price >= spotPrice * (1 - depth))
    const asks = aggregateBookLevels(boundedAsks, 'asks')
    const bids = aggregateBookLevels(boundedBids, 'bids')

    const latestAmmTimestamp = snapshots.reduce<Date | null>((latest, row) => {
      const timestamp = new Date(row.timestamp)
      return !latest || timestamp > latest ? timestamp : latest
    }, null)
    const sdexSource = sdexResult.status === 'rejected'
      ? { status: 'unavailable' as const, sampleCount: 0, observedAt: null, dataAgeSeconds: null, truncated: false }
      : sourceProvenance(sdexResult.value.sampleCount, sdexResult.value.observedAt, now, sdexResult.value.truncated)
    const ammSource = ammResult.status === 'rejected'
      ? { status: 'unavailable' as const, sampleCount: 0, observedAt: null, dataAgeSeconds: null, truncated: false }
      : sourceProvenance(snapshots.length, latestAmmTimestamp?.toISOString() ?? null, now)
    const hasData = sdexSource.sampleCount > 0 || ammSource.sampleCount > 0
    const hasFailure = sdexSource.status === 'unavailable' || ammSource.status === 'unavailable'
    const hasLevels = asks.length > 0 || bids.length > 0
    const status = !hasData
      ? hasFailure ? 'unavailable' : 'no_liquidity'
      : hasFailure
        ? 'partial'
        : !hasLevels
          ? 'no_levels_in_range'
          : 'ok'

    const response = {
      assetA: assetA.canonical,
      assetB: assetB.canonical,
      pairKey,
      network,
      spotPrice,
      spotSource,
      depth,
      step,
      status,
      asks,
      bids,
      provenance: {
        sampledAt: now.toISOString(),
        sampleCount: sdexSource.sampleCount + ammSource.sampleCount,
        venues: [
          { venue: 'SDEX', ...sdexSource },
          { venue: 'AMM', ...ammSource },
        ],
      },
    }

    if (!hasData && hasFailure) {
      return reply.status(503).send(response)
    }
    return response
  })
}
