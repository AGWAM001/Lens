import type { FastifyInstance } from 'fastify'
import { computeTWAP, computeVWAP } from '../pricing/twap'
import { z } from 'zod'
import { formatValidationError } from '../validation'
import '../middleware/network'
import { activeNetwork, type NetworkName } from '../config'
import { resolveDecimalFormat } from '../utils/decimals'

export const TWAP_WINDOW_MIN_MINUTES = 1
export const TWAP_WINDOW_MAX_MINUTES = 1440
export const TWAP_WINDOW_DEFAULT_MINUTES = 60
export const TWAP_SAMPLE_INTERVAL_MIN_SECONDS = 1
export const TWAP_SAMPLE_INTERVAL_MAX_SECONDS = 3600
export const TWAP_SAMPLE_INTERVAL_DEFAULT_SECONDS = 60

export const VWAP_WINDOW_MIN_MINUTES = 1
export const VWAP_WINDOW_MAX_MINUTES = 1440
export const VWAP_WINDOW_DEFAULT_MINUTES = 60

const TwapQuerySchema = z.object({
  window: z.coerce.number().int().min(TWAP_WINDOW_MIN_MINUTES).max(TWAP_WINDOW_MAX_MINUTES).default(TWAP_WINDOW_DEFAULT_MINUTES),
  sampleInterval: z.coerce.number().int().min(TWAP_SAMPLE_INTERVAL_MIN_SECONDS).max(TWAP_SAMPLE_INTERVAL_MAX_SECONDS).default(TWAP_SAMPLE_INTERVAL_DEFAULT_SECONDS),
  method: z.enum(['iqr', 'modified_zscore']).default('iqr'),
  network: z.enum(['testnet', 'mainnet']).optional(),
  decimals: z.string().optional(),
  decimalFormat: z.string().optional(),
})

const VwapQuerySchema = z.object({
  window: z.coerce.number().int().min(VWAP_WINDOW_MIN_MINUTES).max(VWAP_WINDOW_MAX_MINUTES).default(VWAP_WINDOW_DEFAULT_MINUTES),
  source: z.enum(['SDEX', 'AMM']).optional(),
  method: z.enum(['iqr', 'modified_zscore']).default('iqr'),
  decimals: z.string().optional(),
  decimalFormat: z.string().optional(),
  network: z.enum(['testnet', 'mainnet']).optional(),
})

/**
 * Register manipulation-resistant TWAP/VWAP pricing endpoints.
 *
 * GET /price/twap/:assetA/:assetB?window=60&sampleInterval=60&method=iqr
 * GET /price/vwap/:assetA/:assetB?window=60&source=&method=iqr
 */
export async function registerPriceRoutes(app: FastifyInstance) {
  // ─── TWAP ────────────────────────────────────────────────────────────────────
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: {
      window?: string
      sampleInterval?: string
      method?: 'iqr' | 'modified_zscore'
      network?: string
      decimals?: string
      decimalFormat?: string
    }
  }>(
    '/price/twap/:assetA/:assetB',
    { config: { scope: 'read:prices' } },
    async (req, reply) => {
      const log = req.log.child({ component: 'route:price' })
      const { assetA, assetB } = req.params
      const parsed = TwapQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send(formatValidationError(parsed.error))
      }
      const { window: windowMinutes, sampleInterval, method } = parsed.data
      const network: NetworkName = req.network ?? parsed.data.network ?? activeNetwork
      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const result = await computeTWAP(pairKey, windowMinutes, {
          sampleIntervalSeconds: sampleInterval,
          outlierMethod: method,
          network,
          decimalFormat,
        })

        return {
          assetA,
          assetB,
          pairKey,
          network: result.network,
          twap: result.twap,
          windowMinutes,
          sampleIntervalSeconds: sampleInterval,
          startTime: result.startTime,
          endTime: result.endTime,
          sampleCount: result.sampleCount,
          outlierRejected: result.outlierRejected,
          filterMethod: result.filterMethod,
        }
      } catch (err) {
        // A driver error message can carry the connection string, and so the
        // Postgres credentials. Log it; never put it in the response body.
        log.error({ err }, 'TWAP computation failed')
        return reply.status(500).send({ error: 'TWAP computation failed' })
      }
    }
  )

  // ─── VWAP ────────────────────────────────────────────────────────────────────
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: {
      window?: string
      source?: 'SDEX' | 'AMM'
      method?: 'iqr' | 'modified_zscore'
      decimals?: string
      decimalFormat?: string
      network?: string
    }
  }>(
    '/price/vwap/:assetA/:assetB',
    { config: { scope: 'read:prices' } },
    async (req, reply) => {
      const log = req.log.child({ component: 'route:price' })
      const { assetA, assetB } = req.params
      const parsed = VwapQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send(formatValidationError(parsed.error))
      }
      const { window: windowMinutes, source, method } = parsed.data
      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }
      const network: NetworkName = req.network ?? parsed.data.network ?? activeNetwork

      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const result = await computeVWAP(pairKey, windowMinutes, {
          source,
          outlierMethod: method,
          decimalFormat,
          network,
        })

        return {
          assetA,
          assetB,
          pairKey,
          network: result.network,
          vwap: result.vwap,
          windowMinutes,
          source: source ?? 'all',
          startTime: result.startTime,
          endTime: result.endTime,
          sampleCount: result.sampleCount,
          volumeTotal: result.volumeTotal,
          outlierRejected: result.outlierRejected,
          filterMethod: result.filterMethod,
        }
      } catch (err) {
        // Same as TWAP above: the driver message can contain credentials.
        log.error({ err }, 'VWAP computation failed')
        return reply.status(500).send({ error: 'VWAP computation failed' })
      }
    }
  )
}