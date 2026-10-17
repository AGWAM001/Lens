import 'dotenv/config'
import { execSync } from 'child_process'
if (!process.env.DIRECT_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL
}
import { config, type NetworkName } from './config'
import { getEnabledNetworks } from './network/enabledNetworks'
import { redis } from './redis'
import { pgPool } from './db'
import { buildApp } from './app'
import { fanOutManager } from './ws/fanout'

import { venueAdapters, startVenueAdapter } from './ingest/venues'
import { startSnapshotIngester } from './ingesters/snapshot'
import { createAggregateQueue, startAggregateWorker, scheduleAggregateRefresh } from './jobs/aggregateRefresh'
import { createSnapshotRetentionQueue, startSnapshotRetentionWorker, scheduleSnapshotRetention, pruneAllNetworks, SNAPSHOT_RETENTION_DAYS } from './jobs/snapshotRetention'
import { loadPersistedPairs, getActivePairs } from './pairsRegistry'

import { ingesterRestarts, recordIngesterCrash } from './metrics'

async function main() {
  // ── Ensure DB schema is up-to-date ────────────────────────────────────────
  console.log('[lens] Running database migrations…')
  execSync('node node_modules/prisma/build/index.js db push --accept-data-loss', { stdio: 'inherit' })
  console.log('[lens] Database ready.')

  // ── Connect dependencies ──────────────────────────────────────────────────
  // Redis is a cache and a job broker, not a source of truth: reads fall back
  // to Postgres (see getCachedPrice), writes are best-effort, and all three
  // background workers below are already registered inside their own try/catch
  // for exactly this case. Connecting eagerly is still worth doing so a
  // healthy deploy fails fast and loudly if the URL is wrong — but letting the
  // rejection escape turned a dead cache into a dead API, and the process
  // exited before ever reaching app.listen(). Prices stay served from the
  // database, uncached, until Redis comes back.
  try {
    await redis.connect()
    console.log('[lens] Redis connected')
  } catch (err) {
    console.warn(
      '[lens] Redis unavailable, continuing without cache:',
      (err as Error).message,
    )
  }

  await pgPool.connect()
  console.log('[lens] PostgreSQL connected')

  // ── Load persisted runtime pairs ──────────────────────────────────────────
  await loadPersistedPairs()

  // ── Fastify API server ────────────────────────────────────────────────────
  // All plugin and route wiring lives in buildApp() (src/app.ts) so tests can
  // boot the exact same route surface without the connections and background
  // workers started below.
  const app = await buildApp()

  await app.listen({ port: config.api.port, host: config.api.host })
  console.log(`[lens] API listening on http://${config.api.host}:${config.api.port}`)
  console.log(`[lens] GraphiQL at http://localhost:${config.api.port}/graphiql`)

  // ── WebSocket fan-out (non-blocking — requires Redis for multi-instance) ─
  try {
    await fanOutManager.initialize()
    console.log('[lens] WebSocket fan-out manager initialized')
  } catch (err) {
    console.warn('[lens] WebSocket fan-out init skipped:', (err as Error).message)
  }

  // ── Aggregate refresh worker (non-blocking — requires Redis) ─────────────
  // BullMQ opens its own ioredis connections, separate from ./redis and
  // without our error handler on them. If scheduling fails they are still
  // live, reconnecting forever and logging "[ioredis] Unhandled error event"
  // on every attempt — so close whatever got created before giving up.
  //
  // One queue + worker per enabled network: a single pair of them would only
  // ever write price_aggregates for whichever network it was pinned to, and
  // /price/*/history and /screener would stay empty for the other.
  {
    const started: NetworkName[] = []
    for (const network of getEnabledNetworks()) {
      let queue: ReturnType<typeof createAggregateQueue> | undefined
      let worker: ReturnType<typeof startAggregateWorker> | undefined
      try {
        queue = createAggregateQueue(network)
        worker = startAggregateWorker(network)
        await scheduleAggregateRefresh(queue, network)
        started.push(network)
      } catch (err) {
        console.warn(`[lens] Aggregate refresh worker skipped for ${network} (Redis unavailable):`, (err as Error).message)
        await Promise.allSettled([queue?.close(), worker?.close()])
      }
    }
    if (started.length > 0) {
      console.log(`[lens] Aggregate refresh worker started for network(s): ${started.join(', ')}`)
    }
  }

  // ── Snapshot retention ────────────────────────────────────────────────────
  // price_snapshots is append-only and unbounded, so pruning it is a data
  // lifecycle concern, not a caching one. BullMQ is only how the prune gets
  // scheduled — losing Redis must not mean losing retention, because the
  // failure is silent and the bill arrives as a full disk weeks later.
  //
  // So: prune once here, unconditionally, then try to install the hourly
  // schedule. If Redis is away, fall back to a plain timer that does the same
  // work in-process.
  const safePrune = async () => {
    try {
      const counts = await pruneAllNetworks()
      for (const [network, pruned] of Object.entries(counts)) {
        if (pruned > 0) {
          console.log(`[lens] Pruned ${pruned} ${network} snapshot(s) older than ${SNAPSHOT_RETENTION_DAYS}d`)
        }
      }
    } catch (err) {
      console.error('[lens] Snapshot prune failed:', (err as Error).message)
    }
  }

  await safePrune()

  {
    let retentionQueue: ReturnType<typeof createSnapshotRetentionQueue> | undefined
    let retentionWorker: ReturnType<typeof startSnapshotRetentionWorker> | undefined
    try {
      retentionQueue = createSnapshotRetentionQueue()
      retentionWorker = startSnapshotRetentionWorker()
      await scheduleSnapshotRetention(retentionQueue)
      console.log('[lens] Snapshot retention worker started')
    } catch (err) {
      console.warn('[lens] Snapshot retention worker skipped (Redis unavailable):', (err as Error).message)
      console.warn('[lens] Falling back to an in-process hourly prune')
      await Promise.allSettled([retentionQueue?.close(), retentionWorker?.close()])
      setInterval(() => { void safePrune() }, 60 * 60 * 1000).unref()
    }
  }

  // ── Ingesters (run in background — infinite loops) ────────────────────────
  // Each ingester is independently fault-isolated via restartIngester, keyed by
  // the (venue, network) pair: a crash in, say, the Soroswap ingester on
  // mainnet only restarts that one instance and cannot affect SDEX/AMM or the
  // ingesters running on testnet.
  //
  // A crash-looping ingester must not be invisible: restarts are counted in a
  // Prometheus counter, the last crash is recorded for /status, and the delay
  // grows exponentially (capped) so a permanently broken venue stops hammering
  // its upstream every ten seconds. The backoff resets once an ingester has
  // stayed up for HEALTHY_RUN_MS, so a nightly blip does not permanently slow
  // restarts.
  const BASE_RESTART_DELAY_MS = 10_000
  const MAX_RESTART_DELAY_MS = 5 * 60_000
  const HEALTHY_RUN_MS = 5 * 60_000

  const restartIngester = (
    name: string,
    network: NetworkName,
    fn: () => Promise<void>,
    attempt = 0,
  ) => {
    const startedAt = Date.now()
    fn().catch(err => {
      const message = err instanceof Error ? err.message : String(err)
      const delay = Math.min(BASE_RESTART_DELAY_MS * 2 ** attempt, MAX_RESTART_DELAY_MS)
      const nextAttempt = Date.now() - startedAt >= HEALTHY_RUN_MS ? 0 : attempt + 1

      ingesterRestarts.inc({ ingester: name, network })
      recordIngesterCrash(name, network, message)

      console.error(
        `[lens] ${name}/${network} ingester crashed, restarting in ${Math.round(delay / 1000)}s:`,
        message,
      )
      setTimeout(() => restartIngester(name, network, fn, nextAttempt), delay)
    })
  }

  const enabledNetworks = getEnabledNetworks()
  console.log(`[lens] Starting ingesters for network(s): ${enabledNetworks.join(', ')}`)
  for (const network of enabledNetworks) {
    for (const adapter of venueAdapters) {
      restartIngester(adapter.name, network, () => startVenueAdapter(adapter, network))
    }
    restartIngester('Snapshot', network, () => startSnapshotIngester(network))
  }

  console.log(`[lens] Watching ${getActivePairs().length} pairs: ${getActivePairs().map(p => p.pairKey).join(', ')}`)
}

main().catch(err => {
  console.error('[lens] Fatal startup error:', err)
  process.exit(1)
})