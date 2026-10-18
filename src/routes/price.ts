import type { FastifyInstance } from 'fastify'
import { computeTWAP, computeVWAP } from '../pricing/twap'
import { z } from 'zod'
import { formatValidationError } from '../validation'
import '../middleware/network'
import { activeNetwork, type NetworkName } from '../config'

const TwapQuerySchema = z.object({
  window: z.coerce.number().int().min(1).max(1440).default(60),
  sampleInterval: z.coerce.number().int().min(1).max(3600).default(60),
  method: z.enum(['iqr', 'modified_zscore']).default('iqr'),
  network: z.enum(['testnet', 'mainnet']).optional(),
})

const VwapQuerySchema = z.object({
  window: z.coerce.number().int().min(1).max(1440).default(60),
  source: z.enum(['SDEX', 'AMM']).optional(),
  method: z.enum(['iqr', 'modified_zscore']).default('iqr'),
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
    }
  }>(
    '/price/twap/:assetA/:assetB',
    async (req, reply) => {
      const log = req.log.child({ component: 'route:price' })
      const { assetA, assetB } = req.params
      const parsed = TwapQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send(formatValidationError(parsed.error))
      }
      const { window: windowMinutes, sampleInterval, method } = parsed.data
      const network: NetworkName = req.network ?? parsed.data.network ?? activeNetwork

      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const result = await computeTWAP(pairKey, windowMinutes, {
          sampleIntervalSeconds: sampleInterval,
          outlierMethod: method,
          network,
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
    }
  }>(
    '/price/vwap/:assetA/:assetB',
    async (req, reply) => {
      const log = req.log.child({ component: 'route:price' })
      const { assetA, assetB } = req.params
      const parsed = VwapQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.status(400).send(formatValidationError(parsed.error))
      }
      const { window: windowMinutes, source, method } = parsed.data

      const pairKey = [assetA, assetB].sort().join('/')

      try {
        const result = await computeVWAP(pairKey, windowMinutes, {
          source,
          outlierMethod: method,
        })

        return {
          assetA,
          assetB,
          pairKey,
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