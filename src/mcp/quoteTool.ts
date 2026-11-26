import { MCP_ERROR_CODES } from './codes.js'
import type { McpErrorCode } from './codes.js'
import type { AssetId, RouteInfo, WatchedPair } from '../types.js'
import type { NetworkName } from '../config.js'
import { ASSET_PATTERN, parseAssetRef, resolveWatchedPair } from './priceTool.js'
import type { AssetRef, PriceToolFailure } from './priceTool.js'

/**
 * #685 — an agent could already ask "what is the price" (`lens_get_price`) and
 * "what is the best venue" (the same tool's 1000-unit route), but not "what
 * would *my* trade cost". Cost is not one number: it is which venue fills it,
 * how deep that venue is, and how far the price moves as it is eaten through.
 * REST answers all three (`GET /price/:a/:b/route`, `GET /price/:a/:b/depth`,
 * `GET /impact/:a/:b`) and MCP answered none, so an agent had to make three
 * HTTP calls and join them itself — or guess.
 *
 * Like `priceTool.ts`, this module is the pure half: argument shape, pair
 * resolution, and the envelope. Every number comes from an injected read
 * ({@link LensQuoteQueries}) that is the very function the REST route calls, so
 * this module cannot grow its own pricing maths and cannot reach a database.
 */

export const LENS_QUOTE_TOOL_NAME = 'lens_quote'

/**
 * The impact leg's parameters. They are fixed here rather than exposed as
 * arguments because the REST route's own defaults are the contract: `thresholds`
 * 1/5/10 percent and half the pool's base reserve as the usable ceiling. An
 * agent asking for a different fraction would get an answer no REST caller can
 * reproduce, which is the drift this tool exists to avoid.
 */
export const QUOTE_IMPACT_THRESHOLDS: readonly number[] = [1, 5, 10]
export const QUOTE_IMPACT_LIQUIDITY_FRACTION = 0.5

/**
 * What `getDepth` returns, mirrored locally instead of imported.
 *
 * `src/pricing/depth.ts` reaches Postgres, so importing its types here would put
 * a database behind a tool module that is supposed to be testable with a stub —
 * the same reason `priceTool.ts` declares {@link AggregatedPriceFields} rather
 * than importing the aggregator's. These shapes are kept field-for-field equal
 * to the real ones, and the parity tests compare the tool's legs against the REST
 * bodies built from the same functions, so a divergence fails a test rather than
 * shipping quietly.
 */
export interface QuoteDepthLevel {
  price: number
  size: number
}

export interface QuoteExcludedPool {
  poolId: string
  reason: string
}

export interface QuoteDepthPriced {
  status: 'ok'
  network: string
  pairKey: string
  spotPrice: number
  executionPrice: number
  slippagePct: number
  asks: QuoteDepthLevel[]
  bids: QuoteDepthLevel[]
  source: 'AMM'
  pool: {
    poolId: string
    feeBp: number
    feeReadAt: string
    reservesObservedAt: string
  }
  excludedPools: QuoteExcludedPool[]
}

/** A pair the venue cannot price right now: a reason and the exclusions, never zeros. */
export interface QuoteDepthUnavailable {
  status: 'unavailable'
  network: string
  pairKey: string
  reason: string
  excludedPools: QuoteExcludedPool[]
}

export type QuoteDepthOutcome = QuoteDepthPriced | QuoteDepthUnavailable

export interface QuoteImpactPoint {
  size: number
  output: number
  executionPrice: number
  slippagePct: number
}

export interface QuoteImpactThreshold {
  thresholdPct: number
  crossed: boolean
  size: number | null
}

export interface QuoteImpact {
  status: 'ok' | 'insufficient_liquidity'
  spotPrice: number
  availableLiquidity: number
  smallestSize: number
  ladder: QuoteImpactPoint[]
  thresholds: QuoteImpactThreshold[]
  source: 'AMM'
}

/** The reads `lens_quote` needs, supplied by the process that hosts the tool. */
export interface LensQuoteQueries {
  /** Network the caller gets when they name none — the deployment's own default. */
  readonly activeNetwork: NetworkName
  /**
   * Pairs watched on that network, issuers intact: the same list REST's
   * `findPair` searches, so a pair REST answers 404 for is refused here too.
   */
  watchedPairs(network: NetworkName): readonly WatchedPair[]
  /** `GET /price/:assetA/:assetB/route`'s own call, at the caller's order size. */
  route(
    assetA: AssetId,
    assetB: AssetId,
    pairKey: string,
    amount: number,
    network: NetworkName
  ): Promise<RouteInfo>
  /** `GET /price/:assetA/:assetB/depth`'s own call. */
  depth(network: NetworkName, pairKey: string, amount: number): Promise<QuoteDepthOutcome>
  /** `GET /impact/:assetA/:assetB`'s own call; null when there is no AMM leg to measure. */
  impact(
    pairKey: string,
    network: NetworkName,
    thresholds: readonly number[],
    liquidityFraction: number
  ): Promise<QuoteImpact | null>
}

