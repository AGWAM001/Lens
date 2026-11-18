import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import {
  CANDLES_DEFAULT_LIMIT,
  CANDLES_MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  parseLimit,
  slicePage,
} from '../pagination'
import { activeNetwork, type NetworkName } from '../config'
import { findOverlappingGaps } from '../backfill/gaps'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { formatPrice, formatVolume } from '../pricing/precision'


import { apiError } from '../errors'
const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
}

/**
 * Register the OHLCV candle endpoint.
 *
 * GET /candles/:assetA/:assetB?interval=1h&from=…&to=…
 *
 * The query window is half-open — [from, to). `from` is inclusive, `to` is
 * exclusive — so two adjacent windows [T0, T1) and [T1, T2) share no boundary
 * and a sample landing exactly on T1 is counted exactly once across the pair.
 * An inclusive-at-both-ends window double-counted every such sample.
 */
export async function registerCandleRoutes(app: FastifyInstance) {
  // GET /candles/:assetA/:assetB?interval=&from=&to=&cursor=&limit=
  //
  // Paginated keyset-style on the bucket start time ASC (default limit 500,
  // max 5000). The cursor carries the last page's bucket epoch in seconds (the
  // tiebreaker id is the pairKey, kept so every route emits the same cursor
  // shape), and the keyset predicate is applied to the bucket expression in
  // the WHERE clause, so a candle inserted mid-paging cannot shift a page
  // boundary the way an offset would.
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { interval?: string; from?: string; to?: string; cursor?: string; limit?: string }
  }>('/candles/:assetA/:assetB', { config: { scope: 'read:history' } }, async (req, reply) => {
    const { assetA, assetB } = req.params
    const interval = req.query.interval ?? '1h'
    const intervalSecs = INTERVAL_SECONDS[interval]

    if (!intervalSecs) {
      return reply.status(400).send({
        ...apiError('bad_interval', `interval must be one of: ${Object.keys(INTERVAL_SECONDS).join(', ')}`),
      })
    }

    const parsedLimit = parseLimit(req.query.limit, CANDLES_DEFAULT_LIMIT, CANDLES_MAX_LIMIT)
    if ('error' in parsedLimit) {
      return reply.status(400).send(apiError('invalid_parameter', parsedLimit.error))
    }
    const { limit } = parsedLimit

    const pairKey = [assetA, assetB].sort().join('/')

    // `price_points` indexes `network` as the leading column of
    // (network, pair_key, timestamp), so the predicate has to be there for the
    // range scan to be an index scan. It is also the difference between one
    // chain's candles and a blend of two chains' candles.
    const network: NetworkName = req.network ?? activeNetwork

    const fromRaw = req.query.from
    const toRaw = req.query.to
    const from = fromRaw ? new Date(fromRaw) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to = toRaw ? new Date(toRaw) : new Date()

    if (isNaN(from.getTime())) {
      return reply.status(400).send(apiError('invalid_parameter', 'from must be a valid ISO 8601 date'))
    }
    if (isNaN(to.getTime())) {
      return reply.status(400).send(apiError('invalid_parameter', 'to must be a valid ISO 8601 date'))
    }

    // $5 is the network predicate in the WHERE clause below. It has to be
    // pushed here, before the optional cursor and the limit, or those take
    // its placeholder and every row is compared against a row count.
    const params: unknown[] = [intervalSecs, pairKey, from, to, network]
    let cursorCondition = ''
    if (req.query.cursor) {
      const decoded = decodeCursor(req.query.cursor)
      if (decoded === null) {
        return reply.status(400).send(apiError('invalid_parameter', 'Invalid cursor format'))
      }
      if (decoded !== 'skip') {
        params.push(Number(decoded.value))
        cursorCondition = ` AND floor(EXTRACT(EPOCH FROM observed_at) / $1) * $1 > $${params.length}`
      }
    }
    params.push(limit + 1) // Fetch one extra to determine hasMore

    const result = await pgPool.query(
      `SELECT
         to_timestamp(floor(EXTRACT(EPOCH FROM observed_at) / $1) * $1) AS time,
         (array_agg(price ORDER BY observed_at ASC, id ASC))[1]  AS open,
         MAX(price)                                              AS high,
         MIN(price)                                              AS low,
         (array_agg(price ORDER BY observed_at DESC, id DESC))[1] AS close,
         SUM(base_volume)                                        AS volume
       FROM price_points
       WHERE pair_key = $2
         AND network = $5
         AND observed_at >= $3
         AND observed_at < $4${cursorCondition}
       GROUP BY floor(EXTRACT(EPOCH FROM observed_at) / $1)
       ORDER BY time ASC
       LIMIT $${params.length}`,
      params
    )

    const overlappingGaps = await findOverlappingGaps({
      network,
      pair: pairKey,
      start: from,
      end: to,
    })

    const gapDeclaration = overlappingGaps.length > 0 ? { incomplete: true, gaps: overlappingGaps } : {}
    const { data, hasMore } = slicePage(result.rows, limit)
    const last = hasMore && data.length > 0 ? data[data.length - 1] : null
    const nextCursor = last
      ? encodeCursor(Math.floor(new Date(last.time).getTime() / 1000), pairKey)
      : null

    return {
      pairKey,
      interval,
      network,
      from: from.toISOString(),
      to: to.toISOString(),
      candles: data.map(r => ({
        time: r.time,
        open: formatPrice(r.open),
        high: formatPrice(r.high),
        low: formatPrice(r.low),
        close: formatPrice(r.close),
        volume: formatVolume(r.volume),
      })),
      ...gapDeclaration,
      nextCursor,
      hasMore,
    }
  })
}
