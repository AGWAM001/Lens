import { estimatedLpReturns } from '../pricing/lpReturns'
import { MCP_ERROR_CODES } from './codes.js'
import type { McpErrorCode } from './codes.js'
import {
  LENS_GET_POOLS_ARGUMENTS_SCHEMA,
  LENS_LIST_PAIRS_ARGUMENTS_SCHEMA,
  LENS_SCREEN_PAIRS_ARGUMENTS_SCHEMA,
  formatZodError,
  zodToToolInputSchema,
} from './toolSchemas.js'
import type {
  LensGetPoolsArguments,
  LensListPairsArguments,
  LensScreenPairsArguments,
} from './toolSchemas.js'
import type { NetworkName } from '../config.js'
import type { AssetId } from '../types.js'
import type { ListPairsOutcome, PairWithLatest } from '../routes/pairs.js'
import type { ListPoolsOutcome, PoolSnapshotRow } from '../routes/pools.js'
import type { ScreenerFilters, ScreenerPage, ScreenerRow } from '../services/screener.js'

/**
 * #409 — an agent that can read a price still cannot ask what is quotable, what
 * liquidity stands behind it, or what is moving, because REST answered all three
 * and MCP answered none. Guessing an asset code is how an agent ends up
 * confidently asking about an asset that does not exist.
 *
 * These three tools are the pure half of those answers: argument shape, paging,
 * issuer enrichment and the refusal vocabulary. The reads themselves are
 * injected ({@link LensDataQueries}) and are the very functions the REST routes
 * call, so a page from a tool cannot drift from a page over HTTP — the same
 * split `priceTool.ts` makes for `lens_get_price`, and for the same reason: the
 * stdio server must not acquire a database to exist.
 */

export const LENS_LIST_PAIRS_TOOL_NAME = 'lens_list_pairs'
export const LENS_GET_POOLS_TOOL_NAME = 'lens_get_pools'
export const LENS_SCREEN_PAIRS_TOOL_NAME = 'lens_screen_pairs'

export type LensDataToolName =
  | typeof LENS_LIST_PAIRS_TOOL_NAME
  | typeof LENS_GET_POOLS_TOOL_NAME
  | typeof LENS_SCREEN_PAIRS_TOOL_NAME

const LENS_DATA_TOOL_NAMES: readonly LensDataToolName[] = [
  LENS_LIST_PAIRS_TOOL_NAME,
  LENS_GET_POOLS_TOOL_NAME,
  LENS_SCREEN_PAIRS_TOOL_NAME,
]

export function isLensDataToolName(name: string): name is LensDataToolName {
  return (LENS_DATA_TOOL_NAMES as readonly string[]).includes(name)
}

/** A page request the tool has settled: a bound to honour and where to resume. */
export interface LensToolPaging {
  /** Page size for a caller who asked for none — operator configuration. */
  defaultLimit: number
  /** Ceiling; an ask over it is clamped, not honoured (#416's rule). */
  maxLimit: number
}

/** An asset exactly as Stellar defines it: code plus the issuer that gives it meaning. */
export interface AssetRef {
  code: string
  issuer: string | null
}

/**
 * The reads behind the three tools, supplied by the process that hosts them.
 * Each returns the same shape the REST route renders from, so parity is
 * structural rather than something a test has to hope for.
 */
export interface LensDataQueries {
  /** Network the caller gets when they name none — the deployment's own default. */
  readonly activeNetwork: NetworkName
  listPairs(network: NetworkName, page: { limit?: number; cursor?: string }): Promise<ListPairsOutcome>
  listPools(network: NetworkName, page: { limit?: number; cursor?: string }): Promise<ListPoolsOutcome>
  /** Pairs watched on that network, issuers intact — what a pool row's bare codes are resolved against. */
  watchedPairs(network: NetworkName): readonly { assetA: AssetId; assetB: AssetId }[]
  /**
   * The screener. Rejects are returned rather than thrown, so an unsupported
   * filter or an undecodable cursor reaches the agent as the same message the
   * REST route answers with; a database that is unreachable still throws.
   * `limit` comes back as the page size actually run — the screener bounds its
   * own pages, tighter than the tool ceiling, and the agent is told which one
   * it got.
   */
  screen(request: {
    network: NetworkName
    filters?: ScreenerFilters
    sortBy?: string
    order?: string
    cursor?: string
    limit?: number
    /** Present at all means the caller asked for market cap, which cannot be computed. */
    marketCapAsked: boolean
  }): Promise<ScreenerScreenOutcome>
}

