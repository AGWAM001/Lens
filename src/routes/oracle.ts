import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { reflectorOracleAdapter } from '../ingest/oracles/reflector'
import {
  compareOracles,
  computeOracleSummaryStatistics,
  queryOracleComparisonHistory,
  ORACLE_HISTORY_WINDOWS,
  type OracleHistoryWindow,
} from '../services/oracleComparison'

import { apiError } from '../errors'
const oracleAdapters: OracleAdapter[] = [reflectorOracleAdapter]

interface HistoryQuery {
  network?: string
  oracle?: string
  window?: string
  from?: string
  to?: string
  band?: string
  limit?: string
}

function parseHistoryQueryParams(
  req: FastifyRequest<{ Params: { asset: string }; Querystring: HistoryQuery }>,
  reply: FastifyReply
) {
  const { asset } = req.params
  if (!asset) {
    reply.status(400).send(apiError('missing_parameter', 'Asset parameter is required'))
    return null
  }
  const assetCode = asset.toUpperCase()

  const requestedNetwork = req.query.network
  if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
    reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
    return null
  }
  const network: NetworkName = (requestedNetwork as NetworkName) ?? req.network ?? activeNetwork

  const windowParam = req.query.window
  if (windowParam !== undefined && !(windowParam in ORACLE_HISTORY_WINDOWS)) {
    reply.status(400).send({
      ...apiError('bad_window', `window must be one of: ${Object.keys(ORACLE_HISTORY_WINDOWS).join(', ')}`),
    })
    return null
  }

  let fromDate: Date | undefined
  let toDate: Date | undefined

  if (req.query.from !== undefined) {
    fromDate = new Date(req.query.from)
    if (isNaN(fromDate.getTime())) {
      reply.status(400).send(apiError('invalid_parameter', 'from must be a valid ISO 8601 date'))
      return null
    }
  }
  if (req.query.to !== undefined) {
    toDate = new Date(req.query.to)
    if (isNaN(toDate.getTime())) {
      reply.status(400).send(apiError('invalid_parameter', 'to must be a valid ISO 8601 date'))
      return null
    }
  }

  let from: Date
  let to: Date
  let windowLabel: string | null = null

  if (fromDate !== undefined && toDate !== undefined) {
    if (fromDate.getTime() > toDate.getTime()) {
      reply.status(400).send(apiError('invalid_parameter', 'from must be earlier than to'))
      return null
    }
    from = fromDate
    to = toDate
    windowLabel = windowParam ?? null
  } else if (fromDate !== undefined && toDate === undefined) {
    to = new Date()
    if (fromDate.getTime() > to.getTime()) {
      reply.status(400).send(apiError('invalid_parameter', 'from must be earlier than to'))
      return null
    }
    from = fromDate
    windowLabel = windowParam ?? null
  } else if (fromDate === undefined && toDate !== undefined) {
    const windowKey = (windowParam as OracleHistoryWindow) ?? '24h'
    const durationMs = ORACLE_HISTORY_WINDOWS[windowKey]
    to = toDate
    from = new Date(to.getTime() - durationMs)
    windowLabel = windowKey
  } else {
    const windowKey = (windowParam as OracleHistoryWindow) ?? '24h'
    const durationMs = ORACLE_HISTORY_WINDOWS[windowKey]
    to = new Date()
    from = new Date(to.getTime() - durationMs)
    windowLabel = windowKey
  }

  let bandPct = 1.0
  if (req.query.band !== undefined) {
    const parsedBand = parseFloat(req.query.band)
    if (isNaN(parsedBand) || parsedBand < 0) {
      reply.status(400).send(apiError('invalid_parameter', 'band must be a non-negative number'))
      return null
    }
    bandPct = parsedBand
  }

  let limit = 1000
  if (req.query.limit !== undefined) {
    const parsedLimit = parseInt(req.query.limit, 10)
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 5000) {
      reply.status(400).send(apiError('invalid_parameter', 'limit must be an integer between 1 and 5000'))
      return null
    }
    limit = parsedLimit
  }

  return {
    assetCode,
    network,
    oracle: req.query.oracle,
    from,
    to,
    windowLabel,
    bandPct,
    limit,
  }
}

export async function registerOracleRoutes(
  app: FastifyInstance,
  adapters: OracleAdapter[] = oracleAdapters
) {
  app.get<{ Params: { asset: string }; Querystring: { network?: string } }>(
    '/compare/:asset',
    { config: { scope: 'read:prices' } },
    async (req, reply) => {
      const { asset } = req.params
      if (!asset) {
        return reply.status(400).send(apiError('missing_parameter', 'Asset parameter is required'))
      }
      const assetCode = asset.toUpperCase()
      const requestedNetwork = req.query.network
      if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
        return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
      }
      const network: NetworkName = (requestedNetwork as NetworkName) ?? req.network ?? activeNetwork

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

  app.get<{
    Params: { asset: string }
    Querystring: HistoryQuery
  }>('/compare/:asset/history', { config: { scope: 'read:prices' } }, async (req, reply) => {
    const parsed = parseHistoryQueryParams(req, reply)
    if (!parsed) return

    const { assetCode, network, oracle, from, to, windowLabel, bandPct, limit } = parsed

    const points = await queryOracleComparisonHistory({
      asset: assetCode,
      network,
      oracle,
      from,
      to,
      limit,
    })

    const summary = computeOracleSummaryStatistics(points, bandPct, from, to)
    if (summary.length === 0 && oracle) {
      summary.push({
        oracle,
        meanDeviationPct: null,
        worstDeviationPct: null,
        timeOutsideBandSeconds: null,
        outsideBandSeconds: null,
        outsideBandPct: null,
        bandPct,
        samples: 0,
        venues: [],
        freshestComparison: null,
        oldestComparison: null,
        status: 'insufficient_data',
      })
    }

    return {
      asset: assetCode,
      network,
      window: windowLabel,
      from: from.toISOString(),
      to: to.toISOString(),
      band: bandPct,
      points,
      summary,
    }
  })

  app.get<{
    Params: { asset: string }
    Querystring: HistoryQuery
  }>('/compare/:asset/summary', { config: { scope: 'read:prices' } }, async (req, reply) => {
    const parsed = parseHistoryQueryParams(req, reply)
    if (!parsed) return

    const { assetCode, network, oracle, from, to, windowLabel, bandPct, limit } = parsed

    const points = await queryOracleComparisonHistory({
      asset: assetCode,
      network,
      oracle,
      from,
      to,
      limit,
    })

    const summary = computeOracleSummaryStatistics(points, bandPct, from, to)
    if (summary.length === 0 && oracle) {
      summary.push({
        oracle,
        meanDeviationPct: null,
        worstDeviationPct: null,
        timeOutsideBandSeconds: null,
        outsideBandSeconds: null,
        outsideBandPct: null,
        bandPct,
        samples: 0,
        venues: [],
        freshestComparison: null,
        oldestComparison: null,
        status: 'insufficient_data',
      })
    }

    return {
      asset: assetCode,
      network,
      window: windowLabel,
      from: from.toISOString(),
      to: to.toISOString(),
      band: bandPct,
      summary,
    }
  })
}
