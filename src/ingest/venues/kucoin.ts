/**
 * KuCoin CEX Venue Adapter
 *
 * Implements CexAdapter and VenueAdapter for KuCoin spot exchange.
 * Fetches XLM and other Stellar asset pair tickers and order books via
 * KuCoin's public market data API, normalises pair identifiers to the
 * internal pairKey format, and persists price points to price_points with
 * source = 'KuCoin'.
 *
 * Issue: #216
 */

import { config, activeNetwork, type NetworkName } from '../../config'
import { createLogger } from '../../logger'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import type { CexAdapter, CexTicker, CexOrderBook } from '../cex'
import { registerCexAdapter } from '../cex'
import {
  getLastPrice,
  resetLastPrice,
  writeVenuePricePoints,
  startVenueAdapter,
} from './runner'
import { fetchWithTimeout } from '../../fetch'

const log = createLogger('ingester:kucoin')

export const KUCOIN_VENUE_NAME = 'KuCoin'
export const KUCOIN_SOURCE_NAME = 'KuCoin'
export const KUCOIN_DEFAULT_API_URL = 'https://api.kucoin.com'

export function _resetLastPrice(): void {
  resetLastPrice(KUCOIN_VENUE_NAME)
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice(KUCOIN_VENUE_NAME, network, pairKey)
}

export interface KuCoinCredentials {
  apiKey: string
  apiSecret?: string
}

/**
 * Reads KuCoin API credentials from the environment.
 * If KUCOIN_API_KEY is missing or empty, logs a warning and returns null
 * without throwing, disabling the adapter cleanly.
 */
export function getKuCoinCredentials(): KuCoinCredentials | null {
  const apiKey = process.env.KUCOIN_API_KEY
  const apiSecret = process.env.KUCOIN_API_SECRET
  if (!apiKey || !apiKey.trim()) {
    log.warn('KUCOIN_API_KEY is not configured; skipping KuCoin adapter initialization')
    return null
  }
  return {
    apiKey: apiKey.trim(),
    apiSecret: apiSecret && apiSecret.trim() ? apiSecret.trim() : undefined,
  }
}

export function hasKuCoinCredentials(): boolean {
  const key = process.env.KUCOIN_API_KEY
  return Boolean(key && key.trim())
}

/**
 * Pair Normalisation:
 * KuCoin represents trading symbols with hyphens in uppercase (e.g. "XLM-USDT", "XLM-USDC").
 * Internal Lens pairKey format represents trading pairs as "BASE/QUOTE" uppercase
 * (e.g. "XLM/USDT", "XLM/USDC").
 *
 * This normaliser splits the raw exchange symbol by delimiter ('-', '_', or '/'),
 * validates base and quote tokens, and constructs the internal "BASE/QUOTE" pairKey.
 */
export function normalizePair(rawPair: string): string {
  const trimmed = rawPair.trim()
  const parts = trimmed.split(/[-_/]/).filter(Boolean)
  if (parts.length === 2) {
    return `${parts[0].toUpperCase()}/${parts[1].toUpperCase()}`
  }
  return trimmed.toUpperCase()
}

/**
 * Converts internal base/quote asset codes into KuCoin's native symbol format ("BASE-QUOTE").
 */
export function toKuCoinSymbol(base: string, quote: string): string {
  return `${base.toUpperCase()}-${quote.toUpperCase()}`
}

export interface KuCoinTickerResponse {
  code: string
  data?: {
    time?: number
    price?: string
    size?: string
    bestBid?: string
    bestBidSize?: string
    bestAsk?: string
    bestAskSize?: string
  }
}

export interface KuCoinOrderBookResponse {
  code: string
  data?: {
    time?: number
    bids?: [string, string][]
    asks?: [string, string][]
  }
}

/**
 * Fetches the latest ticker from KuCoin Level 1 endpoint.
 */
export async function fetchKuCoinTicker(
  base: string,
  quote: string,
  baseUrl: string = KUCOIN_DEFAULT_API_URL
): Promise<CexTicker | null> {
  const creds = getKuCoinCredentials()
  if (!creds) return null

  const symbol = toKuCoinSymbol(base, quote)
  try {
    const url = `${baseUrl}/api/v1/market/orderbook/level1?symbol=${encodeURIComponent(symbol)}`
    const headers: Record<string, string> = {
      'KC-API-KEY': creds.apiKey,
    }

    const res = await fetchWithTimeout(url, { headers })
    if (!res.ok) {
      log.warn({ symbol, status: res.status }, 'KuCoin ticker fetch non-ok')
      return null
    }

    const json = (await res.json()) as KuCoinTickerResponse
    if (!json.data || !json.data.price) {
      return null
    }

    const last = parseFloat(json.data.price)
    const bid = json.data.bestBid ? parseFloat(json.data.bestBid) : last
    const ask = json.data.bestAsk ? parseFloat(json.data.bestAsk) : last
    const baseVolume = json.data.size ? parseFloat(json.data.size) : 0
    const timestamp = json.data.time ? new Date(json.data.time) : new Date()

    return {
      pair: `${base.toUpperCase()}/${quote.toUpperCase()}`,
      bid,
      ask,
      last,
      baseVolume,
      quoteVolume: baseVolume * last,
      timestamp,
    }
  } catch (err) {
    log.error({ symbol, err }, 'failed to fetch KuCoin ticker')
    return null
  }
}