export type ScreenerScreenOutcome =
  | { ok: true; page: ScreenerPage; limit: number }
  | { ok: false; error: string }

export type LensPairEntry = {
  pairKey: string
  assetA: AssetRef
  assetB: AssetRef
  latestPrice: number | null
  lastUpdated: string | null
  /** The venue's own observation time, when the source carries one (#243). */
  sourceTime: string | null
}

export type LensPairsPage = {
  network: NetworkName
  pairs: LensPairEntry[]
  /** The page size actually honoured — clamped when the ask exceeded the ceiling. */
  limit: number
  nextCursor: string | null
  hasMore: boolean
}

export type LensPoolEntry = {
  pool_id: string
  /** The codes the AMM stores on the row, unchanged. */
  asset_a: string
  asset_b: string
  /** The same assets with the issuer that defines them, or null when this network watches no such pair. */
  assetA: AssetRef
  assetB: AssetRef
  reserve_a: number | null
  reserve_b: number | null
  spot_price: number | null
  fee_bp: number | null
  timestamp: string
  /** 24h LP return estimates (#400), identical to the ones GET /pools reports. */
  window: '24h'
  feeAprPct: number | null
  impermanentLossPct: number | null
  netReturn24hPct: number | null
  estimate: true
}

export type LensPoolsPage = {
  network: NetworkName
  pools: LensPoolEntry[]
  limit: number
  nextCursor: string | null
  hasMore: boolean
}

export type LensScreenerRow = {
  pair_key: string
  volume: number
  price: number
  change_24h: number
  liquidity: number
  liquidity_unit: string
}

export type LensScreenerPage = {
  network: NetworkName
  data: LensScreenerRow[]
  /** The page size the screener actually ran, which can be below the asked-for limit. */
  limit: number
  nextCursor: string | null
  hasMore: boolean
  /** Always null: the screener ranks a window, it does not count a population. */
  total: null
}

export type LensDataToolFailure = { code: McpErrorCode; reason: string }

export type LensDataToolOutcome =
  | { ok: true; result: LensPairsPage | LensPoolsPage | LensScreenerPage }
  | { ok: false; error: LensDataToolFailure }

const VALID_NETWORKS: readonly NetworkName[] = ['testnet', 'mainnet']

function assetRef(asset: AssetId): AssetRef {
  return { code: asset.code, issuer: asset.issuer ?? null }
}

function pairEntry(p: PairWithLatest): LensPairEntry {
  return {
    pairKey: p.pairKey,
    assetA: assetRef(p.assetA),
    assetB: assetRef(p.assetB),
    latestPrice: p.latestPrice,
    // Dates do not survive JSON; an agent needs to read the age, not infer it.
    lastUpdated: p.lastUpdated ? new Date(p.lastUpdated).toISOString() : null,
    sourceTime: p.sourceTime ? new Date(p.sourceTime).toISOString() : null,
  }
}

const pagingProperties = {
  network: {
    type: 'string',
    enum: [...VALID_NETWORKS],
    description: 'Stellar network to read. Defaults to the network this server is configured for.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    description:
      'Items to return in this page. Clamped to the server ceiling rather than refused; check "limit" in the result for the size you actually got.',
  },
  cursor: {
    type: 'string',
    description:
      'Opaque token from a previous result\'s "nextCursor". Do not construct or guess one, and do not treat it as an offset.',
  },
} as const

const pageFields = {
  limit: { type: 'integer', minimum: 1 },
  nextCursor: { type: ['string', 'null'] },
  hasMore: { type: 'boolean' },
} as const

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

const PAGING_NOTICE =
  'Results are one page: when "hasMore" is true, pass "nextCursor" back as the cursor argument for the rest. '

const ISSUER_NOTICE =
  'Every asset is carried as {code, issuer} with the issuer spelled out in full — a Stellar asset code ' +
  'is not unique, anyone can issue "USDC", so an issuer is part of the identity, never an optional detail. '

