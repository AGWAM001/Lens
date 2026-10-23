/**
 * Coinbase Exchange CEX Adapter
 *
 * The first concrete CexAdapter, shipped as the pattern every other
 * centralized-exchange adapter (Binance, Kraken, …) should follow. It wraps
 * Coinbase Exchange's public market-data REST endpoints — no API key required.
 *
 * Design contract (issue #215):
 * - fetchTicker / fetchOrderBook normalise the Lens canonical pair ("XLM/USD")
 *   into the exchange's own identifier ("XLM-USD") and back, because the
 *   exchange literally names the pair differently — a slash-form request 404s.
 * - Requests are throttled to Coinbase's published public limit (10 req/s per
 *   IP, bursts up to 15) with a token bucket, and a 429 backs off using the
 *   Retry-After header when present, otherwise exponentially.
 * - Any failure — outage, timeout, non-2xx, malformed body — degrades to a null
 *   return. The adapter never throws, so a dead exchange cannot take down the
 *   process; callers simply get no CEX price for that pair.
 * - Prices carry a distinct `source` ('coinbase_cex') so a CEX number is never
 *   mistaken for, or blended with, an on-chain one.
 *
 * No contract IDs or issuer addresses are involved: this is a pure HTTP market
 * data adapter, so nothing here needs a pasted-on-chain identifier.
 */

import { createLogger } from '../../logger'
import { fetchWithTimeout } from '../../fetch'
import type { NetworkName } from '../../config'
import type { WatchedPair } from '../../types'
import type { VenuePricePoint } from '../venues/types'
import type { CexAdapter, CexOrderBook, CexTicker } from './index'

const log = createLogger('ingest:cex:coinbase')

/** Coinbase Exchange public market-data base URL. */
export const COINBASE_DEFAULT_BASE_URL = 'https://api.exchange.coinbase.com'

/** Coinbase's documented public rate limit: 10 requests/second per IP. */
export const COINBASE_REQUESTS_PER_SECOND = 10
/** Coinbase's documented public burst ceiling: up to 15 requests. */
export const COINBASE_BURST = 15

export interface CoinbaseAdapterOptions {
  /** Override the REST base URL (used by tests / mirrors). */
  baseUrl?: string
  /** Sustained requests-per-second ceiling. Defaults to Coinbase's published 10. */
  requestsPerSecond?: number
  /** Burst capacity. Defaults to Coinbase's published 15. */
  burst?: number
  /** Retry attempts after a 429 or transient failure before degrading to null. */
  maxRetries?: number
  /** Base delay for exponential backoff, in ms. */
  initialBackoffMs?: number
  /** Cap on any single backoff sleep, in ms. */
  maxBackoffMs?: number
  /** Per-request timeout, in ms. */
  timeoutMs?: number
  /** Injectable sleep so tests can drive backoff deterministically. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock for the rate-limit bucket. Defaults to `Date.now`. */
  now?: () => number
  /** Injectable fetch so tests can stub responses. Defaults to fetchWithTimeout. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Minimal token bucket sized to Coinbase's public limit. `acquire()` blocks
 * until a token is available, so callers cannot outrun the endpoint; a 429
 * empties the bucket via `penalize()` to force a cooling period.
 */
export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(
    private readonly perSecond: number,
    private readonly capacity: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = capacity
    this.lastRefill = now()
  }

  private refill(): void {
    const now = this.now()
    const elapsedSec = (now - this.lastRefill) / 1000
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.perSecond)
      this.lastRefill = now
    }
  }

  /** Wait until a request slot is available, then consume it. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.perSecond) * 1000))
      await this.sleep(waitMs)
    }
  }

  /** Empty the bucket after the endpoint pushed back with a 429. */
  penalize(): void {
    this.tokens = 0
  }
}

/**
 * Parse a `Retry-After` header into milliseconds. Coinbase may return either a
 * delay-seconds integer or an HTTP-date; both are handled. Returns null when
 * the header is absent or unparseable so the caller can fall back to its own
 * exponential backoff.
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

/** Canonical Lens pair string, e.g. "XLM/USD" — uppercase, slash-separated. */
export function canonicalPair(base: string, quote: string): string {
  return `${base.trim().toUpperCase()}/${quote.trim().toUpperCase()}`
}

/**
 * Normalise a Lens base/quote into Coinbase's product id ("XLM-USD").
 * The exchange names the pair differently from Lens's canonical "XLM/USD":
 * uppercase, joined by a hyphen. Requesting the slash form returns 404.
 */
