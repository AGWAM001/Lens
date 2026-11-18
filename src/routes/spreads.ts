import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { sendInternalError, apiError } from '../errors'

// Supported windows → lookback in minutes. A spread is a statement about *now*,
// so these are deliberately short: widen the window far enough and you stop
// measuring liquidity and start measuring the day's price drift.
const WINDOW_MINUTES = {
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '24h': 60 * 24,
} as const

type SpreadWindow = keyof typeof WINDOW_MINUTES

const WINDOWS = Object.keys(WINDOW_MINUTES) as SpreadWindow[]

/** A venue needs at least this many observations before its spread means anything. */
export const MIN_OBSERVATIONS = 2

export interface VenueSpread {
  venue: string
  pairKey: string
  bid: number
  ask: number
  mid: number
  spreadBps: number
  /** Same as spreadBps / 100 — convenient for display (e.g. "0.20 %"). */
  spreadPct: number
  observations: number
  lastSeen: string
}

/**
 * Register the bid/ask spread endpoint.
 *
 * `GET /spreads/:asset?window=5m|15m|1h|24h&network=testnet|mainnet`
 *
 * Reports, for every (venue, pair) that quoted `asset` inside the window, the
 * low, the high and the gap between them in basis points — then the tightest of
 * them, which is the practical answer to "where should I trade this".
 *
 * ## What the numbers actually mean
 *
 * Lens stores one `price` per observation, not a quoted bid and ask. So a
 * venue's spread here is the dispersion of its own recent prints — the range it
 * traded through over the window — rather than a book's top-of-book gap. That
 * is a real liquidity signal (a thin venue prints a wide range, a deep one
 * prints a tight one) but it is **not** the number that venue's own order book
 * would report, and it should not be presented as one.
 *
 * Basis points are taken against the **mid**, not against the ask:
 *
 *     spreadBps = (ask - bid) / ((ask + bid) / 2) * 10_000
 *
 * Dividing by the ask makes the figure depend on which side you divided by, so
 * two venues quoting the same absolute range score differently. The mid is
 * symmetric.
 *
 * ## Why the grouping is (venue, pair) and not venue
 *
 * XLM/USDC and XLM/EURC on the same venue are different books at different
 * price scales. Collapsing them into one "venue spread" would take the min and
 * max across two unrelated scales and report the gap between them — a number
 * that is not merely imprecise but meaningless.
 */
export async function registerSpreadsRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { window?: string; network?: string }
  }>('/spreads/:asset', { config: { scope: 'read:prices' } }, async (req, reply) => {
    const { asset } = req.params

    if (!asset) {
      return reply.status(400).send(apiError('missing_parameter', 'Asset parameter is required'))
    }

    try {
      return await computeSpreads(asset, req.query.window, req.query.network)
    } catch (err) {
      if (err instanceof SpreadsInputError) {
        return reply.status(400).send(apiError('invalid_parameter', err.message))
      }
      return sendInternalError(reply, req, err, 'Spread aggregation failed')
    }
  })
}

/** A caller-facing validation failure: REST answers it with a 400, GraphQL with INVALID_INPUT. */
export class SpreadsInputError extends Error {
  constructor(readonly field: 'window' | 'network', message: string) {
    super(message)
    this.name = 'SpreadsInputError'
  }
}

export interface SpreadsResult {
  asset: string
  network: NetworkName
  window: string
  startTime: string
  endTime: string
  venues: VenueSpread[]
  tightest: VenueSpread | null
}

/**
 * The spread computation behind `GET /spreads/:asset`, shared with the GraphQL
 * `spreads` query so the two cannot drift. See {@link registerSpreadsRoutes}
 * for what the numbers mean. Throws {@link SpreadsInputError} for a bad
 * `window` or `network`; any other error is an internal failure.
 */
export async function computeSpreads(
  asset: string,
  windowParam: string | undefined,
  networkParam: string | undefined,
): Promise<SpreadsResult> {
  const window = windowParam ?? '5m'

  if (!(window in WINDOW_MINUTES)) {
    throw new SpreadsInputError('window', `window must be one of: ${WINDOWS.join(', ')}`)
  }

  // Prices from two chains are not comparable, and a spread computed across
  // both is not a wide spread — it is a meaningless one. Default to this
  // process's own network rather than silently pooling them.
  const requested = networkParam
  if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
    throw new SpreadsInputError('network', 'network must be one of: testnet, mainnet')
  }
  const network: NetworkName = (requested as NetworkName) ?? activeNetwork

  const minutes = WINDOW_MINUTES[window as SpreadWindow]
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - minutes * 60 * 1000)

  const { rows } = await pgPool.query(
    `SELECT source,
            pair_key,
            MIN(price)::numeric   AS bid,
            MAX(price)::numeric   AS ask,
            COUNT(*)::int         AS observations,
            MAX(COALESCE(observed_at, timestamp)) AS last_seen
       FROM price_points
      WHERE (asset_a = $1 OR asset_b = $1)
        AND network = $2
        AND COALESCE(observed_at, timestamp) >= $3
      GROUP BY source, pair_key`,
    [asset, network, startTime],
  )

  const venues: VenueSpread[] = []

  for (const row of rows) {
    const bid = parseFloat(row.bid)
    const ask = parseFloat(row.ask)
    const observations = Number(row.observations) || 0

    // A single print has a zero range by construction, which would report a
    // perfect 0 bps spread and beat every real venue for "tightest". One
    // observation is not evidence of liquidity.
    if (observations < MIN_OBSERVATIONS) continue
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue

    const mid = (ask + bid) / 2
    if (mid <= 0) continue

    venues.push({
      venue: row.source,
      pairKey: row.pair_key,
      bid,
      ask,
      mid,
      spreadBps: ((ask - bid) / mid) * 10_000,
      spreadPct: ((ask - bid) / mid) * 100,
      observations,
      lastSeen: new Date(row.last_seen).toISOString(),
    })
  }

  venues.sort((a, b) => a.spreadBps - b.spreadBps)

  return {
    asset,
    network,
    window,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    // Per venue-and-pair, tightest first.
    venues,
    // The tightest quote available anywhere in the window, or null when no
    // venue quoted this asset. Null rather than a zeroed object: "nobody
    // quoted it" and "the spread is zero" must not look alike.
    tightest: venues[0] ?? null,
  }
}