export function lensDataToolDefinitions() {
  return [
    {
      name: LENS_LIST_PAIRS_TOOL_NAME,
      description:
        'List the asset pairs this Lens deployment watches, one page at a time, with the latest price and ' +
        'its age for each. This is the discovery tool: call it before lens_get_price to learn what can ' +
        'actually be quoted, and use the pair keys and full issuers it returns verbatim in that call. ' +
        'It answers "what exists here" — not "which pair is moving" (that is lens_screen_pairs, which ' +
        'filters and ranks) and not "what liquidity is behind a pair" (that is lens_get_pools). ' +
        PAGING_NOTICE +
        ISSUER_NOTICE +
        'A pair with no data on this network comes back with a null price and null lastUpdated rather than ' +
        'being dropped, so an empty listing means nothing is watched on that network.',
      inputSchema: zodToToolInputSchema(LENS_LIST_PAIRS_ARGUMENTS_SCHEMA),
      outputSchema: {
        type: 'object',
        properties: {
          network: { type: 'string', enum: [...VALID_NETWORKS] },
          pairs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pairKey: { type: 'string' },
                assetA: assetRefSchema(),
                assetB: assetRefSchema(),
                latestPrice: { type: ['number', 'null'] },
                lastUpdated: { type: ['string', 'null'] },
                sourceTime: { type: ['string', 'null'] },
              },
              required: ['pairKey', 'assetA', 'assetB', 'latestPrice', 'lastUpdated', 'sourceTime'],
              additionalProperties: false,
            },
          },
          ...pageFields,
        },
        required: ['network', 'pairs', 'limit', 'nextCursor', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      name: LENS_GET_POOLS_TOOL_NAME,
      description:
        'List the AMM liquidity pools Lens ingests on one network, one page at a time, with each pool\'s ' +
        'newest reserves, spot price and fee. Use it to judge whether a price is deep enough to act on — ' +
        'how much liquidity stands behind a pair — after lens_list_pairs has told you the pair exists. ' +
        'It is not a discovery tool for pairs (use lens_list_pairs) and not a market mover list (use ' +
        'lens_screen_pairs). ' +
        PAGING_NOTICE +
        ISSUER_NOTICE +
        'The AMM stores only asset codes on a pool row, so the issuers attached here are the ones from the ' +
        'watched pair that carries those codes; when no watched pair does, issuer is null rather than a ' +
        'guessed one. Pages are ordered by pool id.',
      inputSchema: zodToToolInputSchema(LENS_GET_POOLS_ARGUMENTS_SCHEMA),
      outputSchema: {
        type: 'object',
        properties: {
          network: { type: 'string', enum: [...VALID_NETWORKS] },
          pools: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pool_id: { type: 'string' },
                asset_a: { type: 'string' },
                asset_b: { type: 'string' },
                assetA: assetRefSchema(),
                assetB: assetRefSchema(),
                reserve_a: { type: ['number', 'null'] },
                reserve_b: { type: ['number', 'null'] },
                spot_price: { type: ['number', 'null'] },
                fee_bp: { type: ['integer', 'null'] },
                timestamp: { type: 'string' },
                window: { type: 'string', enum: ['24h'] },
                feeAprPct: { type: ['number', 'null'] },
                impermanentLossPct: { type: ['number', 'null'] },
                netReturn24hPct: { type: ['number', 'null'] },
                estimate: { type: 'boolean' },
              },
              required: [
                'pool_id', 'asset_a', 'asset_b', 'assetA', 'assetB',
                'reserve_a', 'reserve_b', 'spot_price', 'fee_bp', 'timestamp',
                'window', 'feeAprPct', 'impermanentLossPct', 'netReturn24hPct', 'estimate',
              ],
              additionalProperties: false,
            },
          },
          ...pageFields,
        },
        required: ['network', 'pools', 'limit', 'nextCursor', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      name: LENS_SCREEN_PAIRS_TOOL_NAME,
      description:
        'Rank watched pairs by 24h activity and filter them by volume, price, change or liquidity: the ' +
        '"what is moving" view. Use it to shortlist candidates from a population, then lens_get_price on a ' +
        'specific pair for the quote and lens_get_pools for the depth behind it. Do not use it to enumerate ' +
        'what exists (that is lens_list_pairs, which is unfiltered and lists quiet pairs too). ' +
        'sortBy is volume, change_24h, price or liquidity (default volume); order is asc or desc ' +
        '(default desc). market_cap is refused: Lens has no circulating-supply data to compute it from, so ' +
        'filter liquidity instead. ' +
        PAGING_NOTICE +
        'Rows key on pair_key, which already names each asset\'s issuer in full, so a screen result can be ' +
        'passed straight to lens_get_price without rebuilding the asset.',
      inputSchema: zodToToolInputSchema(LENS_SCREEN_PAIRS_ARGUMENTS_SCHEMA),
      outputSchema: {
        type: 'object',
        properties: {
          network: { type: 'string', enum: [...VALID_NETWORKS] },
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pair_key: { type: 'string' },
                volume: { type: 'number' },
                price: { type: 'number' },
                change_24h: { type: 'number' },
                liquidity: { type: 'number' },
                liquidity_unit: { type: 'string' },
              },
              required: ['pair_key', 'volume', 'price', 'change_24h', 'liquidity', 'liquidity_unit'],
              additionalProperties: false,
            },
          },
          ...pageFields,
          total: { type: 'null' },
        },
        required: ['network', 'data', 'limit', 'nextCursor', 'hasMore', 'total'],
        additionalProperties: false,
      },
    },
  ]
}