export function toCoinbaseProductId(base: string, quote: string): string {
  return `${base.trim().toUpperCase()}-${quote.trim().toUpperCase()}`
}

/**
 * Inverse normalisation: recover a canonical Lens pair from a Coinbase product
 * id. Accepts both the exchange's hyphen form ("XLM-USD") and, defensively, an
 * already-normalised slash form. Returns null when the string has no separator.
 */
export function fromCoinbaseProductId(productId: string): {
  productId: string
  pair: string
  base: string
  quote: string
} | null {
  const raw = productId.trim().toUpperCase()
  const sep = raw.includes('-') ? '-' : raw.includes('/') ? '/' : null
  if (!sep) return null
  const [base, quote] = raw.split(sep)
  if (!base || !quote) return null
  return {
    productId: `${base}-${quote}`,
    pair: `${base}/${quote}`,
    base,
    quote,
  }
}

/** Coinbase ticker response — public market data returns numeric fields as strings. */
interface CoinbaseTickerResponse {
  trade_id?: number
  price?: string
  size?: string
  bid?: string
  ask?: string
  volume?: string
  time?: string
}

/** Coinbase level-2 book response: [price, size, numOrders] rows. */
interface CoinbaseBookResponse {
  bids?: [string, string, (string | number)?][]
  asks?: [string, string, (string | number)?][]
  time?: string
}

export class CoinbaseAdapter implements CexAdapter {
  readonly name = 'Coinbase'
  readonly source = 'coinbase_cex'

  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly timeoutMs: number | undefined
  private readonly sleep: (ms: number) => Promise<void>
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  private readonly bucket: TokenBucket

  constructor(options: CoinbaseAdapterOptions = {}) {
    this.baseUrl =
      options.baseUrl ?? process.env.COINBASE_EXCHANGE_BASE_URL ?? COINBASE_DEFAULT_BASE_URL
    this.maxRetries = options.maxRetries ?? 3
    this.initialBackoffMs = options.initialBackoffMs ?? 500
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000
    this.timeoutMs = options.timeoutMs
    this.sleep = options.sleep ?? defaultSleep

    const requestsPerSecond = options.requestsPerSecond ?? COINBASE_REQUESTS_PER_SECOND
    const burst = options.burst ?? COINBASE_BURST
    this.bucket = new TokenBucket(requestsPerSecond, burst, this.sleep, options.now)

    const injected = options.fetchImpl
    this.fetchImpl =
      injected ??
      ((url, init) => fetchWithTimeout(url, { ...init, timeoutMs: this.timeoutMs }))
  }

  /** Exponential backoff for the given (0-based) retry attempt. */
  private backoffFor(attempt: number): number {
    const backoff = this.initialBackoffMs * Math.pow(2, attempt)
    return Math.min(backoff, this.maxBackoffMs)
  }

  /**
   * GET a JSON document from the exchange, honouring the rate-limit bucket and
   * backing off on 429 / transient failures.
   *
   * Returns null on an unknown pair (404), on exhaustion of retries, or on any
   * thrown error — it never propagates an exception to the caller.
   */
  private async getJson<T>(path: string): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      await this.bucket.acquire()

