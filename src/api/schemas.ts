/**
 * Shared JSON Schema objects for REST response validation.
 *
 * These schemas serve two purposes:
 *   1. They are attached to routes via `{ schema: { response: { 200: ... } } }`,
 *      which lets Fastify auto-generate a correct OpenAPI/Swagger spec and use
 *      fast, schema-aware serialization.
 *   2. In non-production environments they additionally *validate* the outgoing
 *      payload (see `installResponseValidation`), so an accidental change to a
 *      response shape fails loudly in tests instead of shipping silently.
 *
 * NOTE: response validation has no runtime impact in production — it is only
 * installed when NODE_ENV !== 'production'. In production Fastify falls back to
 * its default (fast) serializer for these same schemas.
 */
import Ajv from 'ajv'
import type { FastifyInstance, FastifySchema } from 'fastify'

/**
 * One dependency probe result, shared by `/ready`.
 *
 * `reason` is a fixed phrase rather than the raw error: connection errors carry
 * the host and port, and this is a public endpoint (see src/health.ts).
 */
const dependencyCheckSchema = {
  type: 'object',
  required: ['status', 'latencyMs', 'reason'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['up', 'down', 'skipped'] },
    latencyMs: { type: 'integer' },
    reason: { type: ['string', 'null'] },
  },
} as const

/** GET /live */
export const liveResponseSchema = {
  type: 'object',
  required: ['ok', 'uptimeSeconds'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    uptimeSeconds: { type: 'integer' },
  },
} as const

/** GET /ready — same body on 200 and 503, so `ok` is what distinguishes them. */
export const readyResponseSchema = {
  type: 'object',
  required: ['ok', 'booted', 'checks', 'checkedAt'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    booted: { type: 'boolean' },
    checks: {
      type: 'object',
      required: ['postgres', 'redis'],
      additionalProperties: false,
      properties: {
        postgres: dependencyCheckSchema,
        redis: dependencyCheckSchema,
      },
    },
    checkedAt: { type: 'string' },
  },
} as const

/** GET /status */
export const statusResponseSchema = {
  type: 'object',
  required: ['ok', 'network', 'watchedPairs', 'lastIndexedLedger', 'lastProcessedAt', 'ingestLagSeconds'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    watchedPairs: { type: 'array', items: { type: 'string' } },
    lastIndexedLedger: { type: ['integer', 'null'] },
    // The pg driver returns a timestamp column as a JS Date; the validating
    // serializer sees that pre-serialization object, so accept Date | string |
    // null here (a Date stringifies to an ISO string in the response body).
    lastProcessedAt: {},
    // Seconds since the last ingester write for this network, null before the
    // first one. Lets `/status` reveal a stalled ingester on its own.
    ingestLagSeconds: { type: ['integer', 'null'] },
    // Ingesters that have crashed at least once on this network, newest first,
    // and empty when none have. Present so a crash-looping ingester that keeps
    // restarting is visible here rather than only in the logs. `message` only
    // — never a stack, since this is served over HTTP.
    crashes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'network', 'message', 'at'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          network: { type: 'string', enum: ['testnet', 'mainnet'] },
          message: { type: 'string' },
          at: { type: 'string' },
        },
      },
    },
  },
} as const

