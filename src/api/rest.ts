import type { FastifyInstance } from 'fastify'
import { price_requests_total } from '../metrics'
import { getCachedPrice, setCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, getNetworkConfig, activeNetwork, type NetworkName } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type
import {
  statusResponseSchema,
  priceResponseSchema,
  routeResponseSchema,
  historyResponseSchema,
  poolsResponseSchema,
  depthResponseSchema,
  impactResponseSchema,
  installResponseValidation,
} from './schemas'
import { getDepth, getImpact } from '../pricing/depth'
import { listCrashes } from '../ingester/restart'
import { resolveDecimalFormat, formatDecimal } from '../utils/decimals'

function makePairKey(a: string, b: string): string {
  return [a, b].sort().join('/')
}

export const HISTORY_DEFAULT_LIMIT = 100
export const HISTORY_MAX_LIMIT = 1000

/**
 * Resolve a requested pair against the ones this network watches.
 *
 * The issuer is honoured when the caller supplies one. It used to be discarded
 * outright — `a.split(':')[0]` — so every asset called USDC was the same asset,
 * and a request for Circle's mainnet USDC was answered with testnet USDC's
 * price, stamped `"network":"testnet"`, at 1.72 per XLM against a real ~0.18.
 *
 * That is the worst failure mode an oracle has: not a refusal, but a confident
 * wrong number. Asset codes are not unique on Stellar — anyone can issue
 * "USDC", and Horizon lists many — so the issuer is the only thing that
 * identifies an asset. A bare code still matches on code alone, since callers
 * quoting XLM or a single-issuer asset rely on that.
 */
function findPair(assetA: string, assetB: string, network: NetworkName) {
  const parse = (a: string) => {
    if (a.toLowerCase() === 'native') return { code: 'XLM', issuer: null as string | null }
    const [code, issuer] = a.split(':')
    return { code: (code ?? '').toUpperCase(), issuer: issuer ?? null }
  }
  const qA = parse(assetA)
  const qB = parse(assetB)

  const matches = (
    q: { code: string; issuer: string | null },
    side: { code: string; issuer?: string | null },
  ) => {
    if (q.code !== side.code.toUpperCase()) return false
    // Only enforce the issuer when both sides name one; XLM has none, and a
    // caller passing a bare code is not asserting which issuer they meant.
    if (!q.issuer || !side.issuer) return true
    return q.issuer === side.issuer
  }

  return getNetworkConfig(network).pairs.find(
    p =>
      (matches(qA, p.assetA) && matches(qB, p.assetB)) ||
      (matches(qA, p.assetB) && matches(qB, p.assetA)),
  )
}