/**
 * Fetches KuCoin Level 2 orderbook snapshot.
 */
export async function fetchKuCoinOrderBook(
  base: string,
  quote: string,
  depth: number = 20,
  baseUrl: string = KUCOIN_DEFAULT_API_URL
): Promise<CexOrderBook | null> {
  const creds = getKuCoinCredentials()
  if (!creds) return null

  const symbol = toKuCoinSymbol(base, quote)
  try {
    const endpoint = depth <= 20 ? 'level2_20' : 'level2_100'
    const url = `${baseUrl}/api/v1/market/orderbook/${endpoint}?symbol=${encodeURIComponent(symbol)}`
    const headers: Record<string, string> = {
      'KC-API-KEY': creds.apiKey,
    }

    const res = await fetchWithTimeout(url, { headers })
    if (!res.ok) return null

    const json = (await res.json()) as KuCoinOrderBookResponse
    if (!json.data) return null

    const bids = (json.data.bids ?? []).slice(0, depth).map(([p, q]) => ({
      price: parseFloat(p),
      quantity: parseFloat(q),
    }))
    const asks = (json.data.asks ?? []).slice(0, depth).map(([p, q]) => ({
      price: parseFloat(p),
      quantity: parseFloat(q),
    }))
    const timestamp = json.data.time ? new Date(json.data.time) : new Date()

    return {
      pair: `${base.toUpperCase()}/${quote.toUpperCase()}`,
      bids,
      asks,
      timestamp,
    }
  } catch (err) {
    log.error({ symbol, err }, 'failed to fetch KuCoin order book')
    return null
  }
}

export function deriveKuCoinPricePoints(
  ticker: CexTicker,
  pair: WatchedPair,
  network?: NetworkName
): VenuePricePoint[] {
  if (ticker.last <= 0) return []

  const now = new Date()
  return [
    {
      network,
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      pairKey: pair.pairKey,
      source: KUCOIN_SOURCE_NAME,
      price: ticker.last,
      baseVolume: ticker.baseVolume,
      counterVolume: ticker.quoteVolume,
      ledger: 0,
      observedAt: now,
      sourceTime: ticker.timestamp,
      timestamp: ticker.timestamp,
    },
  ]
}

export async function ingestKuCoinPair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return
  const creds = getKuCoinCredentials()
  if (!creds) return

  const ticker = await fetchKuCoinTicker(pair.assetA.code, pair.assetB.code)
  if (!ticker) return
  if (signal?.aborted) return

  const points = deriveKuCoinPricePoints(ticker, pair, network)
  if (points.length === 0) return

  await writeVenuePricePoints(KUCOIN_VENUE_NAME, points, pair, network)
}

export interface KuCoinAdapter extends VenueAdapter<WatchedPair, CexTicker>, Omit<CexAdapter, 'source'> {
  readonly source: string
}

export const kucoinAdapter: KuCoinAdapter = {
  name: KUCOIN_VENUE_NAME,
  kind: 'orderbook',
  source: KUCOIN_SOURCE_NAME,
  sourceTimeCapability: { status: 'provided', semantic: 'exchange_timestamp' },
  classification: 'primary',
  type: 'Order Book',
  description: 'KuCoin centralized spot exchange',

  isEnabled(_network: NetworkName): boolean {
    return hasKuCoinCredentials()
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(pair: WatchedPair, _network: NetworkName): Promise<WatchedPair[]> {
    if (!hasKuCoinCredentials()) return []
    return [pair]
  },

  async read(target: WatchedPair, _pair: WatchedPair, _network: NetworkName): Promise<CexTicker | null> {
    if (!hasKuCoinCredentials()) return null
    return fetchKuCoinTicker(target.assetA.code, target.assetB.code)
  },

  derive(raw: CexTicker, _target: WatchedPair, pair: WatchedPair, network: NetworkName): VenuePricePoint[] {
    return deriveKuCoinPricePoints(raw, pair, network)
  },

  async write(points: VenuePricePoint[], _target: WatchedPair, pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints(KUCOIN_VENUE_NAME, points, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void> {
    await ingestKuCoinPair(pair, network, signal)
  },

  async fetchTicker(base: string, quote: string): Promise<CexTicker | null> {
    return fetchKuCoinTicker(base, quote)
  },

  async fetchOrderBook(base: string, quote: string, depth?: number): Promise<CexOrderBook | null> {
    return fetchKuCoinOrderBook(base, quote, depth)
  },

  _resetLastPrice,
  _getLastPrice,
}

// Automatically register in the CEX registry
registerCexAdapter(kucoinAdapter)

export async function startKuCoinIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(kucoinAdapter, network)
}
