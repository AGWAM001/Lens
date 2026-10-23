import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { getActivePairs } from '../pairsRegistry'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { benchmarkResponseSchema } from '../api/schemas'
import { sendInternalError } from '../errors'

function findPair(assetCode: string, targetCode: string) {
  const normalize = (c: string) => c.toLowerCase() === 'native' ? 'XLM' : c.split(':')[0].toUpperCase()
  const normAsset = normalize(assetCode)
  const normTarget = normalize(targetCode)
  return getActivePairs().find(p => {
    const pA = p.assetA.code.toUpperCase()
    const pB = p.assetB.code.toUpperCase()
    return (normAsset === pA && normTarget === pB) || (normAsset === pB && normTarget === pA)
  })
}

export async function registerBenchmarkRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { target?: string }
  }>(
    '/benchmark/:asset',
    { config: { scope: 'read:prices' }, schema: { response: { 200: benchmarkResponseSchema } } },
    async (req, reply) => {
      const { asset } = req.params
      const target = req.query.target ?? 'USD'

      const normalize = (c: string) => c.toLowerCase() === 'native' ? 'XLM' : c.split(':')[0].toUpperCase()
      const normAsset = normalize(asset)
      const normTarget = normalize(target)

      const pair = findPair(asset, target)
      if (!pair) {
        return reply.status(404).send({ error: `Pair ${asset}/${target} not watched` })
      }

      const isAssetA = pair.assetA.code.toUpperCase() === normAsset
      const priceExpr = isAssetA ? 'price::numeric' : '1.0 / NULLIF(price::numeric, 0)'

      // Query latest price (overall) and rolling 24h stats.
      //
      // `network` is not optional here: `price_points` indexes `network` as the
      // leading column of (network, pair_key, timestamp), and the same pair key
      // exists on both chains — an unfiltered read blends two separate markets
      // into a deviation figure nobody traded at.
      const network: NetworkName = req.network ?? activeNetwork
      const query = `
        SELECT
          (SELECT ${priceExpr} FROM price_points WHERE pair_key = $1 AND network = $2 ORDER BY timestamp DESC LIMIT 1) AS latest_price,
          MAX(${priceExpr}) AS max_price,
          MIN(${priceExpr}) AS min_price,
          AVG(${priceExpr}) AS avg_price,
          MAX(ABS(${priceExpr} - 1.0)) * 10000 AS max_abs_deviation_bps,
          MAX(${priceExpr} - 1.0) * 10000 AS max_deviation_bps,
          MIN(${priceExpr} - 1.0) * 10000 AS min_deviation_bps,
          COUNT(*) AS sample_count
        FROM price_points
        WHERE pair_key = $1
          AND network = $2
          AND timestamp > NOW() - INTERVAL '24 hours'
      `

      try {
        const result = await pgPool.query(query, [pair.pairKey, network])
        const row = result.rows[0]

        const latestPriceRaw = row?.latest_price
        const latestPrice = latestPriceRaw !== null && latestPriceRaw !== undefined ? parseFloat(latestPriceRaw) : null
        const currentDeviationBp = latestPrice !== null ? (latestPrice - 1.0) * 10000 : null

        const sampleCount = row?.sample_count ? parseInt(row.sample_count, 10) : 0

        const hasStats = sampleCount > 0
        const rolling24h = {
          maxDeviationBp: hasStats && row?.max_deviation_bps !== null ? parseFloat(row.max_deviation_bps) : null,
          minDeviationBp: hasStats && row?.min_deviation_bps !== null ? parseFloat(row.min_deviation_bps) : null,
          maxAbsoluteDeviationBp: hasStats && row?.max_abs_deviation_bps !== null ? parseFloat(row.max_abs_deviation_bps) : null,
          averageDeviationBp: hasStats && row?.avg_price !== null ? (parseFloat(row.avg_price) - 1.0) * 10000 : null,
          sampleCount,
        }

        return {
          asset: pair.assetA.code.toUpperCase() === normAsset ? pair.assetA.code : pair.assetB.code,
          target: pair.assetA.code.toUpperCase() === normTarget ? pair.assetA.code : pair.assetB.code,
          pairKey: pair.pairKey,
          currentPrice: latestPrice,
          currentDeviationBp,
          rolling24h,
        }
      } catch (err) {
        return sendInternalError(reply, req, err, 'Benchmark computation failed')
      }
    }
  )
}