export async function registerRESTRoutes(app: FastifyInstance) {
  // Validate every response against its declared schema in dev/test (no-op in
  // production). Must run before the routes below are registered so they pick
  // up the validating serializer.
  installResponseValidation(app)

  // GET /status — public health/monitoring endpoint (no API key required)
  app.get('/status', { config: { public: true }, schema: { response: { 200: statusResponseSchema } } }, async (req) => {
    const network = req.network ?? activeNetwork
    const result = await pgPool.query(
      `SELECT last_ledger, last_processed_at
         FROM indexer_state
        WHERE network = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [network]
    )
    const lastProcessedAt = result.rows[0]?.last_processed_at ?? null
    return {
      ok: true,
      network,
      watchedPairs: getNetworkConfig(network).pairs.map(p => p.pairKey),
      lastIndexedLedger: result.rows[0]?.last_ledger ?? null,
      lastProcessedAt,
      // Seconds since the last write for this network — a stalled ingester is
      // visible to `/status` polling without needing Prometheus. Null until the
      // network has ingested at least once.
      ingestLagSeconds: lastProcessedAt
        ? Math.max(0, Math.round((Date.now() - new Date(lastProcessedAt).getTime()) / 1000))
        : null,
      // Ingesters that have crashed at least once on this network, newest
      // first. An ingester that crash-loops but restarts successfully is
      // otherwise invisible here: the process is up and the port answers.
      // Empty when nothing has crashed. Messages only — never a stack, since
      // this is served over HTTP.
      crashes: listCrashes(network).map(c => ({
        name: c.name,
        network: c.network,
        message: c.message,
        at: c.at.toISOString(),
      })),
    }
  })


  // GET /price/:assetA/:assetB
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { decimals?: string; decimalFormat?: string }
  }>(
    '/price/:assetA/:assetB',
    { config: { scope: 'read:prices' }, schema: { response: { 200: priceResponseSchema } } },
    async (req, reply) => {
      price_requests_total.inc()
      const { assetA, assetB } = req.params
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })

      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      // Cache key is network-scoped and format-isolated so number and string payloads never collide.
      const cacheKey = decimalFormat === 'string'
        ? `${network}:${pair.pairKey}:decimals_string`
        : `${network}:${pair.pairKey}`
      const cached = await getCachedPrice(cacheKey)
      if (cached) {
        try {
          reply.header('X-Cache', 'HIT')
          return JSON.parse(cached)
        } catch { /* fall through */ }
      }

      const agg = await getAggregatedPrice(pair.pairKey, network, { decimalFormat })
      const route = await getBestRoute(pair.assetA, pair.assetB, pair.pairKey, 1000, network)
      const result = {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        network,
        ...agg,
        bestRoute: route.route,
        lastUpdated: new Date().toISOString(),
      }

      await setCachedPrice(cacheKey, result, config.cache.priceTtl)
      reply.header('X-Cache', 'MISS')
      return result
    }
  )

  // GET /price/:assetA/:assetB/route?amount=1000
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { amount?: string; network?: string }
  }>(
    '/price/:assetA/:assetB/route',
    { config: { scope: 'read:prices' }, schema: { response: { 200: routeResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const amount = parseFloat(req.query.amount ?? '1000')
      // Validate amount before the pair check: a malformed request parameter
      // is a 400 regardless of whether the pair is watched.
      if (isNaN(amount) || amount <= 0) return reply.status(400).send({ error: 'amount must be a positive number' })
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })

      const decimalFormat = resolveDecimalFormat(req)
      const routeInfo = await getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount, network)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
        return {
          ...routeInfo,
          sdexPrice: String(routeInfo.sdexPrice),
          ammPrice: String(routeInfo.ammPrice),
          estimatedOutput: String(routeInfo.estimatedOutput),
          slippagePct: String(routeInfo.slippagePct),
        }
      }
      return routeInfo
    }
  )

  // GET /price/:assetA/:assetB/history?window=1h&limit=100
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { window?: string; limit?: string; decimals?: string; decimalFormat?: string }
  }>(
    '/price/:assetA/:assetB/history',
    { config: { scope: 'read:history' }, schema: { response: { 200: historyResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const window = req.query.window ?? '1h'
      const limit = Math.min(parseInt(req.query.limit ?? String(HISTORY_DEFAULT_LIMIT), 10), HISTORY_MAX_LIMIT)
      const pairKey = makePairKey(assetA, assetB)
      const network = req.network ?? activeNetwork
      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      if (!['1m', '5m', '1h', '24h'].includes(window)) {
        return reply.status(400).send({ error: 'window must be one of: 1m, 5m, 1h, 24h' })
      }

      const result = await pgPool.query(
        `SELECT bucket, window, vwap::numeric, sdex_vwap::numeric, amm_vwap::numeric,
                volume::numeric, trade_count, open_price::numeric, close_price::numeric,
                high_price::numeric, low_price::numeric
         FROM price_aggregates
         WHERE pair_key = $1 AND window = $2 AND network = $3
         ORDER BY bucket DESC
         LIMIT $4`,
        [pairKey, window, network, limit]
      )

      return {
        pairKey,
        network,
        window,
        buckets: result.rows.map(r => ({
          bucket: r.bucket,
          vwap: formatDecimal(r.vwap, decimalFormat),
          sdexVwap: formatDecimal(r.sdex_vwap, decimalFormat),
          ammVwap: formatDecimal(r.amm_vwap, decimalFormat),
          volume: formatDecimal(r.volume, decimalFormat),
          tradeCount: r.trade_count !== null && r.trade_count !== undefined ? parseInt(String(r.trade_count), 10) : null,
          open: formatDecimal(r.open_price, decimalFormat),
          close: formatDecimal(r.close_price, decimalFormat),
          high: formatDecimal(r.high_price, decimalFormat),
          low: formatDecimal(r.low_price, decimalFormat),
        })),
      }
    }
  )

  // GET /pools
  //
  // Latest snapshot per pool for one network, without reading history. The pool
  // ids are discovered with a recursive "skip scan" over the
  // (network, pool_id, timestamp DESC) index (jump to the next distinct pool_id
  // each step), then one LIMIT 1 index probe per pool fetches its newest row.
  // Cost is O(pools x log n); the old DISTINCT ON sorted every row of every
  // network. A quiet pool is kept with its real `timestamp`, never dropped.
  app.get('/pools', { config: { scope: 'read:prices' }, schema: { response: { 200: poolsResponseSchema } } }, async (req, reply) => {
    const network = req.network ?? activeNetwork
    const decimalFormat = resolveDecimalFormat(req)
    if (decimalFormat === 'string') {
      reply.header('x-decimal-format', 'string')
    }
    const result = await pgPool.query(
      `WITH RECURSIVE ids AS (
         (SELECT pool_id FROM pool_snapshots WHERE network = $1 ORDER BY pool_id LIMIT 1)
         UNION ALL
         SELECT (SELECT s.pool_id FROM pool_snapshots s
                  WHERE s.network = $1 AND s.pool_id > ids.pool_id
                  ORDER BY s.pool_id LIMIT 1)
           FROM ids
          WHERE ids.pool_id IS NOT NULL
       )
       SELECT l.pool_id, l.asset_a, l.asset_b,
              l.reserve_a::numeric, l.reserve_b::numeric, l.spot_price::numeric, l.fee_bp, l.timestamp
         FROM ids
        CROSS JOIN LATERAL (
              SELECT * FROM pool_snapshots s
               WHERE s.network = $1 AND s.pool_id = ids.pool_id
               ORDER BY s.timestamp DESC
               LIMIT 1
             ) l
        WHERE ids.pool_id IS NOT NULL`,
        [network]
      )
      return {
        pools: result.rows.map(r => ({
          pool_id: r.pool_id,
          asset_a: r.asset_a,
          asset_b: r.asset_b,
          reserve_a: formatDecimal(r.reserve_a, decimalFormat),
          reserve_b: formatDecimal(r.reserve_b, decimalFormat),
          spot_price: formatDecimal(r.spot_price, decimalFormat),
          fee_bp: r.fee_bp !== null && r.fee_bp !== undefined ? parseInt(String(r.fee_bp), 10) : null,
          timestamp: r.timestamp,
        })),
      }
    }
  )

  // GET /price/:assetA/:assetB/depth?amount=1000
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { amount?: string; decimals?: string; decimalFormat?: string }
  }>(
    '/price/:assetA/:assetB/depth',
    { config: { scope: 'read:prices' }, schema: { response: { 200: depthResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const amount = parseFloat(req.query.amount ?? '1000')
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)

      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })
      if (isNaN(amount) || amount <= 0) return reply.status(400).send({ error: 'amount must be a positive number' })

      const depthResult = await getDepth(pair.pairKey, amount, network)
      
      return {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        ...depthResult,
      }
    }
  )

  // GET /impact/:assetA/:assetB?thresholds=1,5,10
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { thresholds?: string; liquidityFraction?: string }
  }>(
    '/impact/:assetA/:assetB',
    { schema: { response: { 200: impactResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })

      const thresholds = req.query.thresholds
        ? req.query.thresholds.split(',').map(Number)
        : [1, 5, 10]
      const liquidityFraction = req.query.liquidityFraction === undefined
        ? 0.5
        : Number(req.query.liquidityFraction)
      if (
        thresholds.length === 0 ||
        thresholds.some(value => !Number.isFinite(value) || value <= 0) ||
        !Number.isFinite(liquidityFraction) || liquidityFraction <= 0 || liquidityFraction > 1
      ) {
        return reply.status(400).send({ error: 'thresholds must be positive numbers and liquidityFraction must be between 0 and 1' })
      }

      const impact = await getImpact(pair.pairKey, { thresholds, liquidityFraction }, network)
      if (!impact) return reply.status(404).send({ error: `No AMM liquidity available for ${assetA}/${assetB}` })
      return { assetA: pair.assetA.code, assetB: pair.assetB.code, pairKey: pair.pairKey, ...impact }
    }
  )
}