function failure(code: McpErrorCode, reason: string): LensDataToolOutcome {
  return { ok: false, error: { code, reason } }
}

/**
 * The server hands the caller's object straight to the handler, so a bad
 * `network` or an argument type the schema never saw must be settled here rather
 * than reach the database and come back as something worse.
 */
function readNetwork(raw: unknown, queries: LensDataQueries): NetworkName | LensDataToolFailure {
  if (raw === undefined) return queries.activeNetwork
  if (typeof raw !== 'string' || !(VALID_NETWORKS as readonly string[]).includes(raw as NetworkName)) {
    return {
      code: MCP_ERROR_CODES.ERR_BAD_REQUEST,
      reason: `network must be one of ${VALID_NETWORKS.join(' or ')}, got ${JSON.stringify(raw)}`,
    }
  }
  return raw as NetworkName
}

function isFailure(value: NetworkName | LensDataToolFailure): value is LensDataToolFailure {
  return typeof value === 'object' && value !== null && 'code' in value
}

/**
 * Clamp rather than refuse: an agent that asks for 500 pairs gets a small page
 * and a cursor, which is a better outcome than an error it has to understand.
 */
function resolveLimit(limit: number | undefined, paging: LensToolPaging): number {
  return limit !== undefined ? Math.min(limit, paging.maxLimit) : paging.defaultLimit
}

export async function readLensPairsPage(
  args: LensListPairsArguments,
  queries: LensDataQueries,
  paging: LensToolPaging
): Promise<LensDataToolOutcome> {
  const network = readNetwork(args.network, queries)
  if (isFailure(network)) return failure(network.code, network.reason)

  const limit = resolveLimit(args.limit, paging)
  const outcome = await queries.listPairs(network, { limit, cursor: args.cursor })
  if (!outcome.ok) return failure(MCP_ERROR_CODES.ERR_BAD_REQUEST, outcome.error)

  return {
    ok: true,
    result: {
      network,
      pairs: outcome.pairs.map(pairEntry),
      // The page size the listing actually honoured, which is the clamped one
      // when the ask was over the ceiling.
      limit: outcome.limit,
      nextCursor: outcome.nextCursor,
      hasMore: outcome.hasMore,
    },
  }
}

/**
 * Attach the issuer a pool row does not store. The AMM snapshot carries bare
 * codes; the watched pair that names those codes is what says which USDC this is.
 * A pool whose codes match no watched pair keeps null issuers rather than
 * borrowing the only one on hand — a wrong issuer is a different asset.
 */
export function resolvePoolAssets(
  row: Pick<PoolSnapshotRow, 'asset_a' | 'asset_b'>,
  pairs: readonly { assetA: AssetId; assetB: AssetId }[]
): { assetA: AssetRef; assetB: AssetRef } {
  const match = pairs.find(
    p =>
      (p.assetA.code === row.asset_a && p.assetB.code === row.asset_b) ||
      (p.assetA.code === row.asset_b && p.assetB.code === row.asset_a)
  )

  if (!match) {
    return {
      assetA: { code: row.asset_a, issuer: null },
      assetB: { code: row.asset_b, issuer: null },
    }
  }

  const forward = match.assetA.code === row.asset_a
  return {
    assetA: assetRef(forward ? match.assetA : match.assetB),
    assetB: assetRef(forward ? match.assetB : match.assetA),
  }
}

