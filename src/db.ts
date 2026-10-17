import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import { createHash } from 'node:crypto'
import { db_query_duration_seconds } from './metrics'
import { config, type NetworkName } from './config'

// Prisma for schema management + simple queries
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// Raw pg pool for time-series queries (VWAP, aggregates)
// ssl: true with rejectUnauthorized: false is required for Supabase pgbouncer
// (their pooler uses a self-signed cert in the chain — this is safe for Supabase specifically)
export const pgPool = new Pool({
  connectionString: config.db.url,
  ssl: config.db.url.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
})

// Instrument raw pg queries
const originalQuery = pgPool.query.bind(pgPool)
pgPool.query = (async (...args: any[]) => {
  const end = db_query_duration_seconds.startTimer()
  try {
    return await (originalQuery as any)(...args)
  } finally {
    end()
  }
}) as any

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
  assetA: string; assetB: string; pairKey: string; source: string
  poolId?: string; price: number; baseVolume: number; counterVolume: number
  ledger: number; timestamp: Date; eventId?: string
}[], network: NetworkName): Promise<number> {
  if (points.length === 0) return 0
  const result = await prisma.pricePoint.createMany({
    data: points.map(p => ({
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
      timestamp: p.timestamp,
      eventId: p.eventId || synthesizeEventId(network, p),
    })),
    skipDuplicates: true,
  })
  return result.count
}

/**
 * Deterministic identity for rows whose source has no natural event id
 * (#237): a SHA-256 over the row's own content — the network, source, pair,
 * pool, ledger, observation timestamp and amounts — never a clock read or a
 * random value. Re-submitting the same batch re-derives the same key, so the
 * unique index absorbs it.
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
    ledger: number; timestamp: Date
  },
): string {
  const content = [
    network,
    p.source,
    p.pairKey,
    p.poolId ?? '',
    String(p.ledger),
    p.timestamp.toISOString(),
    String(p.price),
    String(p.baseVolume),
    String(p.counterVolume),
  ].join('|')
  return `${p.source}-synthetic-${createHash('sha256').update(content).digest('hex')}`
}

/**
 * The cursor and the ledger it reached, read in one round trip. Ingesters need
 * both: the cursor resumes pagination, and the ledger is the fallback when a
 * trade's TOID can't be parsed (see ingesters/toid.ts).
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
