import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

/**
 * One venue's best offer for the asset. The pool fields say *which* market the
 * rate came from so the number is attributable, never an anonymous average.
 */
interface RateVenue {
  venue: string
  source: string
  /** Pool / market contract id the rate was read from — never elided. */
  pool: string
  /** Human-readable pool name, when the venue publishes one. */
  poolName: string | null
  /** Supply APY as a fraction (0.05 == 5%). */
  supplyRate: number
  /** Borrow APY as a fraction (0.07 == 7%). */
  borrowRate: number
  ledger: number
  updatedAt: string
}

/**
 * Register the lending-rate endpoint.
 *
 * `GET /rates/:asset?network=testnet|mainnet`
 *
 * Answers "what does this asset earn, and what does it cost to borrow, across
 * the lending venues Lens ingests?" — one entry per venue, best (highest supply
 * rate) first, each naming the pool it came from.
 *
 * ## Where the numbers come from
 *
 * Rates are stored per row by the rate ingester (Blend, see L079) in
 * `lending_rates`, each tagged with its `network`, `venue` and `source` and the
 * `poolId` it was read from — the same discipline `price_points` follows. This
 * endpoint reads those rows verbatim and never blends across venues: a "unified"
 * yield that averaged a live market with a dead one would be worse than no
 * number at all, so each venue is reported on its own.
 *
 * ## Why one pool per venue
 *
 * A venue can run several markets for the same asset. For "best yield" the
 * relevant figure per venue is its richest market, so the latest observation for
 * each (venue, pool) is taken and then reduced to the highest-supply pool within
 * each venue before venues are ranked.
 *
 * ## Empty is not missing
 *
 * An asset with no lending market anywhere returns an empty `venues` list with a
 * 200, not a 404: "nobody lends this" is a valid answer, and an empty list is
 * honest in a way a 404 (which reads as "endpoint broken") is not.
 */
export async function registerRateRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { network?: string }
  }>('/rates/:asset', async (req, reply) => {
    const { asset } = req.params
    if (!asset) {
      return reply.status(400).send({ error: 'Asset parameter is required' })
    }
    const assetCode = asset.toUpperCase()

    // Rates on two chains are not comparable, so never pool them. Default to
    // this process's own network and reject anything unrecognised outright
    // rather than silently falling back.
    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = (requested as NetworkName) ?? activeNetwork

    try {
      // Latest observation per (venue, pool), newest first. Reduction to one
      // best pool per venue and the best-first venue ranking happen below in
      // JS so the ordering rule ("richest market per venue, richest venue
      // first") stays a single, testable statement rather than being split
      // across SQL and code.
      const { rows } = await pgPool.query(
        `SELECT DISTINCT ON (venue, pool_id)
                venue,
                source,
                pool_id,
                pool_name,
                supply_rate::numeric AS supply_rate,
                borrow_rate::numeric AS borrow_rate,
                ledger,
                timestamp
           FROM lending_rates
          WHERE asset = $1
            AND network = $2
          ORDER BY venue, pool_id, timestamp DESC`,
        [assetCode, network],
      )

      // Keep the highest-supply pool seen for each venue. Rows arrive grouped
      // by (venue, pool) only, so a venue may span several entries — reduce to
      // its best one.
      const bestByVenue = new Map<string, RateVenue>()
      for (const row of rows) {
        const supplyRate = parseFloat(row.supply_rate)
        const borrowRate = parseFloat(row.borrow_rate)
        if (!Number.isFinite(supplyRate) || !Number.isFinite(borrowRate)) continue

        const venue: RateVenue = {
          venue: row.venue,
          source: row.source,
          pool: row.pool_id,
          poolName: row.pool_name ?? null,
          supplyRate,
          borrowRate,
          ledger: Number(row.ledger) || 0,
          updatedAt: new Date(row.timestamp).toISOString(),
        }

        const existing = bestByVenue.get(venue.venue)
        if (!existing || venue.supplyRate > existing.supplyRate) {
          bestByVenue.set(venue.venue, venue)
        }
      }

      // Best-first: highest supply rate leads, borrow rate breaks ties.
      const venues = [...bestByVenue.values()].sort(
        (a, b) => b.supplyRate - a.supplyRate || a.borrowRate - b.borrowRate,
      )

      return {
        asset: assetCode,
        network,
        // One entry per venue, richest yield first, each naming its pool. Empty
        // when the asset has no lending market — still a 200.
        venues,
        // The single best offer available, or null when nothing lends the
        // asset. Null rather than a zeroed entry so "nobody listed it" and
        // "it yields zero" do not look alike.
        best: venues[0] ?? null,
        count: venues.length,
        computedAt: new Date().toISOString(),
      }
    } catch (err) {
      return reply
        .status(500)
        .send({ error: `Rate lookup failed: ${(err as Error).message}` })
    }
  })
}
