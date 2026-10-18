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
    async (req, reply) => {
      const assetCode = req.params.asset.toUpperCase()
      const requestedNetwork = req.query.network
      if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
        return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
      }
      const network: NetworkName = requestedNetwork ?? activeNetwork

      const comparison = await compareOracles(assetCode, network, adapters)
      if (!comparison) {
        return reply.status(404).send({ error: `No price data found for asset ${assetCode}` })
      }
      return comparison
    }
  )
}
