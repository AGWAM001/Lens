import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import {
  COVERAGE_WINDOWS,
  type CoverageWindow,
  WINDOW_HOURS,
  getAssetCoverage,
  getOverallCoverage,
} from '../services/coverage'
import '../middleware/network'

import { apiError } from '../errors'
/**
 * Register the market coverage reporting routes.
 *
 * GET /coverage?window=24h|7d|30d&network=testnet|mainnet
 * GET /coverage/:asset?window=24h|7d|30d&network=testnet|mainnet
 *
 * Compares trading activity indexed by Lens across its configured venues
 * against total on-chain network activity from Stellar Horizon over a requested window.
 *
 * Reports:
 * - A coverage ratio, overall and per asset
 * - Per-venue volume breakdown
 * - Trade coverage ratio (indexed trades / network trades)
 * - Provenance (venues, sample counts, data freshness, last observed timestamp)
 * - Reproducible methodology
 * - Honest answers when unanswerable (zero network activity, gaps, or liquidity absence)
 *   without returning 500 or fake zeros.
 */
export async function registerCoverageRoutes(app: FastifyInstance) {
  // Overall coverage across tracked assets
  app.get<{
    Querystring: { window?: string; network?: string }
  }>('/coverage', { config: { public: true } }, async (req, reply) => {
    const window = (req.query.window ?? '24h') as CoverageWindow
    if (!(window in WINDOW_HOURS)) {
      return reply
        .status(400)
        .send(apiError('bad_window', `window must be one of: ${COVERAGE_WINDOWS.join(', ')}`))
    }

    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
    }
    const network: NetworkName = (requested as NetworkName) ?? (req.network ?? activeNetwork)

    try {
      const result = await getOverallCoverage(window, network)
      return result
    } catch (err) {
      req.log.error({ err }, 'Failed to compute overall coverage')
      return reply
        .status(500)
        .send(apiError('internal_error', `Coverage computation failed: ${(err as Error).message}`))
    }
  })

  // Per-asset coverage
  app.get<{
    Params: { asset: string }
    Querystring: { window?: string; network?: string }
  }>('/coverage/:asset', { config: { public: true } }, async (req, reply) => {
    const { asset } = req.params
    if (!asset || asset.trim() === '') {
      return reply.status(400).send(apiError('missing_parameter', 'Asset parameter is required'))
    }

    const window = (req.query.window ?? '24h') as CoverageWindow
    if (!(window in WINDOW_HOURS)) {
      return reply
        .status(400)
        .send(apiError('bad_window', `window must be one of: ${COVERAGE_WINDOWS.join(', ')}`))
    }

    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
    }
    const network: NetworkName = (requested as NetworkName) ?? (req.network ?? activeNetwork)

    try {
      const result = await getAssetCoverage(asset, window, network)
      return result
    } catch (err) {
      const msg = (err as Error).message || ''
      if (msg.includes('Invalid asset') || msg.includes('must include its issuer')) {
        return reply.status(400).send(apiError('invalid_parameter', msg))
      }
      req.log.error({ asset, err }, 'Failed to compute asset coverage')
      return reply
        .status(500)
        .send(apiError('internal_error', `Asset coverage computation failed: ${msg}`))
    }
  })
}