/** GET /price/:assetA/:assetB */
export const priceResponseSchema = {
  type: 'object',
  required: [
    'assetA',
    'assetB',
    'pairKey',
    'network',
    'price',
    'sdexPrice',
    'ammPrice',
    'volume24h',
    'sdexVolume24h',
    'ammVolume24h',
    'vwap1m',
    'vwap5m',
    'vwap1h',
    'vwap24h',
    'priceChange24h',
    'sources',
    'confidence',
    'lastTradeAgeSeconds',
    'stale',
    'bestRoute',
    'lastUpdated',
  ],
  additionalProperties: false,
  properties: {
    assetA: { type: 'string' },
    assetB: { type: 'string' },
    pairKey: { type: 'string' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    price: { type: 'number' },
    sdexPrice: { type: 'number' },
    ammPrice: { type: 'number' },
    volume24h: { type: 'number' },
    sdexVolume24h: { type: 'number' },
    ammVolume24h: { type: 'number' },
    vwap1m: { type: 'number' },
    vwap5m: { type: 'number' },
    vwap1h: { type: 'number' },
    vwap24h: { type: 'number' },
    priceChange24h: { type: 'number' },
    sources: { type: 'integer' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
    lastTradeAgeSeconds: { type: ['integer', 'null'] },
    stale: { type: 'boolean' },
    bestRoute: { type: 'string', enum: ['SDEX', 'AMM', 'SPLIT', 'UNKNOWN'] },
    lastUpdated: { type: 'string' },
  },
} as const

/** GET /price/:assetA/:assetB/route — matches RouteInfo */
export const routeResponseSchema = {
  type: 'object',
  required: [
    'route',
    'sdexPrice',
    'ammPrice',
    'estimatedOutput',
    'slippagePct',
    'recommendation',
  ],
  additionalProperties: false,
  properties: {
    route: { type: 'string', enum: ['SDEX', 'AMM', 'SPLIT', 'UNKNOWN'] },
    sdexPrice: { type: 'number' },
    ammPrice: { type: 'number' },
    estimatedOutput: { type: 'number' },
    slippagePct: { type: 'number' },
    recommendation: { type: 'string' },
  },
} as const

/** GET /price/:assetA/:assetB/history */
export const historyResponseSchema = {
  type: 'object',
  required: ['pairKey', 'network', 'window', 'buckets'],
  additionalProperties: false,
  properties: {
    pairKey: { type: 'string' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    window: { type: 'string', enum: ['1m', '5m', '1h', '24h'] },
    buckets: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'bucket',
          'vwap',
          'sdexVwap',
          'ammVwap',
          'volume',
          'tradeCount',
          'open',
          'close',
          'high',
          'low',
        ],
        additionalProperties: false,
        properties: {
          bucket: {},
          vwap: { type: ['number', 'null'] },
          sdexVwap: { type: ['number', 'null'] },
          ammVwap: { type: ['number', 'null'] },
          volume: { type: ['number', 'null'] },
          tradeCount: { type: ['integer', 'null'] },
          open: { type: ['number', 'null'] },
          close: { type: ['number', 'null'] },
          high: { type: ['number', 'null'] },
          low: { type: ['number', 'null'] },
        },
      },
    },
  },
} as const

/**
 * GET /pools
 *
 * Rows come straight from a raw SQL query whose column set may evolve, so the
 * row shape is intentionally permissive (additionalProperties allowed). The
 * envelope, however, is validated.
 */
export const poolsResponseSchema = {
  type: 'object',
  required: ['pools'],
  additionalProperties: false,
  properties: {
    pools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          pool_id: { type: 'string' },
          asset_a: { type: 'string' },
          asset_b: { type: 'string' },
          reserve_a: { type: ['number', 'null'] },
          reserve_b: { type: ['number', 'null'] },
          spot_price: { type: ['number', 'null'] },
          fee_bp: { type: ['integer', 'null'] },
        },
      },
    },
  },
} as const

export const depthResponseSchema = {
  type: 'object',
  required: ['assetA', 'assetB', 'pairKey', 'spotPrice', 'executionPrice', 'slippagePct', 'asks', 'bids', 'source'],
  additionalProperties: false,
  properties: {
    assetA: { type: 'string' },
    assetB: { type: 'string' },
    pairKey: { type: 'string' },
    spotPrice: { type: 'number' },
    executionPrice: { type: 'number' },
    slippagePct: { type: 'number' },
    asks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['price', 'size'],
        additionalProperties: false,
        properties: {
          price: { type: 'number' },
          size: { type: 'number' },
        },
      },
    },
    bids: {
      type: 'array',
      items: {
        type: 'object',
        required: ['price', 'size'],
        additionalProperties: false,
        properties: {
          price: { type: 'number' },
          size: { type: 'number' },
        },
      },
    },
    source: { type: 'string', enum: ['AMM', 'SDEX', 'BOTH'] },
  },
} as const