/** A leg that has an answer to report but no number: stated, not hidden. */
export interface QuoteUnavailableLeg {
  leg: 'depth' | 'impact'
  code: McpErrorCode
  reason: string
}

export type LensQuoteResult = {
  network: NetworkName
  pairKey: string
  /** The order size every leg is priced for, in units of `base`. */
  amount: number
  /** The pair's base side, issuer intact. `amount` is a quantity of this. */
  base: AssetRef
  /** The pair's quote side. Every price in the legs is units of this per one base. */
  quote: AssetRef
  /** Whether the pair matched in the order asked, or the other way round. */
  direction: 'as-requested' | 'reversed'
  /** Constant, so no leg can be read backwards. */
  orientation: 'quote-per-base'
  /** Exactly the `GET /price/:assetA/:assetB/route` body. */
  route: RouteInfo
  /** Exactly the `GET /price/:assetA/:assetB/depth` body, on either arm. */
  depth: { assetA: string; assetB: string } & QuoteDepthOutcome
  /** Exactly the `GET /impact/:assetA/:assetB` body, or null — see `unavailable`. */
  impact: ({ assetA: string; assetB: string; pairKey: string } & QuoteImpact) | null
  /**
   * Legs whose answer is "we cannot price that", each with the reason the data
   * layer gave. Empty when every leg priced the order.
   */
  unavailable: QuoteUnavailableLeg[]
  lastUpdated: string
}

export type QuoteToolOutcome =
  | { ok: true; result: LensQuoteResult }
  | { ok: false; error: PriceToolFailure }

const VALID_NETWORKS: readonly NetworkName[] = ['testnet', 'mainnet']

/**
 * A plain decimal, optionally without the leading zero. Deliberately not
 * `parseFloat`: `parseFloat('100abc')` is 100, so a typo'd argument would price
 * a different trade than the one the agent meant to ask about. Nor is it
 * `Number()` alone, which would accept `''`, `' '` and `'1e5'` — an empty string
 * becoming 0 and an exponent nobody asked for.
 */
const AMOUNT_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/

/**
 * Validate the order size. Both REST legs already refuse a non-positive or
 * unparseable amount with a 400, so this is the same rule in the tool's
 * vocabulary — and it runs before any query, so a bad amount costs the database
 * nothing.
 */
export function parseQuoteAmount(raw: unknown): { amount: number } | PriceToolFailure {
  const invalid = (detail: string): PriceToolFailure => ({
    code: MCP_ERROR_CODES.ERR_BAD_REQUEST,
    reason: `amount must be a positive, finite decimal number of units to sell — ${detail}`,
  })

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return invalid(`${raw} is not a finite number`)
    if (!(raw > 0)) return invalid(`${raw} is not greater than zero`)
    return { amount: raw }
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!AMOUNT_RE.test(trimmed)) {
      if (/^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(trimmed)) {
        return invalid(`"${raw}" is written in scientific notation; write the number out in full`)
      }
      return invalid(`"${raw}" is not a plain decimal. Trailing text is not ignored: "100abc" is refused, not read as 100.`)
    }
    const amount = Number(trimmed)
    if (!Number.isFinite(amount) || !(amount > 0)) {
      return invalid(`"${raw}" does not resolve to a positive, finite amount`)
    }
    return { amount }
  }

  return invalid(`it is ${raw === undefined ? 'missing' : typeof raw}`)
}

function failure(code: McpErrorCode, reason: string): QuoteToolOutcome {
  return { ok: false, error: { code, reason } }
}

/**
 * Run one `lens_quote` request.
 *
 * A refusal (bad asset, bad amount, bad network, unwatched pair, mismatched
 * issuer) returns before anything is read. A leg that reads successfully and
 * reports "unavailable" is not a refusal: it stays in the result, because the
 * other legs may still price the order and an agent needs the reason, not a
 * thrown-away quote. A read that *throws* is a different thing and is left to
 * throw — the hosting server turns it into ERR_SERVICE_UNREACHABLE, because
 * "the store was unreachable" must never be readable as "there is no liquidity".
 */
