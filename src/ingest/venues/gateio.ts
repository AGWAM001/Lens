/**
 * Gate.io CEX Venue Adapter
 *
 * Implements CexAdapter and VenueAdapter for Gate.io spot exchange.
 * Fetches XLM and other Stellar asset pair tickers and order books via
 * Gate.io's public v4 spot market data API, normalises pair identifiers
 * to the internal pairKey format, and persists price points to price_points
 * with source = 'Gate.io'.
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

const log = createLogger('ingester:gateio')

export const GATEIO_VENUE_NAME = 'Gate.io'
export const GATEIO_SOURCE_NAME = 'Gate.io'
export const GATEIO_DEFAULT_API_URL = 'https://api.gateio.ws'

export function _resetLastPrice(): void {
  resetLastPrice(GATEIO_VENUE_NAME)
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice(GATEIO_VENUE_NAME, network, pairKey)
}

export interface GateioCredentials {
  apiKey: string
  apiSecret?: string
}

/**
 * Reads Gate.io API credentials from the environment.
 * If GATEIO_API_KEY is missing or empty, logs a warning and returns null
 * without throwing, disabling the adapter cleanly.
 */
export function getGateioCredentials(): GateioCredentials | null {
  const apiKey = process.env.GATEIO_API_KEY
  const apiSecret = process.env.GATEIO_API_SECRET
  if (!apiKey || !apiKey.trim()) {
    log.warn('GATEIO_API_KEY is not configured; skipping Gate.io adapter initialization')
    return null
  }
  return {
    apiKey: apiKey.trim(),
    apiSecret: apiSecret && apiSecret.trim() ? apiSecret.trim() : undefined,
  }
}

export function hasGateioCredentials(): boolean {
  const key = process.env.GATEIO_API_KEY
  return Boolean(key && key.trim())
}

/**
 * Pair Normalisation:
 * Gate.io represents currency pairs using underscores (e.g. "XLM_USDT", "XLM_USDC").
 * Internal Lens pairKey format represents trading pairs as "BASE/QUOTE" uppercase
 * (e.g. "XLM/USDT", "XLM/USDC").
 *
 * This normaliser splits the raw exchange symbol by delimiter ('_', '-', or '/'),
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
 * Converts internal base/quote asset codes into Gate.io's native currency pair format ("BASE_QUOTE").
 */
export function toGateioSymbol(base: string, quote: string): string {
  return `${base.toUpperCase()}_${quote.toUpperCase()}`
}

export interface GateioTickerRecord {
  currency_pair: string
  last?: string
  lowest_ask?: string
  highest_bid?: string
  base_volume?: string
  quote_volume?: string
}

export interface GateioOrderBookResponse {
  id?: number
  current?: number
  update?: number
  bids?: [string, string][]
  asks?: [string, string][]
}

/**
 * Fetches ticker from Gate.io spot tickers endpoint.
 */
export async function fetchGateioTicker(
  base: string,
  quote: string,
  baseUrl: string = GATEIO_DEFAULT_API_URL
): Promise<CexTicker | null> {
  const creds = getGateioCredentials()
  if (!creds) return null

  const symbol = toGateioSymbol(base, quote)
  try {
    const url = `${baseUrl}/api/v4/spot/tickers?currency_pair=${encodeURIComponent(symbol)}`
    const headers: Record<string, string> = {
      KEY: creds.apiKey,
    }

    const res = await fetchWithTimeout(url, { headers })
    if (!res.ok) {
      log.warn({ symbol, status: res.status }, 'Gate.io ticker fetch non-ok')
      return null
    }

    const records = (await res.json()) as GateioTickerRecord[]
    if (!Array.isArray(records) || records.length === 0) {
      return null
    }

    const item = records[0]
    if (!item?.last) {
      return null
    }
    const last = parseFloat(item.last)
    const bid = item.highest_bid ? parseFloat(item.highest_bid) : last
    const ask = item.lowest_ask ? parseFloat(item.lowest_ask) : last
    const baseVolume = item.base_volume ? parseFloat(item.base_volume) : 0
    const quoteVolume = item.quote_volume ? parseFloat(item.quote_volume) : baseVolume * last

    return {
      pair: `${base.toUpperCase()}/${quote.toUpperCase()}`,
      bid,
      ask,
      last,
      baseVolume,
      quoteVolume,
      timestamp: new Date(),
    }
  } catch (err) {
    log.error({ symbol, err }, 'failed to fetch Gate.io ticker')
    return null
  }
}

