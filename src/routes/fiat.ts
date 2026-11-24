import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import { pgPool } from '../db'

import { apiError } from '../errors'
import { normalizeAssetCode } from './tvl'
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

/**
 * Asset codes that count as one US dollar for the dollar leg.
 *
 * This mirrors `getAssetUsdPrices` in `src/routes/tvl.ts`: an asset is priced
 * in dollars only from a pair against one of these, in whichever direction
 * the pair is quoted, and USDC/USD themselves sit at the peg. There is no
 * hard-coded price table: an asset with no such pair has no dollar price,
 * and this route says so instead of inventing one.
 */
export const DOLLAR_STABLECOIN_CODES = ['USDC', 'USD'] as const

interface DollarPairRow {
  pair_key: string
  asset_a: string
  asset_b: string
  source: string | null
  vwap: string | null
  price_timestamp: Date | string | null
}

export async function registerFiatRoutes(app: FastifyInstance) {
  // GET /price/:asset/fiat?currency=NGN (#290)
  app.get<{
    Params: { asset: string }
    Querystring: { currency?: string; network?: NetworkName }
  }>('/price/:asset/fiat', { config: { public: true } }, async (req, reply) => {
    const asset = normalizeAssetCode(req.params.asset)
    const currencyStr = (req.query.currency ?? 'USD').toUpperCase()

    if (!SUPPORTED_FIAT_CURRENCIES.includes(currencyStr as SupportedFiatCurrency)) {
      return reply.status(400).send({
        ...apiError('invalid_parameter', `Unsupported currency: ${currencyStr}. Supported currencies: ${SUPPORTED_FIAT_CURRENCIES.join(', ')}`),
        supportedCurrencies: SUPPORTED_FIAT_CURRENCIES,
      })
    }
    const currency = currencyStr as SupportedFiatCurrency
    const network = req.query.network ?? activeNetwork

    // Fetch the asset's dollar price from a named dollar-stablecoin pair.
    let baseUsdPrice: number | null = null
    let usdPair: string | null = null
    let usdSource: string | null = null
    let priceTimestamp: string | null = null

    if (DOLLAR_STABLECOIN_CODES.includes(asset as (typeof DOLLAR_STABLECOIN_CODES)[number])) {
      // The asset is itself a dollar stablecoin: it sits at the peg, the
      // same convention `getAssetUsdPrices` uses. No pair is involved, and
      // the source says exactly that.
      baseUsdPrice = 1.0
      usdSource = 'stablecoin_peg'
      priceTimestamp = new Date().toISOString()
    } else {
      let row: DollarPairRow | undefined
      try {
        const dbRes = await pgPool.query(
          `SELECT
             pair_key,
             asset_a,
             asset_b,
             source,
             COALESCE(SUM(price::numeric * base_volume::numeric), 0)
               / NULLIF(SUM(base_volume::numeric), 0) AS vwap,
             MAX(timestamp) AS price_timestamp
           FROM price_points
           WHERE network = $2
             AND timestamp > NOW() - INTERVAL '24 hours'
             AND (
               (split_part(asset_a, ':', 1) = $1 AND split_part(asset_b, ':', 1) = ANY($3))
               OR (split_part(asset_b, ':', 1) = $1 AND split_part(asset_a, ':', 1) = ANY($3))
             )
           GROUP BY pair_key, asset_a, asset_b, source
           ORDER BY SUM(base_volume::numeric) DESC NULLS LAST
           LIMIT 1`,
          [asset, network, [...DOLLAR_STABLECOIN_CODES]]
        )
        row = dbRes.rows[0] as DollarPairRow | undefined
      } catch {
        // The database failed: that is an upstream problem, not a missing
        // price, and it must never be papered over with an invented number.
        return reply
          .status(503)
          .send(apiError('upstream_unavailable', 'Price database unavailable'))
      }

      const vwap = row?.vwap != null ? parseFloat(row.vwap) : NaN
      if (!row || !Number.isFinite(vwap) || vwap <= 0) {
        return reply
          .status(404)
          .send(apiError('unknown_pair', `No dollar price available for ${asset}: no watched pair against ${DOLLAR_STABLECOIN_CODES.join(' or ')}`))
      }

      // `price` in price_points is the price of asset_a in terms of asset_b.
      // If the asset is asset_a, the VWAP already is its dollar price; if the
      // asset is the quote side (asset_b), the dollar price is its inverse.
      const assetIsBase = normalizeAssetCode(row.asset_a) === asset
      baseUsdPrice = assetIsBase ? vwap : 1.0 / vwap
      usdPair = row.pair_key
      // The source is whatever venue/source the price points actually
      // carry. The fallback names the computation itself — a VWAP over
      // Lens price points — which is where this number did come from.
      usdSource = row.source ?? 'lens_vwap'
      priceTimestamp = row.price_timestamp != null ? new Date(row.price_timestamp).toISOString() : null
    }

    const fiatData = FIAT_RATES_PER_USD[currency]
    const fiatPerUsd = fiatData.rate
    const priceInFiat = parseFloat((baseUsdPrice * fiatPerUsd).toFixed(4))
    const rateAgeSeconds = Math.max(0, Math.round((Date.now() - fiatData.updatedAt) / 1000))
    const isStale = rateAgeSeconds > 86400
    const priceAgeSeconds =
      priceTimestamp != null
        ? Math.max(0, Math.round((Date.now() - new Date(priceTimestamp).getTime()) / 1000))
        : null

    return {
      asset,
      currency,
      priceInFiat,
      baseUsdPrice,
      fiatPerUsd,
      pair: usdPair,
      priceTimestamp,
      priceAgeSeconds,
      crossLegs: [
        {
          from: asset,
          to: 'USD',
          rate: baseUsdPrice,
          source: usdSource,
          pair: usdPair,
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