export async function readLensQuote(
  args: unknown,
  queries: LensQuoteQueries
): Promise<QuoteToolOutcome> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return failure(MCP_ERROR_CODES.ERR_BAD_REQUEST, 'lens_quote expects an object of arguments')
  }

  const given = args as Record<string, unknown>

  // As in the price tool: `additionalProperties: false` is only a promise until
  // something enforces it, and an ignored key means the agent got an answer to a
  // question it did not ask.
  const allowed = ['assetA', 'assetB', 'amount', 'network']
  const unexpected = Object.keys(given).filter(k => !allowed.includes(k))
  if (unexpected.length > 0) {
    return failure(
      MCP_ERROR_CODES.ERR_BAD_REQUEST,
      `Unknown argument(s): ${unexpected.join(', ')}. lens_quote accepts only ${allowed.join(', ')}.`
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
        `network must be one of ${VALID_NETWORKS.join(' or ')}, got ${JSON.stringify(given.network)}`
      )
    }
    network = given.network as NetworkName
  }

  // Before pair resolution, matching REST's route leg: a malformed request
  // parameter is a refusal whatever the pair.
  const parsedAmount = parseQuoteAmount(given.amount)
  if ('code' in parsedAmount) return failure(parsedAmount.code, parsedAmount.reason)
  const { amount } = parsedAmount

  const resolved = resolveWatchedPair(parsedA.asset, parsedB.asset, network, queries.watchedPairs(network))
  if ('code' in resolved) return failure(resolved.code, resolved.reason)
  const { pair, direction } = resolved

  const [route, depth, impact] = await Promise.all([
    queries.route(pair.assetA, pair.assetB, pair.pairKey, amount, network),
    queries.depth(network, pair.pairKey, amount),
    queries.impact(pair.pairKey, network, QUOTE_IMPACT_THRESHOLDS, QUOTE_IMPACT_LIQUIDITY_FRACTION),
  ])

  // Every leg is rendered from the pair's own order, exactly as the REST routes
  // do it: `assetA`/`assetB` are the watched codes, not what the caller typed,
  // and `amount` is always a quantity of the base side.
  const assetA = pair.assetA.code
  const assetB = pair.assetB.code

  const depthBody = { assetA, assetB, ...depth }
  const impactBody = impact ? { assetA, assetB, pairKey: pair.pairKey, ...impact } : null

  const unavailable: QuoteUnavailableLeg[] = []
  if (depth.status === 'unavailable') {
    unavailable.push({
      leg: 'depth',
      code: MCP_ERROR_CODES.ERR_NO_RESULTS,
      reason: `Depth is unavailable for ${pair.pairKey} on ${network}: ${depth.reason}`,
    })
  }
  if (impact === null) {
    unavailable.push({
      leg: 'impact',
      code: MCP_ERROR_CODES.ERR_NO_RESULTS,
      reason:
        `No AMM liquidity available for ${assetA}/${assetB} on ${network}: this pair has no AMM pool ` +
        `snapshot to measure against, so no impact curve exists. The route and depth legs are unaffected.`,
    })
  } else if (impact.status === 'insufficient_liquidity') {
    unavailable.push({
      leg: 'impact',
      code: MCP_ERROR_CODES.ERR_NO_RESULTS,
      reason:
        `AMM liquidity for ${pair.pairKey} on ${network} is too thin to build an impact curve ` +
        `(status insufficient_liquidity, ladder empty). The numbers in the impact leg are its spot ` +
        `price and usable liquidity only; no size was priced.`,
    })
  }

  return {
    ok: true,
    result: {
      network,
      pairKey: pair.pairKey,
      amount,
      base: { code: pair.assetA.code, issuer: pair.assetA.issuer ?? null },
      quote: { code: pair.assetB.code, issuer: pair.assetB.issuer ?? null },
      direction,
      orientation: 'quote-per-base',
      route,
      depth: depthBody,
      impact: impactBody,
      unavailable,
      lastUpdated: new Date().toISOString(),
    },
  }
}

function assetRefSchema() {
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

/**
 * The three legs are declared as open objects carrying their discriminant and
 * their headline fields. That is deliberate: each one *is* a REST response body,
 * whose full contract lives in `openapi.yaml` and is asserted field-for-field by
 * the parity tests. Restating those schemas here would give the same contract two
 * owners, and the copy that is not generated is the one that rots.
 */
function depthSchema() {
  return {
    type: 'object',
    properties: {
      assetA: { type: 'string' },
      assetB: { type: 'string' },
      pairKey: { type: 'string' },
      network: { type: 'string' },
      status: { type: 'string', enum: ['ok', 'unavailable'] },
      reason: { type: 'string' },
      excludedPools: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            poolId: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['poolId', 'reason'],
        },
      },
    },
    required: ['assetA', 'assetB', 'pairKey', 'status', 'excludedPools'],
  }
}

