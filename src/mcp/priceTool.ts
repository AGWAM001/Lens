import { MCP_ERROR_CODES } from './codes.js'
import type { McpErrorCode } from './codes.js'
import type { AssetId, RouteInfo, WatchedPair } from '../types.js'
import type { NetworkName } from '../config.js'

/**
 * #408 — the MCP server was a client for other people's Bazaar nodes and had no
 * way to answer the one question Lens exists to answer. Everything below is the
 * pure half of that tool: argument parsing, pair resolution, and the shape of
 * the answer. The data access lives in ./priceQueries.ts and reaches this
 * module only through `LensPriceQueries`, so the tool can be exercised without
 * a database and cannot accidentally grow its own price maths.
 */

export const LENS_PRICE_TOOL_NAME = 'lens_get_price'

/** What `getAggregatedPrice` returns; mirrored here to keep this module data-layer-free. */
export interface AggregatedPriceFields {
  price: number
  sdexPrice: number
  ammPrice: number
  volume24h: number
  sdexVolume24h: number
  ammVolume24h: number
  vwap1m: number
  vwap5m: number
  vwap1h: number
  vwap24h: number
  priceChange24h: number
  sources: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  lastTradeAgeSeconds: number | null
  stale: boolean
}

/** The three reads `lens_get_price` needs, supplied by the process that hosts the tool. */
export interface LensPriceQueries {
  /** Network the caller gets when they name none — the deployment's own default. */
  readonly activeNetwork: NetworkName
  /** Pairs watched on that network, issuers intact. */
  watchedPairs(network: NetworkName): readonly WatchedPair[]
  aggregatedPrice(pairKey: string, network: NetworkName): Promise<AggregatedPriceFields>
  bestRoute(assetA: AssetId, assetB: AssetId, pairKey: string, network: NetworkName): Promise<RouteInfo>
}

/** An asset as the caller wrote it, after shape validation. */
export interface AssetRef {
  code: string
  issuer: string | null
}

/**
 * A type alias rather than an interface, so it carries an implicit index
 * signature and satisfies the MCP `structuredContent` record type.
 */
export type LensPriceResult = {
  network: NetworkName
  pairKey: string
  /** The watched pair's base side, with the issuer that actually defines it. */
  base: AssetRef
  /** The watched pair's quote side. `price` is units of this per one unit of base. */
  quote: AssetRef
  /** Whether the pair was matched in the order asked, or the other way round. */
  direction: 'as-requested' | 'reversed'
  /** Constant, so the number cannot be read backwards by an agent that ignores base/quote. */
  orientation: 'quote-per-base'
  price: number
  sources: number
  confidence: AggregatedPriceFields['confidence']
  lastTradeAgeSeconds: number | null
  stale: boolean
  vwap1m: number
  vwap5m: number
  vwap1h: number
  vwap24h: number
  priceChange24h: number
  volume24h: number
  sdexPrice: number
  ammPrice: number
  sdexVolume24h: number
  ammVolume24h: number
  bestRoute: RouteInfo | null
  lastUpdated: string
}

export type PriceToolFailure = { code: McpErrorCode; reason: string }
export type PriceToolOutcome =
  | { ok: true; result: LensPriceResult }
  | { ok: false; error: PriceToolFailure }

const VALID_NETWORKS: readonly NetworkName[] = ['testnet', 'mainnet']

/**
 * `native`, or an uppercase alphanumeric code with an optional full strkey
 * issuer. Codes are matched case-sensitively because that is how Stellar stores
 * them — "usdc" and "USDC" are different strings on the ledger — so a lowercase
 * code is refused rather than quietly folded.
 */
const ASSET_PATTERN = '^(?:native|[A-Z][A-Z0-9]{0,11}(?::G[A-Z2-7]{55})?)$'
const ASSET_RE = new RegExp(ASSET_PATTERN)
const ISSUER_RE = /^G[A-Z2-7]{55}$/

/** How many pair keys an unknown-pair refusal lists back to the caller. */
const PAIR_HINT_LIMIT = 20

