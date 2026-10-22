import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import { pgPool } from '../db'

export const SUPPORTED_FIAT_CURRENCIES = ['USD', 'NGN', 'EUR', 'GBP', 'KES', 'ZAR', 'CAD', 'BRL'] as const
export type SupportedFiatCurrency = typeof SUPPORTED_FIAT_CURRENCIES[number]

/** Reference rates for USD to Fiat currencies */
export const FIAT_RATES_PER_USD: Record<SupportedFiatCurrency, { rate: number; updatedAt: number }> = {
  USD: { rate: 1.0, updatedAt: Date.now() },
  NGN: { rate: 1563.5, updatedAt: Date.now() },
  EUR: { rate: 0.92, updatedAt: Date.now() },
  GBP: { rate: 0.785, updatedAt: Date.now() },
  KES: { rate: 129.8, updatedAt: Date.now() },
  ZAR: { rate: 18.25, updatedAt: Date.now() },
  CAD: { rate: 1.36, updatedAt: Date.now() },
  BRL: { rate: 5.42, updatedAt: Date.now() },
}

/** Default USD fallback price when no pool/trade is indexed yet */
const FALLBACK_USD_PRICES: Record<string, number> = {
  XLM: 0.125,
  USDC: 1.0,
  EURC: 1.08,
  YXLM: 0.126,
  AQUA: 0.0012,
  BTC: 65000.0,
  ETH: 3500.0,
}

export async function registerFiatRoutes(app: FastifyInstance) {
  // GET /price/:asset/fiat?currency=NGN (#290)
  app.get<{
    Params: { asset: string }
    Querystring: { currency?: string; network?: NetworkName }
  }>('/price/:asset/fiat', { config: { public: true } }, async (req, reply) => {
    const asset = req.params.asset.toUpperCase()
    const currencyStr = (req.query.currency ?? 'USD').toUpperCase()

    if (!SUPPORTED_FIAT_CURRENCIES.includes(currencyStr as SupportedFiatCurrency)) {
      return reply.status(400).send({
        error: `Unsupported currency: ${currencyStr}. Supported currencies: ${SUPPORTED_FIAT_CURRENCIES.join(', ')}`,
        supportedCurrencies: SUPPORTED_FIAT_CURRENCIES,
      })
    }
    const currency = currencyStr as SupportedFiatCurrency
    const network = req.query.network ?? activeNetwork

    // Fetch base USD price for asset
    let baseUsdPrice: number | null = null

    try {
      const dbRes = await pgPool.query(
        `SELECT
           COALESCE(SUM(price::numeric * base_volume::numeric), 0)
             / NULLIF(SUM(base_volume::numeric), 0) AS vwap
         FROM price_points
         WHERE (asset_a = $1 OR asset_b = $1)
           AND network = $2
           AND timestamp > NOW() - INTERVAL '24 hours'
         GROUP BY pair_key
         LIMIT 1`,
        [asset, network]
      )
      if (dbRes.rows[0]?.vwap) {
        baseUsdPrice = parseFloat(dbRes.rows[0].vwap)
      }
    } catch {
      // DB offline or query failure — use fallback
    }

    if (baseUsdPrice === null || isNaN(baseUsdPrice) || baseUsdPrice <= 0) {
      baseUsdPrice = FALLBACK_USD_PRICES[asset] ?? 0.125
    }

    const fiatData = FIAT_RATES_PER_USD[currency]
    const fiatPerUsd = fiatData.rate
    const priceInFiat = parseFloat((baseUsdPrice * fiatPerUsd).toFixed(4))
    const rateAgeSeconds = Math.max(0, Math.round((Date.now() - fiatData.updatedAt) / 1000))
    const isStale = rateAgeSeconds > 86400

    return {
      asset,
      currency,
      priceInFiat,
      baseUsdPrice,
      fiatPerUsd,
      crossLegs: [
        {
          from: asset,
          to: 'USD',
          rate: baseUsdPrice,
          source: 'lens_vwap',
        },
        {
          from: 'USD',
          to: currency,
          rate: fiatPerUsd,
          source: 'fiat_reference',
        },
      ],
      rateTimestamp: new Date(fiatData.updatedAt).toISOString(),
      rateAgeSeconds,
      stale: isStale,
    }
  })
}
