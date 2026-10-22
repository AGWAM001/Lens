import 'dotenv/config'
import { execSync } from 'child_process'

if (!process.env.DIRECT_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL
}
import { config, getNetworkConfig, type NetworkName } from './config'
import { getEnabledNetworks } from './network/enabledNetworks'
import { createLogger } from './logger'
import { redis } from './redis'
import { pgPool } from './db'
import { assertSchemaValid } from './db/schemaVerify'
import { buildApp } from './app'
import { fanOutManager } from './ws/fanout'

import { venueAdapters, startVenueAdapter } from './ingest/venues'
import { startSnapshotIngester } from './ingesters/snapshot'
import { createAggregateQueue, startAggregateWorker, scheduleAggregateRefresh } from './jobs/aggregateRefresh'
import { createSnapshotRetentionQueue, startSnapshotRetentionWorker, scheduleSnapshotRetention, pruneAllNetworks, SNAPSHOT_RETENTION_DAYS } from './jobs/snapshotRetention'
import {
  createPricePointsPartitionQueue,
  startPricePointsPartitionWorker,
  schedulePricePointsPartitionMaintenance,
  runPricePointsMaintenance,
  PRICE_POINTS_RETENTION_DAYS,
} from './jobs/pricePointsPartitionJob'
import { loadPersistedPairs, getActivePairs } from './pairsRegistry'
import { markHealthy, recordCrash } from './ingester/restart'
import { markBootComplete } from './health'
import { startSep40Publisher } from './publish/publisher'

const log = createLogger('startup')