export const lensPriceToolDefinition = () => ({
  name: LENS_PRICE_TOOL_NAME,
  description:
    'Aggregated Lens price for one watched asset pair on one Stellar network: volume-weighted price ' +
    'across SDEX and AMM venues, with the venue split, source count, confidence, the age of the last ' +
    'trade and the best route for a 1000-unit order. Read-only — it spends nothing and needs no ' +
    'allow-listed host, so use this instead of paid_call whenever the question is "what is the price". ' +
    'Assets are CODE or CODE:ISSUER (use "native" or "XLM" for lumens). Always give the issuer for a ' +
    'token: asset codes are not unique on Stellar, anyone can issue "USDC", and a bare code matches ' +
    'whichever pair of that code this network watches. If the code is watched under a different ' +
    'issuer this tool answers ERR_ASSET_ISSUER_MISMATCH naming the issuer it does watch — it never ' +
    'prices a same-named asset. The result states which pair matched (base/quote with issuers) and the ' +
    'orientation: price is units of quote per one base. ' +
    'Network is "testnet" or "mainnet", defaulting to the network this server runs. ' +
    'A price is only returned when the pair has data: confidence is high under 30s of last-trade age, ' +
    'medium under 300s, low at or beyond 300s (stale: true), and unknown when nothing has been ' +
    'ingested; check lastTradeAgeSeconds and stale before treating a price as current. Refusals are ' +
    'deterministic: ERR_INVALID_ASSET, ERR_PAIR_NOT_WATCHED, ERR_ASSET_ISSUER_MISMATCH, ' +
    'ERR_NO_RESULTS. Report those rather than retrying — a refused pair is not a transient failure.',
  inputSchema: {
    type: 'object',
    properties: {
      assetA: {
        type: 'string',
        description: 'First asset: CODE, CODE:ISSUER, or "native" for lumens. Codes are uppercase.',
        pattern: ASSET_PATTERN,
        examples: ['XLM', 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'],
      },
      assetB: {
        type: 'string',
        description: 'Second asset, same form as assetA. Order does not matter; the pair is matched both ways.',
        pattern: ASSET_PATTERN,
        examples: ['USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'],
      },
      network: {
        type: 'string',
        enum: [...VALID_NETWORKS],
        description: 'Stellar network to quote. Defaults to the network this server is configured for.',
      },
    },
    required: ['assetA', 'assetB'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      network: { type: 'string', enum: [...VALID_NETWORKS] },
      pairKey: { type: 'string' },
      base: codeIssuerSchema(),
      quote: codeIssuerSchema(),
      direction: { type: 'string', enum: ['as-requested', 'reversed'] },
      orientation: { type: 'string', enum: ['quote-per-base'] },
      price: { type: 'number' },
      sources: { type: 'integer' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
      lastTradeAgeSeconds: { type: ['number', 'null'] },
      stale: { type: 'boolean' },
      vwap1m: { type: 'number' },
      vwap5m: { type: 'number' },
      vwap1h: { type: 'number' },
      vwap24h: { type: 'number' },
      priceChange24h: { type: 'number' },
      volume24h: { type: 'number' },
      sdexPrice: { type: 'number' },
      ammPrice: { type: 'number' },
      sdexVolume24h: { type: 'number' },
      ammVolume24h: { type: 'number' },
      bestRoute: {
        description: 'Best route for a 1000-unit order, or null when no venue could price the pair.',
        anyOf: [routeSchema(), { type: 'null' }],
      },
      lastUpdated: { type: 'string' },
    },
    required: [
      'network', 'pairKey', 'base', 'quote', 'direction', 'orientation', 'price', 'sources',
      'confidence', 'lastTradeAgeSeconds', 'stale', 'vwap1m', 'vwap5m', 'vwap1h', 'vwap24h',
      'priceChange24h', 'volume24h', 'sdexPrice', 'ammPrice', 'sdexVolume24h', 'ammVolume24h',
      'bestRoute', 'lastUpdated',
    ],
    additionalProperties: false,
  },
})

function codeIssuerSchema() {
  return {
    type: 'object',
    properties: {
      code: { type: 'string' },
      issuer: { type: ['string', 'null'] },
    },
    required: ['code', 'issuer'],
    additionalProperties: false,
  }
}

function routeSchema() {
  return {
    type: 'object',
    properties: {
      route: { type: 'string', enum: ['SDEX', 'AMM', 'SPLIT', 'UNKNOWN'] },
      sdexPrice: { type: 'number' },
      ammPrice: { type: 'number' },
      estimatedOutput: { type: 'number' },
      slippagePct: { type: 'number' },
      recommendation: { type: 'string' },
    },
    required: ['route', 'sdexPrice', 'ammPrice', 'estimatedOutput', 'slippagePct', 'recommendation'],
    additionalProperties: false,
  }
}

/**
 * Validate one asset argument. `native` is accepted in any case because it names
 * lumens and cannot be reissued by anyone; everything else must match the
 * declared shape exactly, since folding case or padding an issuer is how a
 * request ends up priced about the wrong asset.
 */
export function parseAssetRef(raw: unknown, field: string): { asset: AssetRef } | PriceToolFailure {
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      code: MCP_ERROR_CODES.ERR_INVALID_ASSET,
      reason: `${field} must be a non-empty string: CODE, CODE:ISSUER, or "native"`,
    }
  }

  if (raw.toLowerCase() === 'native') return { asset: { code: 'XLM', issuer: null } }

  if (!ASSET_RE.test(raw)) {
    const issuer = raw.split(':')[1]
    if (raw !== raw.toUpperCase() && ASSET_RE.test(raw.toUpperCase())) {
      return {
        code: MCP_ERROR_CODES.ERR_INVALID_ASSET,
        reason:
          `${field}="${raw}" is not accepted: Stellar asset codes are case-sensitive, so a lowercase ` +
          `code is a different asset. Resend it uppercase ("${raw.toUpperCase()}") if that is the code you mean.`,
      }
    }
    if (issuer !== undefined && !ISSUER_RE.test(issuer)) {
      return {
        code: MCP_ERROR_CODES.ERR_INVALID_ASSET,
        reason:
          `${field}="${raw}" carries an issuer that is not a Stellar account id. An issuer must be the ` +
          `full G... public key of the issuing account; a partial or abbreviated one is refused.`,
      }
    }
    return {
      code: MCP_ERROR_CODES.ERR_INVALID_ASSET,
      reason:
        `${field}="${raw}" is not an asset reference. Expected "native", an uppercase alphanumeric ` +
        `code of up to 12 characters, or CODE:ISSUER with the issuer's full G... account id.`,
    }
  }

  const [code, issuer] = raw.split(':')
  return { asset: { code, issuer: issuer ?? null } }
}

