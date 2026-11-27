import type { FastifyInstance } from 'fastify'
import { activeNetwork, type NetworkName } from '../config'
import { parseAssetRef, usdPriceOf } from '../pricing/usdPrice'

import { activeNetwork } from '../config'
import { pgPool } from '../db'
import { apiError } from '../errors'
import { createLogger } from '../logger'

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
  const rateTable = resolveFiatRateTable()

  // GET /price/:asset/fiat?currency=NGN (#290)
  app.get<{
    Params: { asset: string }
    Querystring: { currency?: string }
  }>('/price/:asset/fiat', { config: { public: true } }, async (req, reply) => {
    const asset = req.params.asset.toUpperCase()
    const currencyStr = (req.query.currency ?? 'USD').toUpperCase()

    if (!Object.prototype.hasOwnProperty.call(rateTable.rates, currencyStr)) {
      return reply.status(400).send({
        ...apiError('invalid_parameter', `Unsupported currency: ${currencyStr}. Supported currencies: ${rateTable.currencies.join(', ')}`),
        supportedCurrencies: rateTable.currencies,
        fiatRatesAsOf: rateTable.asOf,
      })
    }
    const network = req.network ?? activeNetwork

    // Fetch base USD price for asset through a configured USD-pegged pair.
    const ref = parseAssetRef(asset) ?? { code: asset }
    let baseUsdPrice: number | null = null

    try {
      const usd = await usdPriceOf(ref, network, 24 * 60)
      if (usd.price !== null) {
        const parsed = parseFloat(usd.price)
        if (!isNaN(parsed) && parsed > 0) baseUsdPrice = parsed
      }
    } catch {
      // DB offline or query failure — use fallback
    }

    if (baseUsdPrice === null || isNaN(baseUsdPrice) || baseUsdPrice <= 0) {
      baseUsdPrice = FALLBACK_USD_PRICES[ref.code.toUpperCase()] ?? 0.125
    }

    const fiatPerUsd = rateTable.rates[currencyStr]
    const priceInFiat = parseFloat((baseUsdPrice * fiatPerUsd).toFixed(4))
    const rateAgeSeconds = Math.max(0, Math.round((Date.now() - rateTable.asOfMs) / 1000))
    const isStale = rateAgeSeconds > FIAT_STALE_THRESHOLD_SECONDS

    return {
      asset,
      currency: currencyStr,
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
