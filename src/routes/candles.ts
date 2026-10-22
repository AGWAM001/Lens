import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { INTERVAL_SECONDS } from '../candleIntervals'

export async function registerCandleRoutes(app: FastifyInstance) {
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { interval?: string; from?: string; to?: string }
  }>('/candles/:assetA/:assetB', async (req, reply) => {
    const { assetA, assetB } = req.params
    const interval = req.query.interval ?? '1h'
    const intervalSecs = INTERVAL_SECONDS[interval]

    if (!intervalSecs) {
      return reply.status(400).send({
        error: `interval must be one of: ${Object.keys(INTERVAL_SECONDS).join(', ')}`,
      })
    }

    const pairKey = [assetA, assetB].sort().join('/')

    const fromRaw = req.query.from
    const toRaw = req.query.to
    const from = fromRaw ? new Date(fromRaw) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to = toRaw ? new Date(toRaw) : new Date()

    if (isNaN(from.getTime())) {
      return reply.status(400).send({ error: 'from must be a valid ISO 8601 date' })
    }
    if (isNaN(to.getTime())) {
      return reply.status(400).send({ error: 'to must be a valid ISO 8601 date' })
    }

    const result = await pgPool.query(
      `SELECT
         to_timestamp(floor(EXTRACT(EPOCH FROM timestamp) / $1) * $1) AS time,
         (array_agg(price::float ORDER BY timestamp ASC))[1]  AS open,
         MAX(price::float)                                     AS high,
         MIN(price::float)                                     AS low,
         (array_agg(price::float ORDER BY timestamp DESC))[1] AS close,
         SUM(base_volume::float)                              AS volume
       FROM price_points
       WHERE pair_key = $2
         AND timestamp >= $3
         AND timestamp <= $4
       GROUP BY floor(EXTRACT(EPOCH FROM timestamp) / $1)
       ORDER BY time ASC`,
      [intervalSecs, pairKey, from, to]
    )

    return {
      pairKey,
      interval,
      from: from.toISOString(),
      to: to.toISOString(),
      candles: result.rows.map(r => ({
        time: r.time,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      })),
    }
  })
}
