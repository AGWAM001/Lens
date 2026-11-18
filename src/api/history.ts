import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import {
  HISTORY_DEFAULT_LIMIT,
  decodeCursor,
  encodeCursor,
  parseLimit,
  slicePage,
} from '../pagination'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { findOverlappingGaps } from '../backfill/gaps'
import { formatPrice, formatVolume } from '../pricing/precision'

import { apiError } from '../errors'
/** Supported aggregation intervals → bucket width in seconds. */
export const HISTORY_INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '1h': 3600,
}

/** Maximum number of buckets a single request may return. */
export const MAX_HISTORY_POINTS = 10_000

export interface HistoryPoint {
  ts: string
  price: number
  volume: number
}

/** Fixed column order of the CSV export. Downstream parsers key on this. */
export const HISTORY_CSV_COLUMNS = ['ts', 'price', 'volume'] as const

/**
 * Escape one CSV field per RFC 4180: quote when it contains a comma, a
 * double quote, CR or LF, and double any embedded quotes.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Format a number for the CSV export.
 *
 * `String(n)` is locale-independent (unlike toFixed/toLocaleString), so the
 * same value always renders identically — that byte-stability is what
 * tests/historical.golden.test.ts locks down. Non-finite values are rejected
 * rather than emitted as `NaN`/`Infinity`, which would silently poison a
 * downstream analytics import.
 */
function csvNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`historyToCsv: non-finite number (${String(n)}) cannot be exported`)
  }
  return String(n)
}

/**
 * Render history points as CSV: a `ts,price,volume` header row, one row per
 * point in input order, LF line endings and a trailing newline.
 *
 * Pure and deterministic — no clock, locale, or randomness — so a given set
 * of points always produces byte-identical output. The golden fixtures under
 * tests/fixtures/historical-*.csv are byte-compared against this, so any change
 * to the column order, number formatting, quoting or line endings fails the
 * suite instead of silently shifting the contract downstream consumers parse.
 */
export function historyToCsv(points: HistoryPoint[]): string {
  const lines = [HISTORY_CSV_COLUMNS.join(',')]
  for (const p of points) {
    lines.push([csvField(p.ts), csvNumber(p.price), csvNumber(p.volume)].join(','))
  }
  return lines.join('\n') + '\n'
}

/**
 * Aggregates 1-minute price snapshots into `intervalSecs`-wide buckets.
 *
 * Each bucket reports the close price (the last snapshot whose ts falls in the
 * bucket) and the summed volume. Buckets are aligned to the Unix epoch so that
 * e.g. a 1h bucket always starts on the hour, independent of the query window.
 * With intervalSecs=60 this returns the raw snapshots unchanged.
 *
 * `opts.afterTs` applies a keyset predicate — only buckets strictly after that
 * timestamp are returned (used by the cursor). `opts.limit` caps the number of
 * buckets after grouping and ordering; callers doing limit+1 probing pass
 * `limit + 1` and trim the extra row themselves.
 */
export async function queryHistory(
  pair: string,
  from: Date,
  to: Date,
  intervalSecs: number,
  network: NetworkName,
  opts?: { afterTs?: Date; limit?: number }
): Promise<HistoryPoint[]> {
  const params: unknown[] = [intervalSecs, pair, from, to, network]
  let cursorCondition = ''
  if (opts?.afterTs) {
    params.push(opts.afterTs)
    cursorCondition = ` AND ts > $${params.length}`
  }
  let limitClause = ''
  if (opts?.limit !== undefined) {
    params.push(opts.limit)
    limitClause = ` LIMIT $${params.length}`
  }

  const result = await pgPool.query(
    `SELECT
       to_timestamp(floor(EXTRACT(EPOCH FROM ts) / $1) * $1) AS bucket,
       (array_agg(price ORDER BY ts DESC))[1] AS price,
       SUM(volume) AS volume
     FROM price_snapshots
     WHERE pair = $2 AND network = $5
       AND ts >= $3
       AND ts < $4${cursorCondition}
     GROUP BY floor(EXTRACT(EPOCH FROM ts) / $1)
     ORDER BY bucket ASC${limitClause}`,
    params
  )

  return result.rows.map(r => ({
    ts: new Date(r.bucket).toISOString(),
    price: formatPrice(r.price) ?? 0,
    volume: formatVolume(r.volume),
  }))
}

/**
 * GET /prices/history?pair=XLM/USDC&from=…&to=…&interval=1m|5m|1h
 *
 * Returns historical price snapshots for a pair over the half-open window
 * [from, to) — `from` inclusive, `to` exclusive — optionally aggregated into 5m
 * or 1h buckets. Defaults to the last 24h at 1m resolution.
 *
 * The network is resolved by the network selector (`?network=` / `x-network`,
 * defaulting to this deployment's active network) and echoed in the response.
 *
 * Note: this path is NOT gated by x402. It used to be, by accident — the old
 * gate matched `req.url.startsWith('/price')`, which swept up `/prices/...`
 * along with `/pricing` and `/poolsize`. Since #190 the gate matches the routed
 * path at a segment boundary, so `/prices/history` is free. Adding it to
 * GATED_ROUTES in src/middleware/x402.ts is a deliberate decision, not a
 * side effect.
 */
