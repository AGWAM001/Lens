import { PrismaClient, Prisma } from '@prisma/client'
import { Pool } from 'pg'
import { createHash } from 'node:crypto'
import {
  db_query_duration_seconds,
  db_pool_connections_in_use,
  db_pool_connections_idle,
  db_pool_connections_waiting,
  db_pool_exhaustion_errors_total,
  setPoolMetricsUpdater,
  price_points_accepted_total,
  price_points_quarantined_total,
} from './metrics'
import { config, type NetworkName } from './config'
import { createLogger } from './logger'
import { partitionPricePointsByPlausibility } from './ingest/plausibility'

const log = createLogger('db')

/**
 * ── Connection Pool Arithmetic & Capacity Planning ────────────────────────────
 *
 * Postgres enforces `max_connections` (typically 100 on standard cloud instances,
 * or 20–60 on managed serverless/starter tiers).
 *
 * Each Lens process shares a single connection pool across:
 *   1. HTTP request handlers (Fastify REST, GraphQL, WebSocket queries)
 *   2. Several ingester loops per enabled network (SDEX, AMM, Soroswap, Snapshot, Aquarius)
 *   3. Retention and partition maintenance background workers
 *
 * When running N process instances (e.g., in a container orchestrator or horizontally
 * scaled deployment), the aggregate connection load against Postgres is:
 *
 *   Total Database Connections = Instances × (Pool Size per Instance) + Superuser/Admin headroom
 *
 * With the default `connectionLimit = 10`:
 *   - 1 instance  : 10 connections  (10% of 100 max_connections)
 *   - 3 instances : 30 connections  (30% of 100 max_connections)
 *   - 5 instances : 50 connections  (50% of 100 max_connections)
 *
 * Leaving ample headroom for Postgres background processes (autovacuum, WAL sender)
 * and direct migration connections (`DIRECT_DATABASE_URL`).
 *
 * If `pool_timeout` (acquisition timeout) expires before a connection is leased,
 * requests fail loudly with a distinct pool exhaustion error rather than hanging.
 */

export function buildDatabaseUrl(baseUrl: string, connectionLimit: number, poolTimeoutMs: number): string {
  try {
    const url = new URL(baseUrl)
    url.searchParams.set('connection_limit', connectionLimit.toString())
    // Prisma pool_timeout parameter is configured in seconds
    const poolTimeoutSec = Math.max(1, Math.ceil(poolTimeoutMs / 1000))
    url.searchParams.set('pool_timeout', poolTimeoutSec.toString())
    return url.toString()
  } catch {
    // If URL parsing fails, return as-is
    return baseUrl
  }
}

const configuredDbUrl = buildDatabaseUrl(
  config.db.url,
  config.db.connectionLimit,
  config.db.poolTimeoutMs
)

// Prisma for schema management + simple queries
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  datasourceUrl: configuredDbUrl,
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
;(globalThis as any).__lens_prisma = prisma

// Raw pg pool for time-series queries (VWAP, aggregates)
// ssl: true with rejectUnauthorized: false is required for Supabase pgbouncer
// (their pooler uses a self-signed cert in the chain — this is safe for Supabase specifically)
export const pgPool = new Pool({
  connectionString: config.db.url,
  max: config.db.connectionLimit,
  connectionTimeoutMillis: config.db.poolTimeoutMs,
  ssl: config.db.url.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
})
;(globalThis as any).__lens_pgPool = pgPool

// Instrument raw pg queries
const originalQuery = pgPool.query.bind(pgPool)
pgPool.query = (async (...args: any[]) => {
  const end = db_query_duration_seconds.startTimer()
  try {
    return await (originalQuery as any)(...args)
  } catch (err) {
    if (isPoolExhaustionError(err)) {
      recordPoolExhaustion(err, 'pgPool.query')
    }
    throw err
  } finally {
    end()
  }
}) as any

// Instrument pgPool acquire/error events
pgPool.on('error', (err) => {
  if (isPoolExhaustionError(err)) {
    recordPoolExhaustion(err, 'pgPool.on_error')
  } else {
    log.error({ err }, 'unexpected postgres client error')
  }
})

/**
 * Periodically or on scrape, export pgPool utilisation metrics through prom-client.
 */
export function updatePoolMetrics() {
  const total = pgPool.totalCount
  const idle = pgPool.idleCount
  const waiting = pgPool.waitingCount
  const inUse = Math.max(0, total - idle)

  db_pool_connections_in_use.set(inUse)
  db_pool_connections_idle.set(idle)
  db_pool_connections_waiting.set(waiting)
}

setPoolMetricsUpdater(updatePoolMetrics)

/**
 * Detects whether an error represents database connection pool exhaustion or acquisition timeout.
 */
export function isPoolExhaustionError(err: unknown): boolean {
  if (!err) return false

  // Prisma pool timeout error: P2024
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2024') {
    return true
  }

  const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err)
  if (
    message.includes('Timed out fetching a new connection from the connection pool') ||
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('Connection pool timeout') ||
    message.includes('connection queue is full') ||
    message.includes('timeout expired') ||
    message.includes('remaining connection slots are reserved')
  ) {
    return true
  }

  // pg-pool connection timeout
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ETIMEDOUT'
  ) {
    return true
  }

  return false
}