/** GET /book/:assetA/:assetB */
export const bookResponseSchema = {
  type: 'object',
  required: [
    'assetA', 'assetB', 'pairKey', 'network', 'spotPrice', 'spotSource',
    'depth', 'step', 'status', 'asks', 'bids', 'provenance',
  ],
  additionalProperties: false,
  properties: {
    assetA: { type: 'string' },
    assetB: { type: 'string' },
    pairKey: { type: 'string' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    spotPrice: { type: ['number', 'null'] },
    spotSource: { type: ['string', 'null'], enum: ['SDEX_MID', 'SDEX_ASK', 'SDEX_BID', 'AMM_RESERVES', null] },
    depth: { type: 'number' },
    step: { type: 'number' },
    status: { type: 'string', enum: ['ok', 'partial', 'no_liquidity', 'no_levels_in_range', 'unavailable'] },
    asks: { type: 'array', items: { $ref: '#/definitions/BookLevel' } },
    bids: { type: 'array', items: { $ref: '#/definitions/BookLevel' } },
    provenance: {
      type: 'object',
      required: ['sampledAt', 'sampleCount', 'venues'],
      additionalProperties: false,
      properties: {
        sampledAt: { type: 'string' },
        sampleCount: { type: 'integer' },
        venues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['venue', 'status', 'sampleCount', 'observedAt', 'dataAgeSeconds', 'truncated'],
            additionalProperties: false,
            properties: {
              venue: { type: 'string' },
              status: { type: 'string', enum: ['available', 'no_liquidity', 'unavailable'] },
              sampleCount: { type: 'integer' },
              observedAt: { type: ['string', 'null'] },
              dataAgeSeconds: { type: ['number', 'null'] },
              truncated: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  definitions: {
    BookLevel: {
      type: 'object',
      required: ['price', 'size', 'cumulativeSize', 'venues', 'synthetic', 'sampleCount'],
      additionalProperties: false,
      properties: {
        price: { type: 'number' },
        size: { type: 'number' },
        cumulativeSize: { type: 'number' },
        venues: { type: 'array', items: { type: 'string' } },
        synthetic: { type: 'boolean' },
        sampleCount: { type: 'integer' },
      },
    },
  },
} as const

/** GET /benchmark/:asset */
export const benchmarkResponseSchema = {
  type: 'object',
  required: ['asset', 'target', 'pairKey', 'currentPrice', 'currentDeviationBp', 'rolling24h'],
  additionalProperties: false,
  properties: {
    asset: { type: 'string' },
    target: { type: 'string' },
    pairKey: { type: 'string' },
    currentPrice: { type: ['number', 'null'] },
    currentDeviationBp: { type: ['number', 'null'] },
    rolling24h: {
      type: 'object',
      required: [
        'maxDeviationBp',
        'minDeviationBp',
        'maxAbsoluteDeviationBp',
        'averageDeviationBp',
        'sampleCount',
      ],
      additionalProperties: false,
      properties: {
        maxDeviationBp: { type: ['number', 'null'] },
        minDeviationBp: { type: ['number', 'null'] },
        maxAbsoluteDeviationBp: { type: ['number', 'null'] },
        averageDeviationBp: { type: ['number', 'null'] },
        sampleCount: { type: 'integer' },
      },
    },
  },
} as const

// An asset identifier, shared by the /snapshot sub-objects below. `issuer` is
// null only for the native asset (XLM); every issued asset keeps its issuer,
// since the same code from a different issuer is a different asset.
const assetIdSchema = {
  type: 'object',
  required: ['code', 'issuer'],
  additionalProperties: false,
  properties: {
    code: { type: 'string' },
    issuer: { type: ['string', 'null'] },
  },
} as const

/**
 * GET /snapshot
 *
 * The whole-network summary. `additionalProperties: false` throughout so an
 * accidental new field fails validation in dev/test rather than shipping
 * silently; nullable numbers/strings are explicit, because the endpoint
 * reports "unknown" as null with a reason instead of inventing a value.
 */
export const snapshotResponseSchema = {
  type: 'object',
  required: [
    'network',
    'asOf',
    'generatedAt',
    'window',
    'cache',
    'venues',
    'tvl',
    'volume24h',
    'topPairs',
    'pegs',
    'freshness',
  ],
  additionalProperties: false,
  properties: {
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    asOf: { type: 'string' },
    generatedAt: { type: 'string' },
    window: { type: 'string', enum: ['24h'] },
    cache: {
      type: 'object',
      required: ['ttlSeconds', 'maxAgeSeconds', 'hit', 'storedAt', 'ageSeconds'],
      additionalProperties: false,
      properties: {
        ttlSeconds: { type: 'integer' },
        maxAgeSeconds: { type: 'integer' },
        hit: { type: 'boolean' },
        storedAt: { type: 'string' },
        ageSeconds: { type: ['integer', 'null'] },
      },
    },
    venues: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'name',
          'source',
          'type',
          'enabled',
          'status',
          'samples',
          'samples24h',
          'pairs24h',
          'lastUpdated',
          'ageSeconds',
        ],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          source: { type: 'string' },
          type: { type: 'string', enum: ['orderbook', 'amm', 'unknown'] },
          enabled: { type: ['boolean', 'null'] },
          status: { type: 'string', enum: ['reporting', 'stale', 'silent', 'disabled'] },
          samples: { type: 'integer' },
          samples24h: { type: 'integer' },
          pairs24h: { type: 'integer' },
          lastUpdated: { type: ['string', 'null'] },
          ageSeconds: { type: ['integer', 'null'] },
        },
      },
    },
    tvl: {
      type: 'object',
      required: [
        'note',
        'poolCount',
        'sampleCount',
        'lastUpdated',
        'ageSeconds',
        'stale',
        'byAsset',
        'pools',
      ],
      additionalProperties: false,
      properties: {
        note: { type: 'string' },
        poolCount: { type: 'integer' },
        sampleCount: { type: 'integer' },
        lastUpdated: { type: ['string', 'null'] },
        ageSeconds: { type: ['integer', 'null'] },
        stale: { type: 'boolean' },
        byAsset: {
          type: 'array',
          items: {
            type: 'object',
            required: ['asset', 'amount', 'pools'],
            additionalProperties: false,
            properties: {
              asset: assetIdSchema,
              amount: { type: 'number' },
              pools: { type: 'integer' },
            },
          },
        },
        pools: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'poolId',
              'pairKey',
              'assetA',
              'assetB',
              'reserveA',
              'reserveB',
              'spotPrice',
              'feeBp',
              'lastUpdated',
              'ageSeconds',
            ],
            additionalProperties: false,
            properties: {
              poolId: { type: 'string' },
              pairKey: { type: ['string', 'null'] },
              assetA: assetIdSchema,
              assetB: assetIdSchema,
              reserveA: { type: ['number', 'null'] },
              reserveB: { type: ['number', 'null'] },
              spotPrice: { type: ['number', 'null'] },
              feeBp: { type: ['integer', 'null'] },
              lastUpdated: { type: ['string', 'null'] },
              ageSeconds: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
    volume24h: {
      type: 'object',
      required: ['window', 'sampleCount', 'byVenue', 'total'],
      additionalProperties: false,
      properties: {
        window: { type: 'string', enum: ['24h'] },
        sampleCount: { type: 'integer' },
        byVenue: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'venue',
              'baseVolume',
              'counterVolume',
              'samples',
              'pairs',
              'lastUpdated',
              'ageSeconds',
            ],
            additionalProperties: false,
            properties: {
              venue: { type: 'string' },
              baseVolume: { type: 'number' },
              counterVolume: { type: 'number' },
              samples: { type: 'integer' },
              pairs: { type: 'integer' },
              lastUpdated: { type: ['string', 'null'] },
              ageSeconds: { type: ['integer', 'null'] },
            },
          },
        },
        total: {
          type: 'object',
          required: ['value', 'unit', 'reason'],
          additionalProperties: false,
          properties: {
            value: { type: ['number', 'null'] },
            unit: { ...assetIdSchema, type: ['object', 'null'] },
            reason: { type: ['string', 'null'] },
          },
        },
      },
    },
    topPairs: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'pairKey',
          'configured',
          'assetA',
          'assetB',
          'price',
          'baseVolume24h',
          'counterVolume24h',
          'samples24h',
          'venues',
          'lastUpdated',
          'ageSeconds',
        ],
        additionalProperties: false,
        properties: {
          pairKey: { type: 'string' },
          configured: { type: 'boolean' },
          assetA: { ...assetIdSchema, type: ['object', 'null'] },
          assetB: { ...assetIdSchema, type: ['object', 'null'] },
          price: { type: ['number', 'null'] },
          baseVolume24h: { type: 'number' },
          counterVolume24h: { type: 'number' },
          samples24h: { type: 'integer' },
          venues: { type: 'array', items: { type: 'string' } },
          lastUpdated: { type: ['string', 'null'] },
          ageSeconds: { type: ['integer', 'null'] },
        },
      },
    },
    pegs: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'asset',
          'target',
          'pairKey',
          'quote',
          'price',
          'deviationBp',
          'status',
          'reason',
          'samples24h',
          'lastUpdated',
        ],
        additionalProperties: false,
        properties: {
          asset: assetIdSchema,
          target: { type: 'string' },
          pairKey: { type: 'string' },
          quote: { ...assetIdSchema, type: ['object', 'null'] },
          price: { type: ['number', 'null'] },
          deviationBp: { type: ['number', 'null'] },
          status: {
            type: 'string',
            enum: ['on_peg', 'off_peg', 'no_reference', 'no_data'],
          },
          reason: { type: ['string', 'null'] },
          samples24h: { type: 'integer' },
          lastUpdated: { type: ['string', 'null'] },
        },
      },
    },
    freshness: {
      type: 'object',
      required: [
        'asOf',
        'windowStart',
        'windowEnd',
        'lastUpdated',
        'ageSeconds',
        'staleAfterSeconds',
        'stale',
        'venuesReporting',
        'venuesExpected',
        'venuesSilent',
      ],
      additionalProperties: false,
      properties: {
        asOf: { type: 'string' },
        windowStart: { type: 'string' },
        windowEnd: { type: 'string' },
        lastUpdated: { type: ['string', 'null'] },
        ageSeconds: { type: ['integer', 'null'] },
        staleAfterSeconds: { type: 'integer' },
        stale: { type: 'boolean' },
        venuesReporting: { type: 'integer' },
        venuesExpected: { type: 'integer' },
        venuesSilent: { type: 'integer' },
      },
    },
  },
} as const

/**
 * Install response-shape validation on a Fastify instance.
 *
 * Default Fastify behaviour is to *serialize* against the response schema,
 * silently dropping unknown keys — which means a drifted shape would still
 * return 200. To make accidental shape changes fail loudly we replace the
 * serializer with one that first validates the payload against the schema and
 * throws a 500 (FST_ERR_RESPONSE_SERIALIZATION) when it does not match.
 *
 * Skipped entirely in production so there is no added runtime cost there.
 */
export function installResponseValidation(app: FastifyInstance): void {
  if (process.env.NODE_ENV === 'production') return

  const ajv = new Ajv({ allErrors: true, coerceTypes: false })

  app.setSerializerCompiler(({ schema }: { schema: FastifySchema }) => {
    const validate = ajv.compile(schema as object)
    return (data: unknown) => {
      if (!validate(data)) {
        const detail = ajv.errorsText(validate.errors, { dataVar: 'response' })
        throw new Error(`Response does not match schema: ${detail}`)
      }
      return JSON.stringify(data)
    }
  })
}