export async function registerHistoryRoutes(app: FastifyInstance) {
  // GET /prices/history?pair=…&from=…&to=…&interval=1m|5m|1h&cursor=&limit=
  //
  // Paginated keyset-style on the bucket start time ASC (default limit 1000,
  // max MAX_HISTORY_POINTS). The cursor carries the last page's bucket ts as
  // an ISO string (the tiebreaker id is the pair, kept so every route emits
  // the same cursor shape), and the keyset predicate is applied in the WHERE
  // clause before grouping, so a snapshot inserted mid-paging cannot shift a
  // page boundary the way an offset would.
  app.get<{
    Querystring: { pair?: string; from?: string; to?: string; interval?: string; format?: string; cursor?: string; limit?: string }
  }>('/prices/history', { config: { scope: 'read:history' } }, async (req, reply) => {
    const { pair } = req.query
    if (!pair) {
      return reply.status(400).send(apiError('missing_parameter', 'pair query parameter is required'))
    }

    // Validated before the DB round-trip so an unknown format never queries.
    const format = req.query.format ?? 'json'
    if (format !== 'json' && format !== 'csv') {
      return reply.status(400).send(apiError('invalid_parameter', 'format must be one of: json, csv'))
    }

    const interval = req.query.interval ?? '1m'
    const intervalSecs = HISTORY_INTERVAL_SECONDS[interval]
    if (!intervalSecs) {
      return reply.status(400).send({
        ...apiError('bad_interval', `interval must be one of: ${Object.keys(HISTORY_INTERVAL_SECONDS).join(', ')}`),
      })
    }

    const parsedLimit = parseLimit(req.query.limit, HISTORY_DEFAULT_LIMIT, MAX_HISTORY_POINTS)
    if ('error' in parsedLimit) {
      return reply.status(400).send(apiError('invalid_parameter', parsedLimit.error))
    }
    const { limit } = parsedLimit

    let afterTs: Date | undefined
    if (req.query.cursor) {
      const decoded = decodeCursor(req.query.cursor)
      if (decoded === null) {
        return reply.status(400).send(apiError('invalid_parameter', 'Invalid cursor format'))
      }
      if (decoded !== 'skip') {
        afterTs = new Date(String(decoded.value))
        if (isNaN(afterTs.getTime())) {
          return reply.status(400).send(apiError('invalid_parameter', 'Invalid cursor format'))
        }
      }
    }

    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to = req.query.to ? new Date(req.query.to) : new Date()

    if (isNaN(from.getTime())) {
      return reply.status(400).send(apiError('invalid_parameter', 'from must be a valid ISO 8601 date'))
    }
    if (isNaN(to.getTime())) {
      return reply.status(400).send(apiError('invalid_parameter', 'to must be a valid ISO 8601 date'))
    }
    if (from.getTime() > to.getTime()) {
      return reply.status(400).send(apiError('invalid_parameter', 'from must be before to'))
    }

    // Guard against unbounded scans: cap the number of buckets the window can produce.
    const spanSecs = (to.getTime() - from.getTime()) / 1000
    if (spanSecs / intervalSecs > MAX_HISTORY_POINTS) {
      return reply.status(400).send({
        ...apiError('invalid_parameter', `requested window is too large for interval=${interval} (max ${MAX_HISTORY_POINTS} points); narrow the range or use a coarser interval`),
      })
    }

    const network = req.network ?? activeNetwork
    const points = await queryHistory(pair, from, to, intervalSecs, network, {
      afterTs,
      limit: limit + 1, // Fetch one extra bucket to determine hasMore
    })
    const { data, hasMore } = slicePage(points, limit)
    const last = hasMore && data.length > 0 ? data[data.length - 1] : null
    const nextCursor = last ? encodeCursor(last.ts, pair) : null

    const overlappingGaps = await findOverlappingGaps({
      network,
      pair,
      start: from,
      end: to,
    })

    const gapDeclaration = overlappingGaps.length > 0 ? { incomplete: true, gaps: overlappingGaps } : {}

    if (format === 'csv') {
      // Deliberately no response schema here: Fastify's JSON serializer must
      // not touch this body. charset=utf8 keeps the bytes the golden test pins.
      // The pagination envelope travels in headers so the CSV body stays the
      // pure `ts,price,volume` contract downstream parsers key on.
      reply.header('X-Has-More', String(hasMore))
      if (nextCursor) reply.header('X-Next-Cursor', nextCursor)
      return reply.type('text/csv; charset=utf-8').send(historyToCsv(data))
    }

    return {
      pair,
      network,
      interval,
      from: from.toISOString(),
      to: to.toISOString(),
      count: data.length,
      points: data,
      nextCursor,
      hasMore,
      ...gapDeclaration,
    }
  })
}
