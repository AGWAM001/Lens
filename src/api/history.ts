import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type

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
 */
export async function queryHistory(
  pair: string,
  from: Date,
  to: Date,
  intervalSecs: number,
  network: NetworkName
): Promise<HistoryPoint[]> {
  const result = await pgPool.query(
    `SELECT
       to_timestamp(floor(EXTRACT(EPOCH FROM ts) / $1) * $1) AS bucket,
       (array_agg(price::float ORDER BY ts DESC))[1] AS price,
       SUM(volume::float) AS volume
     FROM price_snapshots
     WHERE pair = $2 AND network = $5
       AND ts >= $3
       AND ts <= $4
     GROUP BY floor(EXTRACT(EPOCH FROM ts) / $1)
     ORDER BY bucket ASC`,
    [intervalSecs, pair, from, to, network]
  )

  return result.rows.map(r => ({
    ts: new Date(r.bucket).toISOString(),
    price: Number(r.price),
    volume: Number(r.volume),
  }))
}

/**
 * GET /prices/history?pair=XLM/USDC&from=…&to=…&interval=1m|5m|1h
 *
 * Returns historical price snapshots for a pair over [from, to], optionally
 * aggregated into 5m or 1h buckets. Defaults to the last 24h at 1m resolution.
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
  app.get<{
    Querystring: { pair?: string; from?: string; to?: string; interval?: string; format?: string }
  }>('/prices/history', { config: { scope: 'read:history' } }, async (req, reply) => {
    const { pair } = req.query
    if (!pair) {
      return reply.status(400).send({ error: 'pair query parameter is required' })
    }

    // Validated before the DB round-trip so an unknown format never queries.
    const format = req.query.format ?? 'json'
    if (format !== 'json' && format !== 'csv') {
      return reply.status(400).send({ error: 'format must be one of: json, csv' })
    }

    const interval = req.query.interval ?? '1m'
    const intervalSecs = HISTORY_INTERVAL_SECONDS[interval]
    if (!intervalSecs) {
      return reply.status(400).send({
        error: `interval must be one of: ${Object.keys(HISTORY_INTERVAL_SECONDS).join(', ')}`,
      })
    }

    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to = req.query.to ? new Date(req.query.to) : new Date()

    if (isNaN(from.getTime())) {
      return reply.status(400).send({ error: 'from must be a valid ISO 8601 date' })
    }
    if (isNaN(to.getTime())) {
      return reply.status(400).send({ error: 'to must be a valid ISO 8601 date' })
    }
    if (from.getTime() > to.getTime()) {
      return reply.status(400).send({ error: 'from must be before to' })
    }

    // Guard against unbounded scans: cap the number of buckets the window can produce.
    const spanSecs = (to.getTime() - from.getTime()) / 1000
    if (spanSecs / intervalSecs > MAX_HISTORY_POINTS) {
      return reply.status(400).send({
        error: `requested window is too large for interval=${interval} (max ${MAX_HISTORY_POINTS} points); narrow the range or use a coarser interval`,
      })
    }

    const network = req.network ?? activeNetwork
    const points = await queryHistory(pair, from, to, intervalSecs, network)

    if (format === 'csv') {
      // Deliberately no response schema here: Fastify's JSON serializer must
      // not touch this body. charset=utf8 keeps the bytes the golden test pins.
      return reply.type('text/csv; charset=utf-8').send(historyToCsv(points))
    }

    return {
      pair,
      network,
      interval,
      from: from.toISOString(),
      to: to.toISOString(),
      count: points.length,
      points,
    }
  })
}
