/**
 * Liveness and readiness.
 *
 * These answer two different questions and conflating them is what makes a
 * platform restart healthy processes:
 *
 *  - **liveness** (`/live`) — is this process wedged and in need of a kill? It
 *    must not touch Postgres or Redis. If it did, a database blip would fail
 *    liveness on every instance at once and the orchestrator would restart the
 *    entire fleet, turning a dependency outage into a cold-start storm.
 *  - **readiness** (`/ready`) — should this process receive traffic yet? It must
 *    reflect real dependencies and real boot state.
 *
 * The boot state matters because `app.listen()` happens part-way through
 * `main()` (src/index.ts), before the ingesters, the retention worker and the
 * websocket fan-out have started. Between listening and those loops running the
 * process answers requests but cannot actually serve prices, so readiness has
 * to stay false until the boot sequence finishes.
 */
import { pgPool } from './db'
import { redis } from './redis'
import { createLogger } from './logger'

const log = createLogger('health')

// ─── Boot state ───────────────────────────────────────────────────────────────

let bootComplete = false

/**
 * Marks the process as having finished booting.
 *
 * Called once at the end of `main()`, after the ingesters are running. Until
 * then `/ready` reports unhealthy — see the module comment for why the server
 * being able to accept a connection is not the same as being able to serve.
 */
export function markBootComplete(): void {
  if (!bootComplete) log.info('boot complete — reporting ready')
  bootComplete = true
}

/** Whether the boot sequence has finished. False until `markBootComplete()`. */
export function isBootComplete(): boolean {
  return bootComplete
}

// ─── Probe configuration ──────────────────────────────────────────────────────

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback
}

/**
 * How long a single dependency probe may take before it is called down.
 *
 * The house pattern for an outbound deadline is `AbortSignal.timeout` (see
 * src/alerts/delivery.ts), but `pg` has no per-query abort, and a probe is the
 * one place a ten-second deadline is too generous: the platform polls it every
 * few seconds, and a probe slower than its own poll interval reports stale
 * answers. `node-postgres` exposes no AbortSignal on `query()`, so the bound is
 * applied by racing instead — see {@link withTimeout}.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000
const DEFAULT_CACHE_TTL_MS = 2_000

/**
 * Read per call rather than once at import, so a test can vary the deadline
 * and the environment stays the single source of truth for configuration.
 */
function probeTimeoutMs(): number {
  return envMs('READINESS_TIMEOUT_MS', DEFAULT_PROBE_TIMEOUT_MS)
}

/**
 * How long a readiness answer is reused before the dependencies are re-probed.
 *
 * Both probes are round trips, and a platform may poll several endpoints at
 * once. Without this, every poll opens a connection during exactly the window
 * where connections are hardest to get — and a probe that times out cannot
 * cancel its underlying query, so a slow database would leave one stuck query
 * per poll accumulating against the pool. Caching bounds that to one in flight
 * per interval.
 */
function cacheTtlMs(): number {
  return envMs('READINESS_CACHE_MS', DEFAULT_CACHE_TTL_MS)
}

/** Whether Redis is part of readiness. See {@link checkReadiness}. */
function redisCheckEnabled(): boolean {
  return process.env.READINESS_REDIS_CHECK !== 'false'
}

// ─── Result shapes ────────────────────────────────────────────────────────────

export type DependencyStatus = 'up' | 'down' | 'skipped'

export interface DependencyCheck {
  status: DependencyStatus
  /** Round-trip time of the probe in milliseconds. */
  latencyMs: number
  /**
   * Why a dependency is down or skipped, as a fixed phrase.
   *
   * Deliberately not the raw error: a connection error carries the host and
   * port, and this is a public endpoint. The underlying error is logged with
   * its full detail instead.
   */
  reason: string | null
}

export interface ReadinessReport {
  /** True only when boot finished and every checked dependency is up. */
  ok: boolean
  /** False while the boot sequence is still running. */
  booted: boolean
  checks: {
    postgres: DependencyCheck
    redis: DependencyCheck
  }
  /** ISO timestamp of when the underlying probes actually ran. */
  checkedAt: string
}

