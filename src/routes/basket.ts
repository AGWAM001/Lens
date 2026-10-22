import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pgPool } from '../db'
import { formatValidationError } from '../validation'

async function fetchAssetVWAP(asset: string): Promise<number | null> {
  const result = await pgPool.query(
    `SELECT
       COALESCE(SUM(price::numeric * base_volume::numeric), 0)
       / NULLIF(SUM(base_volume::numeric), 0) AS vwap
     FROM price_points
     WHERE (asset_a = $1 OR asset_b = $1)
       AND timestamp > NOW() - INTERVAL '5 minutes'`,
    [asset.toUpperCase()]
  )
  const vwap = result.rows[0]?.vwap
  if (vwap === null || vwap === undefined) return null
  return parseFloat(vwap)
}

const toArray = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]))

const BasketQuerySchema = z
  .object({
    asset: toArray.optional(),
    weight: toArray.optional(),
  })
  .superRefine((data, ctx) => {
    const assets = data.asset ?? []
    const weightStrings = data.weight ?? []
    if (assets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['asset'],
        message: 'at least one asset is required',
      })
    }
    if (assets.length === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['asset'],
        message: 'basket requires at least 2 assets',
      })
    }
    if (assets.length !== weightStrings.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weight'],
        message: 'number of assets and weights must match',
      })
    }
    const weights = weightStrings.map((w) => parseFloat(w))
    if (weights.some((w) => isNaN(w) || w <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weight'],
        message: 'all weights must be positive numbers',
      })
    }
  })

export async function registerBasketRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { asset?: string | string[]; weight?: string | string[] }
  }>('/basket', { config: { scope: 'read:prices' } }, async (req, reply) => {
    const parsed = BasketQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send(formatValidationError(parsed.error))
    }
    const assets = parsed.data.asset ?? []
    const weightStrings = parsed.data.weight ?? []

    const rawWeightValues = weightStrings.map((w) => parseFloat(w))

    const weightSum = rawWeightValues.reduce((a, b) => a + b, 0)
    const normalizedWeights = rawWeightValues.map((w) => w / weightSum)

    const prices = await Promise.all(assets.map((a) => fetchAssetVWAP(a)))

    const components = assets.map((asset, i) => ({
      asset: asset.toUpperCase(),
      price: prices[i],
      weight: normalizedWeights[i],
    }))

    const missingAssets = components.filter((c) => c.price === null).map((c) => c.asset)
    if (missingAssets.length > 0) {
      // 200 with reason: query was valid but no price data exists (yet).
      // A 404 would imply the assets themselves are invalid/unwatched.
      return {
        error: `No price data found for: ${missingAssets.join(', ')}`,
        reason: 'missing_price_data',
        missingAssets,
        requestedAt: new Date().toISOString(),
      }
    }

    const basketPrice = components.reduce(
      (sum, c) => sum + c.weight * (c.price as number),
      0
    )

    return {
      basketPrice,
      components: components.map((c) => ({
        asset: c.asset,
        price: c.price as number,
        weight: parseFloat(c.weight.toFixed(8)),
        contribution: parseFloat((c.weight * (c.price as number)).toFixed(8)),
      })),
      weightSum: parseFloat(normalizedWeights.reduce((a, b) => a + b, 0).toFixed(8)),
      computedAt: new Date().toISOString(),
    }
  })
}