async function main() {
  // ── Ensure DB schema is up-to-date ────────────────────────────────────────
  log.info('running database migrations')
  execSync('node node_modules/prisma/build/index.js db push --accept-data-loss', { stdio: 'inherit' })
  log.info('database ready')

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
    log.info('redis connected')
  } catch (err) {
    log.warn({ err }, 'redis unavailable, continuing without cache')
  }

  await pgPool.connect()
  log.info('postgresql connected')

  // Verify database schema matches expected tables and columns (#352)
  await assertSchemaValid()
  log.info('database schema verified')

  // ── Load persisted runtime pairs ──────────────────────────────────────────
  await loadPersistedPairs()

  // ── Fastify API server ────────────────────────────────────────────────────
  // All plugin and route wiring lives in buildApp() (src/app.ts) so tests can
  // boot the exact same route surface without the connections and background
  // workers started below.
  const app = await buildApp()

  await app.listen({ port: config.api.port, host: config.api.host })
  log.info({ url: `http://${config.api.host}:${config.api.port}` }, 'API listening')
  log.info({ url: `http://localhost:${config.api.port}/graphiql` }, 'GraphiQL available')

  // ── WebSocket fan-out (non-blocking — requires Redis for multi-instance) ─
  try {
    await fanOutManager.initialize()
    log.info('websocket fan-out manager initialized')
  } catch (err) {
    log.warn({ err }, 'websocket fan-out init skipped')
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
        log.warn({ network, err }, 'aggregate refresh worker skipped (redis unavailable)')
        await Promise.allSettled([queue?.close(), worker?.close()])
      }
    }
    if (started.length > 0) {
      log.info({ networks: started }, 'aggregate refresh worker started')
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
          log.info({ network, pruned, retentionDays: SNAPSHOT_RETENTION_DAYS }, 'pruned snapshots older than retention window')
        }
      }
    } catch (err) {
      log.error({ err }, 'snapshot prune failed')
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
      log.info('snapshot retention worker started')
    } catch (err) {
      log.warn({ err }, 'snapshot retention worker skipped (redis unavailable)')
      log.warn('falling back to an in-process hourly prune')
      await Promise.allSettled([retentionQueue?.close(), retentionWorker?.close()])
      setInterval(() => { void safePrune() }, 60 * 60 * 1000).unref()
    }
  }

  // ── Price points partition maintenance & retention ────────────────────────
  // price_points is range-partitioned by timestamp. We pre-create future partitions
  // ahead of need so ingesters never fail on unmapped timestamp ranges. Dropping
  // expired partitions is opt-in via PRICE_POINTS_DROP_EXPIRED=true (default: off)
  // to safeguard raw historical records until rollups are complete (#231).
  const safeMaintainPartitions = async () => {
    try {
      const result = await runPricePointsMaintenance()
      if (result.created.length > 0) {
        log.info({ count: result.created.length }, 'pre-created price_points partitions')
      }
      if (result.dropped.length > 0) {
        log.info(
          { count: result.dropped.length, retentionDays: PRICE_POINTS_RETENTION_DAYS },
          'dropped expired price_points partitions',
        )
      }
    } catch (err) {
      log.error({ err }, 'price_points partition maintenance failed')
    }
  }

  await safeMaintainPartitions()

  {
    let partitionQueue: ReturnType<typeof createPricePointsPartitionQueue> | undefined
    let partitionWorker: ReturnType<typeof startPricePointsPartitionWorker> | undefined
    try {
      partitionQueue = createPricePointsPartitionQueue()
      partitionWorker = startPricePointsPartitionWorker()
      await schedulePricePointsPartitionMaintenance(partitionQueue)
      log.info('price_points partition worker started')
    } catch (err) {
      log.warn({ err }, 'price_points partition worker unavailable; falling back to hourly in-process maintenance')
      await Promise.allSettled([partitionQueue?.close(), partitionWorker?.close()])
      setInterval(() => { void safeMaintainPartitions() }, 60 * 60 * 1000).unref()
    }
  }

  // ── Ingesters (run in background — infinite loops) ────────────────────────
  // Each ingester is independently fault-isolated via restartIngester, keyed by
  // the (venue, network) pair: a crash in, say, the Soroswap ingester on
  // mainnet only restarts that one instance and cannot affect SDEX/AMM or the
  // ingesters running on testnet.
  //
  // A crash-looping ingester must not be invisible: restarts are counted, the
  // delay grows exponentially up to a ceiling, and the last crash is recorded
  // so /status can surface it. A sustained healthy run resets the backoff so a
  // one-off blip does not permanently slow restarts.
  const INGESTER_RESTART_BASE_MS = 10_000
  const INGESTER_RESTART_MAX_MS = 5 * 60_000
  const INGESTER_HEALTHY_RESET_MS = 5 * 60_000

  const restartIngester = (name: string, network: NetworkName, fn: () => Promise<void>) => {
    let healthyTimer: NodeJS.Timeout | undefined

    const run = () => {
      fn().then(() => {
        // fn() resolving means the ingester ran to completion rather than
        // looping forever. Treat that as healthy and reset the backoff.
        if (healthyTimer) clearTimeout(healthyTimer)
        markHealthy(name, network)
      }).catch(err => {
        if (healthyTimer) clearTimeout(healthyTimer)
        const state = recordCrash(name, network, err)

        const delay = Math.min(
          INGESTER_RESTART_BASE_MS * 2 ** (state.failures - 1),
          INGESTER_RESTART_MAX_MS,
        )
        log.error(
          { err, ingester: name, network, failures: state.failures, delayMs: delay },
          'ingester crashed, restarting after backoff',
        )
        setTimeout(run, delay)
      })

      // If the ingester stays up past the healthy threshold, reset the
      // backoff even though fn() has not resolved (infinite loops never do).
      healthyTimer = setTimeout(() => markHealthy(name, network), INGESTER_HEALTHY_RESET_MS)
      healthyTimer.unref()
    }

    run()
  }

  const enabledNetworks = getEnabledNetworks()
  log.info({ networks: enabledNetworks }, 'starting ingesters')
  for (const network of enabledNetworks) {
    for (const adapter of venueAdapters) {
      restartIngester(adapter.name, network, () => startVenueAdapter(adapter, network))
    }
    restartIngester('Snapshot', network, () => startSnapshotIngester(network))

    // The publisher is the one loop in this process that writes to a chain, so
    // it is started on its own per-network switch rather than alongside the
    // readers: an operator who has deployed a feed but has not put a key in the
    // environment gets an explicit "not started", not a crash loop. Same fault
    // isolation as every ingester above.
    if (getNetworkConfig(network).publisher.enabled) {
      restartIngester('SEP-40 Publisher', network, () => startSep40Publisher(network))
    } else {
      log.info({ network }, 'SEP-40 publication disabled; publisher not started')
    }
  }

  log.info(
    { count: getActivePairs().length, pairs: getActivePairs().map(p => p.pairKey) },
    'watching pairs'
  )

  // ── Ready ──────────────────────────────────────────────────────────────────
  // Last, and only once every ingester above is running. `app.listen()` happens
  // part-way through this function, so between listening and here the process
  // accepts requests it cannot yet answer correctly. `/ready` stays unhealthy
  // until this line, which is what keeps a starting instance out of the load
  // balancer without making `/live` fail (a starting process should be held out
  // of rotation, not killed).
  markBootComplete()
}

main().catch(err => {
  log.error({ err }, 'fatal startup error')
  process.exit(1)
})