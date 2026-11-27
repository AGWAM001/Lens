import type { FastifyInstance } from 'fastify'
import { activeNetwork } from '../config'
import { pgPool } from '../db'
import { apiError } from '../errors'
import { createLogger } from '../logger'
import { normalizeAssetCode } from './tvl'

const log = createLogger('routes:fiat')

export const SUPPORTED_FIAT_CURRENCIES = ['USD', 'NGN', 'EUR', 'GBP', 'KES', 'ZAR', 'CAD', 'BRL'] as const
export type SupportedFiatCurrency = typeof SUPPORTED_FIAT_CURRENCIES[number]

/** Honest snapshot date for the built-in static USD-to-fiat reference rates. */
export const STATIC_FIAT_RATES_AS_OF = '2026-03-01T00:00:00.000Z'
export const FIAT_STALE_THRESHOLD_SECONDS = 86_400

const DEFAULT_RATES: Record<SupportedFiatCurrency, number> = {
  USD: 1.0,
  NGN: 1563.5, // as of 2026-03-01
  EUR: 0.92,
  GBP: 0.785,
  KES: 129.8,
  ZAR: 18.25,
  CAD: 1.36,
  BRL: 5.42,
}

const STATIC_AS_OF_MS = Date.parse(STATIC_FIAT_RATES_AS_OF)

/** Static reference rates for USD to Fiat currencies, stamped with the table's as-of date. */
export const FIAT_RATES_PER_USD: Record<SupportedFiatCurrency, { rate: number; updatedAt: number }> = {
  USD: { rate: DEFAULT_RATES.USD, updatedAt: STATIC_AS_OF_MS },
  NGN: { rate: DEFAULT_RATES.NGN, updatedAt: STATIC_AS_OF_MS },
  EUR: { rate: DEFAULT_RATES.EUR, updatedAt: STATIC_AS_OF_MS },
  GBP: { rate: DEFAULT_RATES.GBP, updatedAt: STATIC_AS_OF_MS },
  KES: { rate: DEFAULT_RATES.KES, updatedAt: STATIC_AS_OF_MS },
  ZAR: { rate: DEFAULT_RATES.ZAR, updatedAt: STATIC_AS_OF_MS },
  CAD: { rate: DEFAULT_RATES.CAD, updatedAt: STATIC_AS_OF_MS },
  BRL: { rate: DEFAULT_RATES.BRL, updatedAt: STATIC_AS_OF_MS },
}

export interface FiatRateTable {
  asOf: string
  asOfMs: number
  rates: Record<string, number>
  currencies: string[]
}

function builtInRateTable(): FiatRateTable {
  return {
    asOf: STATIC_FIAT_RATES_AS_OF,
    asOfMs: STATIC_AS_OF_MS,
    rates: { ...DEFAULT_RATES },
    currencies: [...SUPPORTED_FIAT_CURRENCIES],
  }
}

/**
 * Loads and validates an operator-supplied `FIAT_RATES_JSON` override (`{ asOf, rates }`).
 * Invalid or absent configuration is never fatal: invalid payloads log a warning and fall back
 * to the built-in static reference table.
 */
