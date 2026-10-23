import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { reflectorOracleAdapter } from '../ingest/oracles/reflector'
import { compareOracles } from '../services/oracleComparison'

const oracleAdapters: OracleAdapter[] = [reflectorOracleAdapter]

export async function registerOracleRoutes(
  app: FastifyInstance,
  adapters: OracleAdapter[] = oracleAdapters
) {
  app.get<{ Params: { asset: string }; Querystring: { network?: NetworkName } }>(
    '/compare/:asset',
    { config: { scope: 'read:prices' } },
    async (req, reply) => {
      const assetCode = req.params.asset.toUpperCase()
      const requestedNetwork = req.query.network
      if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
        return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
      }
      const network: NetworkName = requestedNetwork ?? activeNetwork

      const comparison = await compareOracles(assetCode, network, adapters)
      // CHANGE FROM UPSTREAM (#262): Return 200 with status:"no_data" instead of 404
      // when both Lens and all oracles have no data. The asset code itself is valid,
      // the query succeeded — there is just no data yet. A 404 would imply the asset
      // is invalid or the endpoint does not exist.
      if (!comparison) {
        return {
          asset: assetCode,
          network,
          lens: null,
          reflector: null,
          deviationPct: null,
          status: 'no_data',
          fetchedAt: new Date().toISOString(),
          oracles: [],
        }
      }
      return comparison
    }
  )
}