      let res: Response
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          headers: { 'User-Agent': 'lens-price-api', Accept: 'application/json' },
        })
      } catch (err) {
        // Outage / DNS / timeout / abort — the exchange is unreachable.
        if (attempt >= this.maxRetries) {
          log.warn({ err, path }, 'coinbase unreachable; degrading to no price')
          return null
        }
        await this.sleep(this.backoffFor(attempt))
        continue
      }

      if (res.status === 404) {
        // Product id not listed — an unknown pair, not an error.
        return null
      }

      if (res.status === 429) {
        this.bucket.penalize()
        if (attempt >= this.maxRetries) {
          log.warn({ path }, 'coinbase rate limit persisted after retries; degrading to no price')
          return null
        }
        const retryAfter = parseRetryAfter(safeGetHeader(res, 'retry-after'))
        await this.sleep(retryAfter ?? this.backoffFor(attempt))
        continue
      }

      if (!res.ok) {
        if (attempt >= this.maxRetries) {
          log.warn({ status: res.status, path }, 'coinbase returned an error; degrading to no price')
          return null
        }
        await this.sleep(this.backoffFor(attempt))
        continue
      }

      try {
        return (await res.json()) as T
      } catch (err) {
        if (attempt >= this.maxRetries) {
          log.warn({ err, path }, 'coinbase response was not valid JSON; degrading to no price')
          return null
        }
        await this.sleep(this.backoffFor(attempt))
        continue
      }
    }
  }

  async fetchTicker(base: string, quote: string): Promise<CexTicker | null> {
    const productId = toCoinbaseProductId(base, quote)
    const data = await this.getJson<CoinbaseTickerResponse>(`/products/${productId}/ticker`)
    if (!data) return null

    const last = numOrNaN(data.price)
    const bid = numOrNaN(data.bid)
    const ask = numOrNaN(data.ask)
    // A ticker with no usable trade/bid/ask is not a price — degrade, don't guess.
    if (!Number.isFinite(last) && !Number.isFinite(bid) && !Number.isFinite(ask)) {
      log.debug({ productId }, 'coinbase ticker had no numeric price; degrading to no price')
      return null
    }

    const baseVolume = Number.isFinite(numOrNaN(data.volume)) ? numOrNaN(data.volume) : 0
    // Reference price for deriving quote volume: last trade, else mid, else the
    // single finite side. Guards against NaN leaking into the volume figure.
    const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN
    const ref = Number.isFinite(last)
      ? last
      : Number.isFinite(mid)
        ? mid
        : Number.isFinite(bid)
          ? bid
          : Number.isFinite(ask)
            ? ask
            : NaN
    return {
      pair: canonicalPair(base, quote),
      bid,
      ask,
      last,
      baseVolume,
      // Coinbase reports 24h base volume only; quote volume is derived from it.
      quoteVolume: Number.isFinite(ref) ? baseVolume * ref : 0,
      timestamp: data.time ? new Date(data.time) : new Date(),
    }
  }

  async fetchOrderBook(base: string, quote: string, depth = 20): Promise<CexOrderBook | null> {
    const productId = toCoinbaseProductId(base, quote)
    // level=2 is Coinbase's aggregated price-depth book; `depth` is applied
    // client-side since the endpoint has no level-count parameter.
    const data = await this.getJson<CoinbaseBookResponse>(
      `/products/${productId}/book?level=2`,
    )
    if (!data) return null

    const toLevels = (rows?: [string, string, (string | number)?][]) =>
      (rows ?? [])
        .map((row) => ({ price: Number(row[0]), quantity: Number(row[1]) }))
        .filter((lvl) => Number.isFinite(lvl.price) && Number.isFinite(lvl.quantity))
        .slice(0, depth)

    const bids = toLevels(data.bids)
    const asks = toLevels(data.asks)
    if (bids.length === 0 && asks.length === 0) return null

    return {
      pair: canonicalPair(base, quote),
      bids,
      asks,
      timestamp: data.time ? new Date(data.time) : new Date(),
    }
  }

  /**
   * Convert a ticker into a source-tagged price point. The `source` is this
   * exchange's lineage string ('coinbase_cex') so a caller persisting the row
   * can never confuse it with, or silently blend it into, an on-chain
   * (SDEX/AMM/oracle) number.
   *
   * The Stellar `network` is a required argument — never hard-coded here — and
   * travels on the returned record so the row carries the network it is
   * attributed to. A CEX quote is identical across networks, so the caller
   * (running once per ENABLED_NETWORKS) decides which network owns the write.
   * `ledger` is 0 because an off-chain trade has no Stellar ledger.
   */
  toPricePoint(
    ticker: CexTicker,
    pair: WatchedPair,
    network: NetworkName,
  ): VenuePricePoint & { network: NetworkName } {
    const bid = Number.isFinite(ticker.bid) ? ticker.bid : undefined
    const ask = Number.isFinite(ticker.ask) ? ticker.ask : undefined
    const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined
    const price = mid ?? (Number.isFinite(ticker.last) ? ticker.last : bid ?? 0)

    const parsed = fromCoinbaseProductId(ticker.pair)
    const productId = parsed?.productId ?? toCoinbaseProductId(pair.assetA.code, pair.assetB.code)

    return {
      network,
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      pairKey: pair.pairKey,
      source: this.source,
      poolId: `coinbase:${productId}`,
      price,
      baseVolume: ticker.baseVolume,
      counterVolume: ticker.quoteVolume,
      ledger: 0,
      timestamp: ticker.timestamp,
    }
  }
}

function numOrNaN(value: string | number | undefined): number {
  if (value === undefined || value === null) return NaN
  return Number(value)
}

/** Headers may be absent on stubbed responses; never throw while reading one. */
function safeGetHeader(res: Response, name: string): string | null {
  try {
    return res.headers?.get?.(name) ?? null
  } catch {
    return null
  }
}
