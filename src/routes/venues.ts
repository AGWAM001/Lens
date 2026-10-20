import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { venueAdapters } from '../ingest/venues'
import '../middleware/network'

export const LIVE_WINDOW_MS = 5 * 60 * 1000

export interface RegisteredVenue {
  id: string
  kind: string
  network: NetworkName
  enabled: boolean
  liveness: 'disabled' | 'unknown' | 'live' | 'stale'
  lastSeenAt: string | null
}

export async function registerVenueRoutes(app: FastifyInstance) {
  app.get('/venues/registry', { config: { public: true } }, async req => {
    const network = (req.network ?? activeNetwork) as NetworkName
    const adapters = venueAdapters
    const sources = [...new Set(adapters.map(adapter => adapter.source))]
    const result = sources.length
      ? await pgPool.query(
          `SELECT source, MAX(timestamp) AS last_seen_at
             FROM price_points
            WHERE network = $1 AND source = ANY($2::text[])
            GROUP BY source`,
          [network, sources],
        )
      : { rows: [] as Array<{ source: string; last_seen_at: Date | string }> }

    const lastSeenBySource = new Map<string, Date>(
      result.rows.map(row => [row.source, new Date(row.last_seen_at)]),
    )
    const now = Date.now()

    return {
      network,
      venues: adapters.map((adapter): RegisteredVenue => {
        const enabled = adapter.isEnabled(network)
        const observed = lastSeenBySource.get(adapter.source)
        const liveness = !enabled
          ? 'disabled'
          : !adapter.source
            ? 'unknown'
            : observed && now - observed.getTime() <= LIVE_WINDOW_MS
              ? 'live'
              : 'stale'

        return {
          id: adapter.name,
          kind: adapter.kind ?? 'unknown',
          network,
          enabled,
          liveness,
          lastSeenAt: observed?.toISOString() ?? null,
        }
      }),
    }
  })
}
