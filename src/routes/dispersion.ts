import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import { queryDispersionHistory } from '../reconciliation/dispersion'
import '../middleware/network'
import { findWatchedPair } from '../utils/watchedPair'

import { apiError } from '../errors'

/** Largest `limit` the routes accept; matches the cap in `queryDispersionHistory`. */
export const DISPERSION_MAX_LIMIT = 500
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

    if (from && to && from.getTime() > to.getTime()) {
      return reply.status(400).send(apiError('invalid_parameter', 'from must not be later than to'))
    }

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50
    if (isNaN(limit) || limit <= 0) {
      return reply.status(400).send(apiError('invalid_parameter', 'limit must be a positive integer'))
    }
    if (limit > DISPERSION_MAX_LIMIT) {
      return reply.status(400).send(apiError('invalid_parameter', `limit must not exceed ${DISPERSION_MAX_LIMIT}`))
    }

    const pair = findWatchedPair(assetA, assetB, network)
    if (!pair) {
      return reply.status(404).send(apiError('unwatched_pair', `Pair ${assetA}/${assetB} not watched on ${network}`))
    }
    const pairKey = pair.pairKey

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

    if (from && to && from.getTime() > to.getTime()) {
      return reply.status(400).send(apiError('invalid_parameter', 'from must not be later than to'))
    }

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50
    if (isNaN(limit) || limit <= 0) {
      return reply.status(400).send(apiError('invalid_parameter', 'limit must be a positive integer'))
    }
    if (limit > DISPERSION_MAX_LIMIT) {
      return reply.status(400).send(apiError('invalid_parameter', `limit must not exceed ${DISPERSION_MAX_LIMIT}`))
    }

    // `pair` is `assetA/assetB`, each a code, `native` or CODE:ISSUER — the same
    // forms the path route takes — resolved to the watched pair's stored key.
    let pairKey: string | undefined
    if (req.query.pair !== undefined) {
      const parts = req.query.pair.split('/')
      const pair = parts.length === 2 && parts[0] && parts[1]
        ? findWatchedPair(parts[0], parts[1], network)
        : undefined
      if (!pair) {
        return reply.status(404).send(apiError('unwatched_pair', `Pair ${req.query.pair} not watched on ${network}`))
      }
      pairKey = pair.pairKey
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
        network,
        pair: pairKey ?? null,
        count: history.length,
        history,
      }
    } catch (err) {
      req.log.error({ err }, 'dispersion query failed')
      return reply.status(500).send(apiError('internal_error', 'Dispersion query failed'))
    }
  })
}
