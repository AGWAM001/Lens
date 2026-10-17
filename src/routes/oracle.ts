import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { reflectorOracleAdapter } from '../ingest/oracles/reflector'
import { pgPool } from '../db'

const oracleAdapters: OracleAdapter[] = [reflectorOracleAdapter]

function deviationPct(lens: number | null, oracle: number | null): number | null {
  if (lens === null || oracle === null || oracle === 0) return null
  return parseFloat((Math.abs(oracle - lens) / Math.abs(oracle) * 100).toFixed(4))
}

function deviationStatus(deviation: number | null): 'aligned' | 'minor_deviation' | 'major_deviation' | 'partial' {
  if (deviation === null) return 'partial'
  return deviation < 1 ? 'aligned' : deviation < 5 ? 'minor_deviation' : 'major_deviation'
}

export async function registerOracleRoutes(
  app: FastifyInstance,
  adapters: OracleAdapter[] = oracleAdapters
) {
  app.get<{ Params: { asset: string }; Querystring: { network?: NetworkName } }>(
    '/compare/:asset',
    async (req, reply) => {
      const assetCode = req.params.asset.toUpperCase()
      const requestedNetwork = req.query.network
      if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
        return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
      }
      const network: NetworkName = requestedNetwork ?? activeNetwork

      const [dbResult, oracleResults] = await Promise.all([
        pgPool.query(
          `SELECT
             COALESCE(SUM(price::numeric * base_volume::numeric), 0)
               / NULLIF(SUM(base_volume::numeric), 0) AS vwap
           FROM price_points
           WHERE (asset_a = $1 OR asset_b = $1)
             AND network = $2
             AND timestamp > NOW() - INTERVAL '5 minutes'
           GROUP BY pair_key
           LIMIT 1`,
          [assetCode, network]
        ),
        Promise.all(adapters.map(async adapter => {
          if (!adapter.isConfigured(network)) {
            return { name: adapter.name, configured: false as const, quote: null }
          }
          try {
            return { name: adapter.name, configured: true as const, quote: await adapter.getPrice(assetCode, network) }
          } catch {
            // A failed oracle should be visible in the response instead of
            // causing the comparison endpoint to silently omit that source.
            return { name: adapter.name, configured: true as const, quote: null }
          }
        }))
      ])

      const lensPrice = dbResult.rows[0] ? parseFloat(dbResult.rows[0].vwap) : null
      const anyOracleConfigured = oracleResults.some(result => result.configured)
      if (lensPrice === null && !anyOracleConfigured) {
        return reply.status(404).send({ error: `No price data found for asset ${assetCode}` })
      }

      const oracles = oracleResults.map(result => {
        const delta = deviationPct(lensPrice, result.quote?.price ?? null)
        return {
          name: result.name,
          price: result.quote?.price ?? null,
          timestamp: result.quote ? new Date(result.quote.timestamp * 1000).toISOString() : null,
          deviationPct: delta,
          status: !result.configured ? 'not_configured' : result.quote ? 'available' : 'unreachable',
        }
      })
      const reflector = oracleResults.find(result => result.name === 'reflector')
      const reflectorPrice = reflector?.quote?.price ?? null
      const reflectorDeviation = deviationPct(lensPrice, reflectorPrice)

      return {
        asset: assetCode,
        network,
        lens: lensPrice,
        // Keep the original fields while clients migrate to the multi-oracle list.
        reflector: reflectorPrice,
        deviationPct: reflectorDeviation,
        status: deviationStatus(reflectorDeviation),
        fetchedAt: new Date().toISOString(),
        oracles,
      }
    }
  )
}