/**
 * Logs a distinct warning/error and increments the Prometheus pool exhaustion metric.
 */
export function recordPoolExhaustion(err: unknown, source: string = 'database'): void {
  db_pool_exhaustion_errors_total.inc()
  log.error(
    {
      err,
      source,
      inUse: Math.max(0, pgPool.totalCount - pgPool.idleCount),
      waiting: pgPool.waitingCount,
      total: pgPool.totalCount,
      limit: config.db.connectionLimit,
    },
    'database connection pool exhausted: connection acquisition timed out'
  )
}

/**
 * `network` is required rather than defaulting to the active one. Ingesters are
 * started per network (see startSDEXIngester(network) and friends), so a single
 * process runs a testnet and a mainnet loop side by side. Tagging rows from the
 * global STELLAR_NETWORK wrote every mainnet price as testnet, silently blending
 * real prices with a test chain's in one table. A required argument is what
 * stops that reappearing the next time a venue is added.
 *
 * Idempotency (#237): a retried batch or two ingester instances overlapping
 * during a deploy must not store the same observation twice — duplicated
 * trades inflate volume and skew the volume-weighted VWAP. The unique index
 * price_point_identity on (network, source, event_id) makes that impossible at
 * the database level, and `skipDuplicates` turns the write into an idempotent
 * insert (ON CONFLICT DO NOTHING): the replay is absorbed, not errored.
 *
 * The index only catches rows that HAVE an event id — Postgres treats NULLs as
 * distinct in a unique index — so a null eventId would leave a source entirely
 * outside the guarantee. Rather than store nulls, writes to sources with no
 * natural event id get a key synthesized from the row's own content (see
 * synthesizeEventId). Venues with a natural id — SDEX and AMM trades carry the
 * Horizon trade id / TOID — pass it through unchanged, and snapshot venues
 * without one derive theirs from pool state (see venues/amm.ts and
 * venues/soroswap.ts).
 */
export async function upsertPricePoints(points: {
  id?: string
  assetA: string; assetB: string; pairKey: string; source: string
  poolId?: string; price: number; baseVolume: number; counterVolume: number
  ledger: number; observedAt?: Date; sourceTime?: Date | null; timestamp?: Date; eventId?: string
}[], network: NetworkName): Promise<any> {
  if (points.length === 0) return Object.assign(Object(0), { count: 0, acceptedPoints: [], quarantinedPoints: [] })

  const { accepted, quarantined } = await partitionPricePointsByPlausibility(points as any, network)

  let acceptedCount = 0
  if (accepted.length > 0) {
    const result = await prisma.pricePoint.createMany({
      data: accepted.map((p: any) => {
        const observedAt = p.observedAt ?? p.timestamp ?? new Date()
        const sourceTime = p.sourceTime !== undefined ? p.sourceTime : null
        const timestamp = p.timestamp ?? observedAt
        return {
          id: p.id ?? (p.eventId ? `${network}:${p.source}:${p.eventId}` : undefined),
          network,
          assetA: p.assetA,
          assetB: p.assetB,
          pairKey: p.pairKey,
          source: p.source,
          poolId: p.poolId ?? null,
          price: p.price,
          baseVolume: p.baseVolume,
          counterVolume: p.counterVolume,
          ledger: p.ledger,
          timestamp,
          observedAt,
          sourceTime,
          eventId: p.eventId || synthesizeEventId(network, { ...p, timestamp: p.timestamp }),
        }
      }),
      skipDuplicates: true,
    })
    acceptedCount = result.count
    for (const p of accepted) {
      price_points_accepted_total.inc({ source: p.source, network })
    }
  }

  if (quarantined.length > 0) {
    if ((prisma as any).quarantinedPricePoint?.createMany) {
      await (prisma as any).quarantinedPricePoint.createMany({
        data: quarantined.map(q => ({
          network,
          assetA: q.assetA,
          assetB: q.assetB,
          pairKey: q.pairKey,
          source: q.source,
          poolId: q.poolId ?? null,
          price: q.price,
          baseVolume: q.baseVolume,
          counterVolume: q.counterVolume,
          ledger: q.ledger,
          timestamp: q.timestamp,
          eventId: q.eventId ?? null,
          referenceMedian: q.referenceMedian,
          rejectionReason: q.rejectionReason,
          rejectionBound: q.rejectionBound,
          quarantinedAt: q.quarantinedAt,
        })),
      })
    }
    for (const q of quarantined) {
      price_points_quarantined_total.inc({ source: q.source, network })
    }
  }

  return Object.assign(Object(acceptedCount), {
    count: acceptedCount,
    acceptedPoints: accepted,
    quarantinedPoints: quarantined,
  })
}