function codeMatches(q: AssetRef, side: AssetRef): boolean {
  return q.code === side.code.toUpperCase()
}

/**
 * REST's issuer rule, kept identical: the issuer binds only when both the
 * request and the watched pair name one. XLM has no issuer, and a caller who
 * passes a bare code has asserted nothing about which issuer they meant.
 */
function sideMatches(q: AssetRef, side: AssetRef): boolean {
  if (!codeMatches(q, side)) return false
  if (!q.issuer || !side.issuer) return true
  return q.issuer === side.issuer
}

function assetLabel(side: AssetRef): string {
  return side.issuer ? `${side.code}:${side.issuer}` : side.code
}

/**
 * Resolve a request against the pairs one network watches.
 *
 * A code that matches but an issuer that does not is reported as its own
 * failure, naming the issuer this network actually prices. That is deliberate:
 * "not watched" would send the agent hunting for a pair that is there, and the
 * alternative — matching on code alone — is the failure that made this repo
 * quote testnet USDC for a mainnet USDC request.
 */
export function resolveWatchedPair(
  assetA: AssetRef,
  assetB: AssetRef,
  network: NetworkName,
  pairs: readonly WatchedPair[],
): { pair: WatchedPair; direction: 'as-requested' | 'reversed' } | PriceToolFailure {
  const asRef = (a: AssetId): AssetRef => ({ code: a.code, issuer: a.issuer ?? null })

  const forward = (p: WatchedPair) =>
    sideMatches(assetA, asRef(p.assetA)) && sideMatches(assetB, asRef(p.assetB))
  const backward = (p: WatchedPair) =>
    sideMatches(assetA, asRef(p.assetB)) && sideMatches(assetB, asRef(p.assetA))

  const matched = pairs.find(p => forward(p) || backward(p))
  if (matched) {
    return { pair: matched, direction: forward(matched) ? 'as-requested' : 'reversed' }
  }

  const byCode = (p: WatchedPair) =>
    (codeMatches(assetA, asRef(p.assetA)) && codeMatches(assetB, asRef(p.assetB))) ||
    (codeMatches(assetA, asRef(p.assetB)) && codeMatches(assetB, asRef(p.assetA)))

  const nameClash = pairs.find(byCode)
  if (nameClash) {
    return {
      code: MCP_ERROR_CODES.ERR_ASSET_ISSUER_MISMATCH,
      reason:
        `On ${network} this deployment watches ${assetLabel(nameClash.assetA)}/${assetLabel(nameClash.assetB)}, ` +
        `but the request named ${assetLabel(assetA)}/${assetLabel(assetB)}. Those issuers identify different ` +
        `assets, so no price is returned for them. Ask for the pair exactly as watched, or register the ` +
        `pair you mean.`,
    }
  }

  const watched = pairs.map(p => p.pairKey).slice(0, PAIR_HINT_LIMIT)
  return {
    code: MCP_ERROR_CODES.ERR_PAIR_NOT_WATCHED,
    reason:
      `Pair ${assetLabel(assetA)}/${assetLabel(assetB)} is not watched on ${network}. ` +
      (watched.length
        ? `Watched on this network: ${watched.join(', ')}${pairs.length > PAIR_HINT_LIMIT ? ', ...' : ''}`
        : `This deployment watches no pairs on ${network}; none can be priced.`),
  }
}

