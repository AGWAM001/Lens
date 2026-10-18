import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getActivePairs } from '../pairsRegistry'
import { price_snapshots_total } from '../metrics'
import { createLogger } from '../logger'

const log = createLogger('ingester:snapshot')

/**
 * Floors a Date down to the start of its minute (seconds/millis zeroed).
 * The snapshot `ts` is always minute-aligned so the (pair, ts) primary key
 * makes the append idempotent — a duplicate run within the same minute (e.g.
 * after a restart) collides on the PK and is skipped rather than double-counted.
 */
export function floorToMinute(date: Date): Date {
  const d = new Date(date)
  d.setSeconds(0, 0)
  return d
}

/**
 * Appends one price_snapshots row per active pair for the given minute.
 *
 * For each pair we take the most recent price seen in price_points and the
 * total base_volume traded during the minute that just closed. Pairs with no
 * price history yet are skipped (we don't fabricate a price). Returns the
 * number of rows inserted.
 *
 * Snapshot rows are network-scoped (the `(network, pair, ts)` primary key), so
 * `network` selects both which `price_points` are read and which network the
 * inserted `price_snapshots` rows are tagged with.
 */
export async function appendSnapshots(
  now: Date = new Date(),
  network: NetworkName = activeNetwork,
): Promise<number> {
  const pairs = getActivePairs()
  if (pairs.length === 0) return 0

  const ts = floorToMinute(now)
  const pairKeys = pairs.map(p => p.pairKey)

  // One query for all pairs: latest price (most recent point) joined with the
  // volume traded in the [ts, ts+1min) window. LEFT JOIN so a pair with a known
  // price but no trades this minute still snapshots with volume 0.
  const result = await pgPool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (pair_key) pair_key, price::numeric AS price
       FROM price_points
       WHERE pair_key = ANY($1) AND network = $3
       ORDER BY pair_key, timestamp DESC
     ),
     vol AS (
       SELECT pair_key, SUM(base_volume::numeric) AS volume
       FROM price_points
       WHERE pair_key = ANY($1) AND network = $3
         AND timestamp >= $2
         AND timestamp < $2 + INTERVAL '1 minute'
       GROUP BY pair_key
     )
     INSERT INTO price_snapshots (network, pair, ts, price, volume)
     SELECT $3, l.pair_key, $2, l.price, COALESCE(v.volume, 0)
     FROM latest l
     LEFT JOIN vol v ON v.pair_key = l.pair_key
     ON CONFLICT (network, pair, ts) DO NOTHING`,
    [pairKeys, ts, network]
  )

  const inserted = result.rowCount ?? 0
  if (inserted > 0) price_snapshots_total.inc({ network }, inserted)
  return inserted
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Background loop: appends snapshots at the top of every minute. Aligns to the
 * wall-clock minute boundary so snapshot timestamps land on :00 seconds and the
 * volume window cleanly covers the minute that just elapsed.
 */
export async function startSnapshotIngester(network: NetworkName = activeNetwork): Promise<void> {
  log.info({ network, pairs: getActivePairs().length }, 'starting 1-minute snapshot ingester')

  while (true) {
    // Sleep until the next minute boundary.
    const msToNextMinute = 60_000 - (Date.now() % 60_000)
    await sleep(msToNextMinute)

    try {
      const n = await appendSnapshots(new Date(), network)
      if (n > 0) log.info({ network, snapshots: n }, 'appended snapshots')
    } catch (err) {
      log.error({ network, err }, 'error appending snapshots')
    }
  }
}
