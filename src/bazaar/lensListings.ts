import type { NetworkName } from '../config'
import { assertDeclaration, declareHttpResource, declareMcpTool, param } from './declare'
import type { RegisterBazaarResourceInput } from './types'
import type { DeclaredParam, SellerAccept } from './declare'

/**
 * Lens's own gated endpoints, declared with the seller helpers (#134).
 *
 * Dogfooding, deliberately: `src/middleware/x402.ts` gates `/price`, `/pools`
 * and `/candles`, so these are the first listings in our own Bazaar. If
 * declaring metadata for our own price feed were awkward, it would be awkward
 * for everyone else, and this is where we would find that out.
 *
 * Each declaration goes through `assertDeclaration` at module load, so a listing
 * that would be soft-dropped by the catalog fails the boot instead of silently
 * never appearing in the Bazaar.
 */

/** Shared by every Lens listing: the asset pair in the path. */
const assetPair: Record<string, DeclaredParam> = {
  assetA: param.string(
    'Base asset, as "XLM" for the native asset or "CODE:ISSUER" for a credit asset (e.g. "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN").',
    { example: 'XLM' },
  ),
  assetB: param.string(
    'Quote asset, in the same "XLM" or "CODE:ISSUER" form as assetA. The price returned is assetA denominated in assetB.',
    { example: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
  ),
}

const priceOutput = {
  type: 'object',
  description: 'Aggregated price across SDEX order books and AMM pools, with the best execution route.',
  properties: {
    price: { type: 'string', description: 'Aggregated mid price of assetA in assetB, as a decimal string.' },
    network: { type: 'string', description: 'Stellar network the quote was computed on: "mainnet" or "testnet".' },
    bestRoute: { type: 'array', description: 'Ordered venue hops giving the best execution for this pair.' },
    lastUpdated: { type: 'string', description: 'ISO 8601 timestamp of the most recent underlying observation.' },
  },
} as const

const candlesOutput = {
  type: 'object',
  description: 'OHLCV candles for the pair over the requested window.',
  properties: {
    candles: {
      type: 'array',
      description: 'Candles in ascending time order, each with open, high, low, close, volume and a bucket start time.',
    },
  },
} as const

const poolsOutput = {
  type: 'object',
  description: 'Liquidity pool reserves and spot prices for every AMM pool Lens indexes.',
  properties: {
    pools: {
      type: 'array',
      description: 'One entry per indexed pool, with its reserves, spot price and source protocol.',
    },
  },
} as const

/**
 * Builds the listings for one network and base URL.
 *
 * `accepts` comes from the caller rather than being read from env here, so this
 * stays pure and testable — the payment address is the resource server's to
 * know, not this module's.
 */
export function lensListings(options: {
  baseUrl: string
  network: NetworkName
  accepts: SellerAccept[]
}): RegisterBazaarResourceInput[] {
  const { baseUrl, network, accepts } = options
  const base = baseUrl.replace(/\/+$/, '')
  const common = { network, accepts, serviceName: 'Lens', tags: ['stellar', 'price-feed', 'defi'] }

  const price = declareHttpResource({
    ...common,
    url: `${base}/price/:assetA/:assetB`,
    method: 'GET',
    routeTemplate: '/price/:assetA/:assetB',
    description:
      'Unified Stellar price for an asset pair, aggregated across SDEX order books and AMM pools, with VWAP and the best execution route.',
    pathParams: assetPair,
    output: priceOutput,
  })

  const candles = declareHttpResource({
    ...common,
    url: `${base}/candles/:assetA/:assetB`,
    method: 'GET',
    routeTemplate: '/candles/:assetA/:assetB',
    description: 'OHLCV candle data for a Stellar asset pair, for charting and backtesting.',
    pathParams: assetPair,
    queryParams: {
      interval: param.enumOf(
        ['1m', '5m', '15m', '1h', '4h', '1d'],
        'Candle bucket size. Defaults to "1h" when omitted.',
        { required: false, default: '1h' },
      ),
      from: param.string('Window start, as an ISO 8601 timestamp or a Unix epoch in seconds. Inclusive. Defaults to the earliest candle available.', {
        required: false,
        example: '2026-08-01T00:00:00Z',
      }),
      to: param.string('Window end, as an ISO 8601 timestamp or a Unix epoch in seconds. Exclusive — the window is the half-open interval [from, to), so a candle exactly at `to` is not returned. Defaults to now.', {
        required: false,
        example: '2026-08-31T00:00:00Z',
      }),
    },
    output: candlesOutput,
  })

  const pools = declareHttpResource({
    ...common,
    url: `${base}/pools`,
    method: 'GET',
    description: 'AMM liquidity pool reserves and spot prices across every pool Lens indexes on Stellar.',
    output: poolsOutput,
  })

  const twap = declareHttpResource({
    ...common,
    url: `${base}/price/twap/:assetA/:assetB`,
    method: 'GET',
    routeTemplate: '/price/twap/:assetA/:assetB',
    description: 'Time-weighted average price for a Stellar asset pair, with outlier rejection — the manipulation-resistant reference an on-chain consumer should quote.',
    pathParams: assetPair,
    queryParams: {
      window: param.integer('Averaging window in minutes, 1 to 1440. Defaults to 60.', { required: false, default: 60 }),
      sampleInterval: param.integer('Seconds between samples inside the window, 1 to 3600. Defaults to 60.', { required: false, default: 60 }),
      method: param.enumOf(['iqr', 'modified_zscore'], 'Outlier rejection method applied to samples before averaging. Defaults to "iqr".', {
        required: false,
        default: 'iqr',
      }),
    },
    output: priceOutput,
  })

  return [
    assertDeclaration(price, { pathParams: assetPair, routeTemplate: '/price/:assetA/:assetB' }),
    assertDeclaration(candles, { pathParams: assetPair, queryParams: candlesQueryParams, routeTemplate: '/candles/:assetA/:assetB' }),
    assertDeclaration(pools),
    assertDeclaration(twap, { pathParams: assetPair, queryParams: twapQueryParams, routeTemplate: '/price/twap/:assetA/:assetB' }),
  ]
}

/** Declared once so the same objects can be handed to `assertDeclaration`. */
const candlesQueryParams: Record<string, DeclaredParam> = {
  interval: param.enumOf(['1m', '5m', '15m', '1h', '4h', '1d'], 'Candle bucket size. Defaults to "1h" when omitted.', { required: false, default: '1h' }),
  from: param.string('Window start, as an ISO 8601 timestamp or a Unix epoch in seconds. Inclusive. Defaults to the earliest candle available.', { required: false }),
  to: param.string('Window end, as an ISO 8601 timestamp or a Unix epoch in seconds. Exclusive — the window is the half-open interval [from, to), so a candle exactly at `to` is not returned. Defaults to now.', { required: false }),
}

const twapQueryParams: Record<string, DeclaredParam> = {
  window: param.integer('Averaging window in minutes, 1 to 1440. Defaults to 60.', { required: false, default: 60 }),
  sampleInterval: param.integer('Seconds between samples inside the window, 1 to 3600. Defaults to 60.', { required: false, default: 60 }),
  method: param.enumOf(['iqr', 'modified_zscore'], 'Outlier rejection method applied to samples before averaging. Defaults to "iqr".', { required: false, default: 'iqr' }),
}

/** The MCP face of the same price feed, for agents that speak MCP rather than HTTP. */
export function lensMcpListing(options: { url: string; network: NetworkName; accepts: SellerAccept[] }): RegisterBazaarResourceInput {
  const input: Record<string, DeclaredParam> = {
    assetA: assetPair.assetA,
    assetB: assetPair.assetB,
  }
  const listing = declareMcpTool({
    url: options.url,
    network: options.network,
    accepts: options.accepts,
    serviceName: 'Lens',
    tags: ['stellar', 'price-feed', 'mcp'],
    toolName: 'get_price',
    transport: 'streamable-http',
    description: 'Unified Stellar price for an asset pair, aggregated across SDEX order books and AMM pools.',
    input,
    output: priceOutput as unknown as Record<string, unknown>,
  })
  return assertDeclaration(listing, { input })
}