function failure(code: McpErrorCode, reason: string): PriceToolOutcome {
  return { ok: false, error: { code, reason } }
}

/**
 * Run one `lens_get_price` request. Everything the tool can get wrong by
 * accident — an unknown argument, a folded case, a network that is not this
 * deployment's, an issuer that names a different asset — is settled here, before
 * any query runs, so a refusal costs the database nothing.
 */
export async function readLensPrice(
  args: unknown,
  queries: LensPriceQueries,
): Promise<PriceToolOutcome> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return failure(MCP_ERROR_CODES.ERR_BAD_REQUEST, 'lens_get_price expects an object of arguments')
  }

  const given = args as Record<string, unknown>

  // The low-level MCP server hands the caller's object straight to the handler,
  // so `additionalProperties: false` is only a promise until something enforces
  // it. Without this, a typo'd or smuggled key is silently ignored and the agent
  // believes it asked for something it did not.
  const allowed = ['assetA', 'assetB', 'network']
  const unexpected = Object.keys(given).filter(k => !allowed.includes(k))
  if (unexpected.length > 0) {
    return failure(
      MCP_ERROR_CODES.ERR_BAD_REQUEST,
      `Unknown argument(s): ${unexpected.join(', ')}. lens_get_price accepts only ${allowed.join(', ')}.`,
    )
  }

  const parsedA = parseAssetRef(given.assetA, 'assetA')
  if ('code' in parsedA) return failure(parsedA.code, parsedA.reason)
  const parsedB = parseAssetRef(given.assetB, 'assetB')
  if ('code' in parsedB) return failure(parsedB.code, parsedB.reason)

  let network = queries.activeNetwork
  if (given.network !== undefined) {
    if (typeof given.network !== 'string' || !(VALID_NETWORKS as readonly string[]).includes(given.network)) {
      return failure(
        MCP_ERROR_CODES.ERR_BAD_REQUEST,
        `network must be one of ${VALID_NETWORKS.join(' or ')}, got ${JSON.stringify(given.network)}`,
      )
    }
    network = given.network as NetworkName
  }

  const resolved = resolveWatchedPair(parsedA.asset, parsedB.asset, network, queries.watchedPairs(network))
  if ('code' in resolved) return failure(resolved.code, resolved.reason)
  const { pair, direction } = resolved

  const agg = await queries.aggregatedPrice(pair.pairKey, network)

  // No ingested trade, or a price of zero from every venue, is not a quote. A
  // `0` served as a price is the confident wrong number this project has been
  // burned by before, so it is refused with the data that explains it.
  if (agg.lastTradeAgeSeconds === null || !(agg.price > 0)) {
    return failure(
      MCP_ERROR_CODES.ERR_NO_RESULTS,
      `${pair.pairKey} is watched on ${network} but has no aggregated price: ` +
        `last trade ${agg.lastTradeAgeSeconds === null ? 'never' : `${agg.lastTradeAgeSeconds}s ago`}, ` +
        `price ${agg.price} across ${agg.sources} source(s).`,
    )
  }

  // Routing consults Horizon as well as the database. A price that is already
  // known should not be withheld because the route leg failed, so the failure is
  // reported in the payload rather than thrown away or turned into an error.
  const route = await queries.bestRoute(pair.assetA, pair.assetB, pair.pairKey, network).catch(() => null)

  const base = { code: pair.assetA.code, issuer: pair.assetA.issuer ?? null }
  const quote = { code: pair.assetB.code, issuer: pair.assetB.issuer ?? null }

  return {
    ok: true,
    result: {
      network,
      pairKey: pair.pairKey,
      base,
      quote,
      direction,
      orientation: 'quote-per-base',
      price: agg.price,
      sources: agg.sources,
      confidence: agg.confidence,
      lastTradeAgeSeconds: agg.lastTradeAgeSeconds,
      stale: agg.stale,
      vwap1m: agg.vwap1m,
      vwap5m: agg.vwap5m,
      vwap1h: agg.vwap1h,
      vwap24h: agg.vwap24h,
      priceChange24h: agg.priceChange24h,
      volume24h: agg.volume24h,
      sdexPrice: agg.sdexPrice,
      ammPrice: agg.ammPrice,
      sdexVolume24h: agg.sdexVolume24h,
      ammVolume24h: agg.ammVolume24h,
      bestRoute: route,
      lastUpdated: new Date().toISOString(),
    },
  }
}