export function resolveFiatRateTable(rawJson: string | undefined = process.env.FIAT_RATES_JSON): FiatRateTable {
  if (!rawJson || rawJson.trim() === '') {
    return builtInRateTable()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    log.warn({ err }, 'ignoring invalid FIAT_RATES_JSON: malformed JSON; using built-in static reference rates')
    return builtInRateTable()
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('ignoring invalid FIAT_RATES_JSON: expected a JSON object; using built-in static reference rates')
    return builtInRateTable()
  }

  const candidate = parsed as { asOf?: unknown; rates?: unknown }
  if (typeof candidate.asOf !== 'string') {
    log.warn('ignoring invalid FIAT_RATES_JSON: asOf must be an ISO timestamp string; using built-in static reference rates')
    return builtInRateTable()
  }
  const asOfMs = Date.parse(candidate.asOf)
  if (!Number.isFinite(asOfMs)) {
    log.warn({ asOf: candidate.asOf }, 'ignoring invalid FIAT_RATES_JSON: invalid asOf timestamp; using built-in static reference rates')
    return builtInRateTable()
  }

  if (!candidate.rates || typeof candidate.rates !== 'object' || Array.isArray(candidate.rates)) {
    log.warn('ignoring invalid FIAT_RATES_JSON: rates must be a currency-to-number map; using built-in static reference rates')
    return builtInRateTable()
  }

  const entries = Object.entries(candidate.rates as Record<string, unknown>)
  if (entries.length === 0) {
    log.warn('ignoring invalid FIAT_RATES_JSON: rates map is empty; using built-in static reference rates')
    return builtInRateTable()
  }

  const normalizedRates: Record<string, number> = {}
  for (const [code, value] of entries) {
    const upper = code.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(upper)) {
      log.warn({ currency: code }, 'ignoring invalid FIAT_RATES_JSON: currency codes must be 3 letters; using built-in static reference rates')
      return builtInRateTable()
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      log.warn({ currency: code, value }, 'ignoring invalid FIAT_RATES_JSON: rates must be finite positive numbers; using built-in static reference rates')
      return builtInRateTable()
    }
    normalizedRates[upper] = value
  }

  return {
    asOf: new Date(asOfMs).toISOString(),
    asOfMs,
    rates: normalizedRates,
    currencies: Object.keys(normalizedRates),
  }
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
  const rateTable = resolveFiatRateTable()

  // GET /price/:asset/fiat?currency=NGN (#290)
  app.get<{
    Params: { asset: string }
    Querystring: { currency?: string }
  }>('/price/:asset/fiat', { config: { public: true } }, async (req, reply) => {
    const asset = normalizeAssetCode(req.params.asset)
    const currencyStr = (req.query.currency ?? 'USD').toUpperCase()

    if (!Object.prototype.hasOwnProperty.call(rateTable.rates, currencyStr)) {
      return reply.status(400).send({
        ...apiError('invalid_parameter', `Unsupported currency: ${currencyStr}. Supported currencies: ${rateTable.currencies.join(', ')}`),
        supportedCurrencies: rateTable.currencies,
        fiatRatesAsOf: rateTable.asOf,
      })
    }
    const network = req.network ?? activeNetwork

    // Fetch the asset's dollar price from a named dollar-stablecoin pair.
    let baseUsdPrice: number | null = null
    let usdPair: string | null = null
    let usdSource: string | null = null
    let priceTimestamp: string | null = null

    if (DOLLAR_STABLECOIN_CODES.includes(asset as (typeof DOLLAR_STABLECOIN_CODES)[number])) {
      // The asset is itself a dollar stablecoin: it sits at the peg, the
      // same convention `getAssetUsdPrices` uses. No pair is involved, and
      // the source says exactly that.
      //
      // The peg is a convention, not an observation, so it carries no price
      // timestamp: `priceAgeSeconds` stays null instead of claiming age 0
      // for a price nobody just observed — a depeg must not read as fresh.
      // And because a depeg would be invisible exactly when the price
      // database is down, the peg is only served while the database
      // answers, matching the pair path's 503 below.
      try {
        await pgPool.query('SELECT 1')
      } catch {
        return reply
          .status(503)
          .send(apiError('upstream_unavailable', 'Price database unavailable'))
      }
      baseUsdPrice = 1.0
      usdSource = 'stablecoin_peg'
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
               (CASE WHEN lower(split_part(asset_a, ':', 1)) = 'native' THEN 'XLM' ELSE split_part(asset_a, ':', 1) END = $1 AND split_part(asset_b, ':', 1) = ANY($3))
               OR (CASE WHEN lower(split_part(asset_b, ':', 1)) = 'native' THEN 'XLM' ELSE split_part(asset_b, ':', 1) END = $1 AND split_part(asset_a, ':', 1) = ANY($3))
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
      // `normalizeAssetCode` also resolves backfill rows stored with the
      // asset as 'native' to XLM, matching the SQL normalization above.
      const assetIsBase = normalizeAssetCode(row.asset_a) === asset
      baseUsdPrice = assetIsBase ? vwap : 1.0 / vwap
      usdPair = row.pair_key
      // The source is whatever venue/source the price points actually
      // carry. The fallback names the computation itself — a VWAP over
      // Lens price points — which is where this number did come from.
      usdSource = row.source ?? 'lens_vwap'
      priceTimestamp = row.price_timestamp != null ? new Date(row.price_timestamp).toISOString() : null
    }

    const fiatPerUsd = rateTable.rates[currencyStr]
    const priceInFiat = parseFloat((baseUsdPrice * fiatPerUsd).toFixed(4))
    const rateAgeSeconds = Math.max(0, Math.round((Date.now() - rateTable.asOfMs) / 1000))
    const isStale = rateAgeSeconds > FIAT_STALE_THRESHOLD_SECONDS
    const priceAgeSeconds =
      priceTimestamp != null
        ? Math.max(0, Math.round((Date.now() - new Date(priceTimestamp).getTime()) / 1000))
        : null

    return {
      asset,
      currency: currencyStr,
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
          to: currencyStr,
          rate: fiatPerUsd,
          source: 'static_reference',
          asOf: rateTable.asOf,
        },
      ],
      supportedCurrencies: rateTable.currencies,
      fiatRatesAsOf: rateTable.asOf,
      rateSource: 'static_reference',
      rateTimestamp: rateTable.asOf,
      rateAgeSeconds,
      stale: isStale,
    }
  })
}
