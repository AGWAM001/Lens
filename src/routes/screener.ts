import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { activeNetwork } from '../config'
import { formatValidationError, VALIDATION_ERROR_CODE } from '../validation'
import {
  ALLOWED_SORT_FIELDS,
  MARKET_CAP_CODE,
  MARKET_CAP_UNSUPPORTED,
  runScreener,
  ScreenerCursorError,
  SCREENER_DEFAULT_LIMIT,
} from '../services/screener'
import { apiError } from '../errors'
import '../middleware/network' // declares req.network on the FastifyRequest type

// The query execution (filters, sorting, cursor pagination, the liquidity
// definition and the [1, 100] limit clamp) lives in src/services/screener.ts
// and is shared with the GraphQL `screener` query; this route owns only the
// HTTP concerns: query-string validation and error shaping.

const numFilter = (name: string) =>
  z.coerce.number({ error: `${name} must be a valid number` }).optional()

const ScreenerQuerySchema = z
  .object({
    // Historical behavior: limit is clamped to [1, 100] inside runScreener,
    // never rejected. `GET /screener?limit=500` returns 100 rows, `limit=0`
    // behaves as 1.
    limit: z.coerce
      .number({ error: 'limit must be a valid integer' })
      .int({ error: 'limit must be a valid integer' })
      .default(SCREENER_DEFAULT_LIMIT),
    sortBy: z.string().default('volume'),
    order: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.toLowerCase() : v),
        z.enum(['asc', 'desc'])
      )
      .default('desc'),
    volume: numFilter('volume'),
    change_24h_min: numFilter('change_24h_min'),
    change_24h_max: numFilter('change_24h_max'),
    price_min: numFilter('price_min'),
    price_max: numFilter('price_max'),
    liquidity: numFilter('liquidity'),
    cursor: z.string().optional(),
    // market_cap is declared only so the rejection below goes through the
    // shared error formatter like every other rejection.
    market_cap: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.market_cap !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['market_cap'],
        message: MARKET_CAP_UNSUPPORTED,
      })
    }
    if (data.sortBy === 'market_cap') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sortBy'],
        message: MARKET_CAP_UNSUPPORTED,
      })
    } else if (!(ALLOWED_SORT_FIELDS as readonly string[]).includes(data.sortBy)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sortBy'],
        message: `sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(', ')}`,
      })
    }
  })

export async function registerScreenerRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      volume?: string
      change_24h_min?: string
      change_24h_max?: string
      market_cap?: string // rejected with a 400, see MARKET_CAP_UNSUPPORTED
      price_min?: string
      price_max?: string
      liquidity?: string
      sortBy?: string
      order?: string
      cursor?: string
      limit?: string
    }
  }>('/screener', { config: { scope: 'read:prices' } }, async (req, reply) => {
    const log = req.log.child({ component: 'route:screener' })
    try {
      const q = req.query

      const parsed = ScreenerQuerySchema.safeParse(q)
      if (!parsed.success) {
        // market_cap is not a validation error but an unsupported parameter;
        // it keeps its own machine-readable code while using the shared shape.
        const marketCapRejected = parsed.error.issues.some(
          (issue) => issue.path[0] === 'market_cap'
        )
        return reply
          .status(400)
          .send(
            formatValidationError(
              parsed.error,
              marketCapRejected ? MARKET_CAP_CODE : VALIDATION_ERROR_CODE
            )
          )
      }
      const { limit, sortBy, order, cursor } = parsed.data

      return await runScreener({
        network: req.network ?? activeNetwork,
        filters: {
          volume: parsed.data.volume,
          change_24h_min: parsed.data.change_24h_min,
          change_24h_max: parsed.data.change_24h_max,
          price_min: parsed.data.price_min,
          price_max: parsed.data.price_max,
          liquidity: parsed.data.liquidity,
        },
        sortBy,
        order,
        cursor,
        limit,
      })
    } catch (error) {
      // A malformed cursor is the caller's mistake and gets the same 400 body
      // the route has always returned for it.
      if (error instanceof ScreenerCursorError) {
        return reply.status(400).send({ error: error.message, code: error.code })
      }
      log.error({ err: error }, 'screener query failed')
      return reply.status(500).send(apiError('internal_error', 'Internal server error'))
    }
  })
}