/**
 * Deterministic identity for rows whose source has no natural event id
 * (#237): a SHA-256 over the row's own content — the network, source, pair,
 * pool, ledger, observation timestamp and amounts — never a clock read or a
 * random value. Re-submitting the same batch re-derives the same key, so the
 * unique index absorbs it.
 *
 * If a row carries no natural eventId and no timestamp (#620), the key is
 * synthesized strictly from the remaining content fields (network, source,
 * pairKey, poolId, ledger, price, baseVolume, counterVolume) with an empty
 * timestamp slot, NEVER from a wall-clock fallback. This ensures replays of
 * rows without temporal anchors remain deterministic and deduplicate correctly.
 *
 * The timestamp used is the one the venue attached to the observation (a
 * trade's ledger close time, a snapshot's poll time), which is part of the
 * row's content, not "now". So two ingester instances that independently poll
 * the same venue at different milliseconds will produce different ids for a
 * snapshot whose timestamp they each stamp at read time — the per-venue keys
 * in venues/amm.ts and venues/soroswap.ts exist precisely to derive from pool
 * STATE (last_modified_ledger / reserves) instead, and sources that only ever
 * flow through here (Aquarius, oracles, future venues) fall back to this
 * content hash, which still makes a replay of the same derived batch
 * idempotent.
 */
export function synthesizeEventId(
  network: NetworkName,
  p: {
    source: string; pairKey: string; poolId?: string
    price: number; baseVolume: number; counterVolume: number
    ledger: number; timestamp?: Date
  },
): string {
  const content = [
    network,
    p.source,
    p.pairKey,
    p.poolId ?? '',
    String(p.ledger),
    p.timestamp ? p.timestamp.toISOString() : '',
    String(p.price),
    String(p.baseVolume),
    String(p.counterVolume),
  ].join('|')
  return `${p.source}-synthetic-${createHash('sha256').update(content).digest('hex')}`
}

/**
 * The cursor and the ledger it reached, read in one round trip. Ingesters need
 * both: the cursor resumes pagination, and the ledger is the fallback when a
 * trade's TOID can't be parsed (see ingest/toid.ts).
 */
export interface IndexerState {
  cursor: string | null
  ledger: number | null
}

export async function getIndexerState(id: string, network: NetworkName): Promise<IndexerState> {
  const state = await prisma.indexerState.findUnique({ where: { network_id: { network, id } } })
  return { cursor: state?.lastCursor ?? null, ledger: state?.lastLedger ?? null }
}

export async function setIndexerCursor(id: string, cursor: string, network: NetworkName, ledger?: number): Promise<void> {
  await prisma.indexerState.upsert({
    where: { network_id: { network, id } },
    create: { id, network, lastCursor: cursor, lastLedger: ledger, lastProcessedAt: new Date() },
    update: { lastCursor: cursor, lastLedger: ledger, lastProcessedAt: new Date() },
  })
}

export interface LendingRateInput {
  poolId: string
  asset: string
  assetAddress?: string
  source?: string
  supplyApy: number
  borrowApy: number
  supplyApr?: number
  borrowApr?: number
  utilization: number
  totalSupply?: number
  totalBorrowed?: number
  reserves?: number
  ledger?: number
  timestamp?: Date
}

export async function insertLendingRates(
  rates: LendingRateInput[],
  network: NetworkName
): Promise<number> {
  if (rates.length === 0) return 0
  const result = await prisma.lendingRate.createMany({
    data: rates.map(r => ({
      network,
      venue: 'blend',
      source: r.source ?? 'blend',
      poolId: r.poolId,
      asset: r.asset,
      assetAddress: r.assetAddress ?? null,
      // supply_rate / borrow_rate are APYs, the figures GET /rates/:asset ranks by.
      supplyRate: r.supplyApy,
      borrowRate: r.borrowApy,
      supplyApr: r.supplyApr ?? null,
      borrowApr: r.borrowApr ?? null,
      utilization: r.utilization,
      totalSupply: r.totalSupply ?? null,
      totalBorrowed: r.totalBorrowed ?? null,
      reserves: r.reserves ?? null,
      ledger: r.ledger ?? 0,
      timestamp: r.timestamp ?? new Date(),
    })),
  })
  return result.count
}

export async function getLatestLendingRates(
  network: NetworkName,
  options?: { asset?: string; poolId?: string; limit?: number }
) {
  const limit = options?.limit ?? 100
  let query = `
    SELECT DISTINCT ON (pool_id, asset)
      id, network, venue, source, pool_id, pool_name, asset, asset_address,
      supply_rate::float AS supply_apy, borrow_rate::float AS borrow_apy,
      supply_apr::float, borrow_apr::float,
      utilization::float, total_supply::float, total_borrowed::float, reserves::float,
      ledger, timestamp
    FROM lending_rates
    WHERE network = $1
  `
  const params: any[] = [network]
  if (options?.asset) {
    params.push(options.asset.toUpperCase())
    query += ` AND UPPER(asset) = $${params.length}`
  }
  if (options?.poolId) {
    params.push(options.poolId)
    query += ` AND pool_id = $${params.length}`
  }
  query += ` ORDER BY pool_id, asset, timestamp DESC LIMIT $${params.length + 1}`
  params.push(limit)

  const result = await pgPool.query(query, params)
  return result.rows
}