/**
 * Races `work` against a deadline.
 *
 * `node-postgres` has no AbortSignal on `query()`, so the query itself cannot be
 * cancelled — it is left to fail on its own and its connection is reclaimed by
 * the pool. What the race does guarantee is that the *probe* returns promptly,
 * which is what keeps a wedged database from turning into an unbounded pile of
 * hung requests; {@link cacheTtlMs} bounds how many can be outstanding.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} probe timed out after ${ms}ms`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const SKIPPED: DependencyCheck = { status: 'skipped', latencyMs: 0, reason: 'not part of readiness' }

/**
 * Postgres: reachable *and* migrated.
 *
 * `to_regclass` answers both in one cheap query — the server is only reachable
 * if it executed anything at all, and a non-null result means the schema this
 * process queries actually exists. Checking connectivity alone would report a
 * process with no tables as ready, and every route that reads a table fails.
 *
 * `indexer_state` is the table `/status` itself reads, so it is the exact
 * dependency whose absence makes this service unable to answer.
 */
async function checkPostgres(): Promise<DependencyCheck> {
  const startedAt = Date.now()
  try {
    const result = await withTimeout(
      pgPool.query("SELECT to_regclass('public.indexer_state') IS NOT NULL AS migrated"),
      probeTimeoutMs(),
      'postgres',
    )
    // The query succeeding only proves reachability. The flag is what proves
    // the schema is there, and without it a reachable-but-unmigrated instance
    // would be sent traffic it cannot answer.
    if (result?.rows?.[0]?.migrated !== true) {
      log.warn('readiness: postgres reachable but indexer_state is missing — migrations not applied')
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        reason: 'reachable but not migrated',
      }
    }
    return { status: 'up', latencyMs: Date.now() - startedAt, reason: null }
  } catch (err) {
    log.warn({ err }, 'readiness: postgres probe failed')
    return { status: 'down', latencyMs: Date.now() - startedAt, reason: 'unreachable or not migrated' }
  }
}

/**
 * Redis: a `PING`, which ioredis rejects immediately while disconnected
 * (`enableOfflineQueue: false` in src/redis.ts) rather than queuing.
 */
async function checkRedis(): Promise<DependencyCheck> {
  const startedAt = Date.now()
  try {
    await withTimeout(redis.ping(), probeTimeoutMs(), 'redis')
    return { status: 'up', latencyMs: Date.now() - startedAt, reason: null }
  } catch (err) {
    log.warn({ err }, 'readiness: redis probe failed')
    return { status: 'down', latencyMs: Date.now() - startedAt, reason: 'unreachable' }
  }
}

/**
 * Runs the readiness probes and reports what they found.
 *
 * Redis is included by default because the retention worker and the aggregate
 * refresh queue are Redis-backed and silently stop when it is gone. Set
 * `READINESS_REDIS_CHECK=false` for a deployment that deliberately runs
 * Redis-less: `main()` already treats an unavailable Redis as non-fatal (prices
 * are served uncached from Postgres), so on such a deployment failing readiness
 * would take a perfectly healthy instance out of rotation.
 *
 * Results are cached for {@link cacheTtlMs} and concurrent callers share one
 * in-flight run, so a platform polling every few seconds costs one probe per
 * interval at most.
 */
let cached: { at: number; report: ReadinessReport } | null = null
let inFlight: Promise<ReadinessReport> | null = null

async function runProbes(): Promise<ReadinessReport> {
  const redisChecked = redisCheckEnabled()
  const [postgres, redisCheck] = await Promise.all([
    checkPostgres(),
    redisChecked ? checkRedis() : Promise.resolve(SKIPPED),
  ])

  const checks = { postgres, redis: redisCheck }

  return {
    ok:
      checks.postgres.status === 'up' &&
      (checks.redis.status === 'up' || checks.redis.status === 'skipped'),
    booted: true,
    checks,
    checkedAt: new Date().toISOString(),
  }
}

export async function checkReadiness(): Promise<ReadinessReport> {
  const booted = isBootComplete()

  // Not ready, and no amount of probing will change that: skip the round trips
  // entirely. A starting instance should be cheap to poll.
  if (!booted) {
    return {
      ok: false,
      booted: false,
      checks: { postgres: SKIPPED, redis: SKIPPED },
      checkedAt: new Date().toISOString(),
    }
  }

  if (cached && Date.now() - cached.at < cacheTtlMs()) return cached.report
  if (inFlight) return inFlight

  inFlight = runProbes()
    .then(report => {
      cached = { at: Date.now(), report }
      return report
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/**
 * Test seam: returns the module to its initial state.
 *
 * Boot state is a one-way latch in production — nothing un-readies an instance
 * once it has booted. Tests need the other direction, and need the cache
 * cleared alongside it, or one test's probe result answers the next.
 */
export function resetHealthState(): void {
  bootComplete = false
  cached = null
  inFlight = null
}