export async function readLensPoolsPage(
  args: LensGetPoolsArguments,
  queries: LensDataQueries,
  paging: LensToolPaging
): Promise<LensDataToolOutcome> {
  const network = readNetwork(args.network, queries)
  if (isFailure(network)) return failure(network.code, network.reason)

  const limit = resolveLimit(args.limit, paging)
  const outcome = await queries.listPools(network, { limit, cursor: args.cursor })
  if (!outcome.ok) return failure(MCP_ERROR_CODES.ERR_BAD_REQUEST, outcome.error)

  return {
    ok: true,
    result: {
      network,
      pools: outcome.pools.map(r => ({
        pool_id: r.pool_id,
        asset_a: r.asset_a,
        asset_b: r.asset_b,
        ...resolvePoolAssets(r, queries.watchedPairs(network)),
        // numeric columns arrive as strings to keep them exact; an agent reading
        // JSON wants the number, and this is where the rounding is decided.
        reserve_a: r.reserve_a === null ? null : parseFloat(r.reserve_a),
        reserve_b: r.reserve_b === null ? null : parseFloat(r.reserve_b),
        spot_price: r.spot_price === null ? null : parseFloat(r.spot_price),
        fee_bp: r.fee_bp === null || r.fee_bp === undefined ? null : parseInt(String(r.fee_bp), 10),
        timestamp: new Date(r.timestamp).toISOString(),
        ...estimatedLpReturns(r),
      })),
      limit: outcome.limit,
      nextCursor: outcome.nextCursor,
      hasMore: outcome.hasMore,
    },
  }
}

const SCREENER_FILTER_KEYS = [
  'volume',
  'change_24h_min',
  'change_24h_max',
  'price_min',
  'price_max',
  'liquidity',
] as const

export async function readLensScreenerPage(
  args: LensScreenPairsArguments,
  queries: LensDataQueries,
  paging: LensToolPaging
): Promise<LensDataToolOutcome> {
  const network = readNetwork(args.network, queries)
  if (isFailure(network)) return failure(network.code, network.reason)

  const limit = resolveLimit(args.limit, paging)

  const filters: ScreenerFilters = {}
  for (const key of SCREENER_FILTER_KEYS) {
    const value = args[key]
    if (value !== undefined) filters[key] = value
  }

  const outcome = await queries.screen({
    network,
    filters,
    sortBy: args.sortBy,
    order: args.order,
    cursor: args.cursor,
    limit,
    // sortBy is enum-validated by the schema, so a market_cap sort is refused as
    // an invalid argument; only the filter itself needs the dedicated message.
    marketCapAsked: args.market_cap !== undefined,
  })
  if (!outcome.ok) return failure(MCP_ERROR_CODES.ERR_BAD_REQUEST, outcome.error)

  const { page } = outcome
  return {
    ok: true,
    result: {
      network,
      data: page.data.map((row: ScreenerRow & { liquidity_unit: string }) => ({
        pair_key: row.pair_key,
        volume: row.volume,
        price: row.price,
        change_24h: row.change_24h,
        liquidity: row.liquidity,
        liquidity_unit: row.liquidity_unit,
      })),
      limit: outcome.limit,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      total: page.total,
    },
  }
}

/** Run one of the three Lens data tools. The caller has already matched the name. */
export async function callLensDataTool(
  name: LensDataToolName,
  args: unknown,
  queries: LensDataQueries,
  paging: LensToolPaging
): Promise<LensDataToolOutcome> {
  const schema =
    name === LENS_LIST_PAIRS_TOOL_NAME
      ? LENS_LIST_PAIRS_ARGUMENTS_SCHEMA
      : name === LENS_GET_POOLS_TOOL_NAME
        ? LENS_GET_POOLS_ARGUMENTS_SCHEMA
        : LENS_SCREEN_PAIRS_ARGUMENTS_SCHEMA

  const parsed = schema.safeParse(args ?? {})
  if (!parsed.success) {
    // Naming the offending argument is the difference between an agent fixing
    // its call and an agent retrying the same mistake.
    return failure(MCP_ERROR_CODES.ERR_BAD_REQUEST, formatZodError(parsed.error))
  }

  switch (name) {
    case LENS_LIST_PAIRS_TOOL_NAME:
      return readLensPairsPage(parsed.data as LensListPairsArguments, queries, paging)
    case LENS_GET_POOLS_TOOL_NAME:
      return readLensPoolsPage(parsed.data as LensGetPoolsArguments, queries, paging)
    case LENS_SCREEN_PAIRS_TOOL_NAME:
      return readLensScreenerPage(parsed.data as LensScreenPairsArguments, queries, paging)
  }
}