function impactSchema() {
  return {
    anyOf: [
      {
        type: 'object',
        properties: {
          assetA: { type: 'string' },
          assetB: { type: 'string' },
          pairKey: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'insufficient_liquidity'] },
          source: { type: 'string', enum: ['AMM'] },
        },
        required: ['assetA', 'assetB', 'pairKey', 'status', 'source'],
      },
      { type: 'null' },
    ],
  }
}

export const lensQuoteToolDefinition = () => ({
  name: LENS_QUOTE_TOOL_NAME,
  description:
    'What one specific trade would cost on Lens right now, for an order size the caller names: the ' +
    'best route and its estimated output, the order-book depth around the fill, and the price impact ' +
    'ladder. Equal to the three REST routes GET /price/:assetA/:assetB/route, ' +
    'GET /price/:assetA/:assetB/depth and GET /impact/:assetA/:assetB — the same functions, the same ' +
    'pair, the same numbers, with the route and impact legs at the caller\'s `amount` instead of a ' +
    'fixed 1000. Read-only: it signs nothing, sends nothing and pays nothing, so use it instead of ' +
    'paid_call for any question about Lens\'s own markets. ' +
    'Assets are CODE or CODE:ISSUER (use "native" or "XLM" for lumens) and the pair is matched both ' +
    'ways; give the issuer for a token, because asset codes are not unique on Stellar and a request ' +
    'whose code matches but whose issuer does not is refused as ERR_ASSET_ISSUER_MISMATCH rather than ' +
    'priced against a same-named asset. ' +
    '`amount` is REQUIRED, unlike REST where it defaults to 1000, because a cost without a size is not ' +
    'a cost. It is a positive, finite decimal counted in units of `base` — the pair\'s own base side, ' +
    'which `direction` says whether you asked for it in that order or the other. Trailing junk is ' +
    'refused (ERR_BAD_REQUEST), never truncated to a round number. ' +
    'Every price is units of `quote` per one `base` (`orientation` is always "quote-per-base"). ' +
    'Network is "testnet" or "mainnet", defaulting to the network this server runs. ' +
    'A leg that cannot price the order is reported in the result, not as a tool error: `depth.status` ' +
    'is "unavailable" with its `reason` and the `excludedPools` that were left out, `impact` is null ' +
    'when the pair has no AMM pool to measure, and each of those also appears in `unavailable` with a ' +
    'code and the reason in full. That is deliberate — the other legs may still be perfectly good, and ' +
    'a caller that only reads `route` still gets a quote that was honestly qualified. Only a read that ' +
    'fails outright (the database or Horizon being unreachable) answers ERR_SERVICE_UNREACHABLE, which ' +
    'means retry later and is never readable as "no liquidity". The impact leg is always computed at ' +
    'thresholds 1/5/10 percent and half the usable base reserve, the same defaults REST uses.',
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
      amount: {
        type: ['number', 'string'],
        description:
          'Order size to price, in units of the pair\'s base side. Positive, finite, plain decimal.',
      },
      network: {
        type: 'string',
        enum: [...VALID_NETWORKS],
        description: 'Stellar network to quote. Defaults to the network this server is configured for.',
      },
    },
    required: ['assetA', 'assetB', 'amount'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      network: { type: 'string', enum: [...VALID_NETWORKS] },
      pairKey: { type: 'string' },
      amount: { type: 'number' },
      base: assetRefSchema(),
      quote: assetRefSchema(),
      direction: { type: 'string', enum: ['as-requested', 'reversed'] },
      orientation: { type: 'string', enum: ['quote-per-base'] },
      route: { type: 'object' },
      depth: depthSchema(),
      impact: impactSchema(),
      unavailable: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            leg: { type: 'string', enum: ['depth', 'impact'] },
            code: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['leg', 'code', 'reason'],
        },
      },
      lastUpdated: { type: 'string' },
    },
    required: [
      'network', 'pairKey', 'amount', 'base', 'quote', 'direction', 'orientation',
      'route', 'depth', 'impact', 'unavailable', 'lastUpdated',
    ],
    additionalProperties: false,
  },
})
