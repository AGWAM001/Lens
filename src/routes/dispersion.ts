import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import { queryDispersionHistory } from '../reconciliation/dispersion'
import '../middleware/network'

import { apiError } from '../errors'
export async function registerDispersionRoutes(app: FastifyInstance) {
  // GET /dispersion/:assetA/:assetB — query dispersion history and outlier attribution for a pair
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { network?: string; from?: string; to?: string; limit?: string }
  }>('/dispersion/:assetA/:assetB', async (req, reply) => {
    const { assetA, assetB } = req.params

    if (!assetA || !assetB) {
      return reply.status(400).send(apiError('missing_parameter', 'assetA and assetB are required'))
    }

    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
    }
    const network: NetworkName = (requested as NetworkName) ?? req.network ?? activeNetwork

    const pairKey = [assetA, assetB].sort().join('/')

    let from: Date | undefined
    let to: Date | undefined

    if (req.query.from) {
      from = new Date(req.query.from)
      if (isNaN(from.getTime())) {
        return reply.status(400).send(apiError('invalid_parameter', 'from must be a valid ISO 8601 date'))
      }
    }

    if (req.query.to) {
      to = new Date(req.query.to)
      if (isNaN(to.getTime())) {
        return reply.status(400).send(apiError('invalid_parameter', 'to must be a valid ISO 8601 date'))
      }
    }

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50
    if (isNaN(limit) || limit <= 0) {
      return reply.status(400).send(apiError('invalid_parameter', 'limit must be a positive integer'))
    }

    try {
      const history = await queryDispersionHistory({
        pairKey,
        network,
        from,
        to,
        limit,
      })

      return {
        pairKey,
        network,
        latest: history[0] ?? null,
        count: history.length,
        history,
      }
    } catch (err) {
      req.log.error({ err }, 'dispersion query failed')
      return reply.status(500).send(apiError('internal_error', 'Dispersion query failed'))
    }
  })

  // GET /dispersion — list dispersion history across pairs or filtered by pair
  app.get<{
    Querystring: { pair?: string; network?: string; from?: string; to?: string; limit?: string }
  }>('/dispersion', async (req, reply) => {
    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
    }
    const network: NetworkName = (requested as NetworkName) ?? req.network ?? activeNetwork

    let from: Date | undefined
    let to: Date | undefined

    if (req.query.from) {
      from = new Date(req.query.from)
      if (isNaN(from.getTime())) {
        return reply.status(400).send(apiError('invalid_parameter', 'from must be a valid ISO 8601 date'))
      }
    }

    if (req.query.to) {
      to = new Date(req.query.to)
      if (isNaN(to.getTime())) {
        return reply.status(400).send(apiError('invalid_parameter', 'to must be a valid ISO 8601 date'))
      }
    }

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50
    if (isNaN(limit) || limit <= 0) {
      return reply.status(400).send(apiError('invalid_parameter', 'limit must be a positive integer'))
    }

    try {
      const history = await queryDispersionHistory({
        pairKey: req.query.pair,
        network,
        from,
        to,
        limit,
      })

      return {
        network,
        pair: req.query.pair ?? null,
        count: history.length,
        history,
      }
    } catch (err) {
      req.log.error({ err }, 'dispersion query failed')
      return reply.status(500).send(apiError('internal_error', 'Dispersion query failed'))
    }
  })
}