/**
 * Fetches order book snapshot from Gate.io spot order_book endpoint.
 */
export async function fetchGateioOrderBook(
  base: string,
  quote: string,
  depth: number = 20,
  baseUrl: string = GATEIO_DEFAULT_API_URL
): Promise<CexOrderBook | null> {
  const creds = getGateioCredentials()
  if (!creds) return null

  const symbol = toGateioSymbol(base, quote)
  try {
    const url = `${baseUrl}/api/v4/spot/order_book?currency_pair=${encodeURIComponent(symbol)}&limit=${depth}`
    const headers: Record<string, string> = {
      KEY: creds.apiKey,
    }

    const res = await fetchWithTimeout(url, { headers })
    if (!res.ok) return null

    const json = (await res.json()) as GateioOrderBookResponse
    if (!json) return null

    const bids = (json.bids ?? []).slice(0, depth).map(([p, q]) => ({
      price: parseFloat(p),
      quantity: parseFloat(q),
    }))
    const asks = (json.asks ?? []).slice(0, depth).map(([p, q]) => ({
      price: parseFloat(p),
      quantity: parseFloat(q),
    }))
    const timestamp = json.current ? new Date(json.current) : new Date()

    return {
      pair: `${base.toUpperCase()}/${quote.toUpperCase()}`,
      bids,
      asks,
      timestamp,
    }
  } catch (err) {
    log.error({ symbol, err }, 'failed to fetch Gate.io order book')
    return null
  }
}

export function deriveGateioPricePoints(
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
      source: GATEIO_SOURCE_NAME,
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

export async function ingestGateioPair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return
  const creds = getGateioCredentials()
  if (!creds) return

  const ticker = await fetchGateioTicker(pair.assetA.code, pair.assetB.code)
  if (!ticker) return
  if (signal?.aborted) return

  const points = deriveGateioPricePoints(ticker, pair, network)
  if (points.length === 0) return

  await writeVenuePricePoints(GATEIO_VENUE_NAME, points, pair, network)
}

export interface GateioAdapter extends VenueAdapter<WatchedPair, CexTicker>, Omit<CexAdapter, 'source'> {
  readonly source: string
}

export const gateioAdapter: GateioAdapter = {
  name: GATEIO_VENUE_NAME,
  kind: 'orderbook',
  source: GATEIO_SOURCE_NAME,
  sourceTimeCapability: { status: 'provided', semantic: 'exchange_timestamp' },
  classification: 'primary',
  type: 'Order Book',
  description: 'Gate.io centralized spot exchange',

  isEnabled(_network: NetworkName): boolean {
    return hasGateioCredentials()
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(pair: WatchedPair, _network: NetworkName): Promise<WatchedPair[]> {
    if (!hasGateioCredentials()) return []
    return [pair]
  },

  async read(target: WatchedPair, _pair: WatchedPair, _network: NetworkName): Promise<CexTicker | null> {
    if (!hasGateioCredentials()) return null
    return fetchGateioTicker(target.assetA.code, target.assetB.code)
  },

  derive(raw: CexTicker, _target: WatchedPair, pair: WatchedPair, network: NetworkName): VenuePricePoint[] {
    return deriveGateioPricePoints(raw, pair, network)
  },

  async write(points: VenuePricePoint[], _target: WatchedPair, pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints(GATEIO_VENUE_NAME, points, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void> {
    await ingestGateioPair(pair, network, signal)
  },

  async fetchTicker(base: string, quote: string): Promise<CexTicker | null> {
    return fetchGateioTicker(base, quote)
  },

  async fetchOrderBook(base: string, quote: string, depth?: number): Promise<CexOrderBook | null> {
    return fetchGateioOrderBook(base, quote, depth)
  },

  _resetLastPrice,
  _getLastPrice,
}

// Automatically register in the CEX registry
registerCexAdapter(gateioAdapter)

export async function startGateioIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(gateioAdapter, network)
}
