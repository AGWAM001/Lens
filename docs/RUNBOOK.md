# Operations runbook

How Lens actually behaves today: what runs, what breaks when it is unavailable,
how to tell, and what to do. **Every claim here is checkable against the code
at this commit** — the defining file or symbol is named next to each one.
Where the system does the wrong thing, this document says so; it does not
describe an aspirational system.

---

## 1. Processes

### The one process that matters

Lens runs as a **single Node process** (`npm start` → `node dist/index.js`,
`CMD` in `Dockerfile`). Everything below runs inside it — there is no separate
worker, ingester or scheduler process:

| Component | What it does | Where |
|---|---|---|
| HTTP API | REST routes, `/graphql` + GraphiQL, webhooks, x402 facilitator, admin/usage routes | `buildApp()` in `src/app.ts`, routes under `src/api/` and `src/routes/` |
| WebSocket server | `graphql-transport-ws` subscriptions on `/graphql`; local fan-out plus cross-instance fan-out over Redis pub/sub | `src/ws/fanout.ts`, `src/ws/` |
| Venue ingesters | One infinite poll loop per (venue × enabled network) for **SDEX**, **Horizon AMM**, **Soroswap**, **Aquarius** | registry `src/ingest/venues/index.ts`, started in `main()` (`src/index.ts`) via `startVenueAdapter` (`src/ingest/venues/runner.ts`) |
| Snapshot ingester | Appends one `price_snapshots` row per active pair at every minute boundary, per network | `src/ingesters/snapshot.ts` |
| BullMQ workers | `aggregate-refresh` (one queue/worker per network), `snapshot-retention` (hourly), `price_points` partition maintenance (hourly) — **in the same process** | `src/jobs/aggregateRefresh.ts`, `src/jobs/snapshotRetention.ts`, `src/jobs/pricePointsPartitionJob.ts` |
| Webhook dispatcher | Threshold alerts, delivered inline after each ingested price write | `src/webhookDispatcher.ts`, `src/alerts/delivery.ts` |
| Schema auto-migration | `prisma db push --accept-data-loss` runs **at every boot, before the API listens** | `execSync(...)` in `main()` (`src/index.ts`) |
| Middleware | Network selector, API-key auth, per-key/IP rate limits, the per-instance global request ceiling (`GLOBAL_RATE_LIMIT_MAX`, sheds with 503), x402 payment gate, cache policy, HTTP metrics | `src/app.ts` registration order |
| Health probes | `GET /live` (liveness) and `GET /ready` (readiness: boot state + Postgres/Redis), plus `GET /snapshot`, a cached whole-network freshness object | `src/health.ts`, `src/routes/health.ts`, `src/routes/snapshot.ts` — doc: [`docs/health.md`](health.md) |
| Metrics | Prometheus registry exposed on `GET /metrics` | `src/metrics.ts`, route in `src/app.ts` |

**Startup order and failure behaviour** (all in `main()`, `src/index.ts`):

1. `prisma db push --accept-data-loss` — failure throws → `fatal startup error`, exit 1.
2. `redis.connect()` — **soft**: on failure logs `redis unavailable, continuing without cache` and continues.
3. `pgPool.connect()` — **hard**: rejection → `fatal startup error`, exit 1.
4. Load persisted pairs (`loadPersistedPairs()`).
5. `buildApp()` + `app.listen()` — failure (e.g. port in use) → exit 1.
6. `fanOutManager.initialize()` — soft, warn `websocket fan-out init skipped`.
7. Aggregate-refresh worker per enabled network — soft, warn
   `aggregate refresh worker skipped (redis unavailable)`. **No fallback is installed for this one.**
8. Snapshot retention: prune once, then schedule hourly — on Redis failure warn
   `falling back to an in-process hourly prune` and install an in-process `setInterval`.
9. Price-points partition maintenance: same pattern, same in-process hourly fallback.
10. Ingesters started per network through `restartIngester`: a crash is logged
    (`ingester crashed; restarting in 10s`) and restarted after 10 s, isolated
    per `(venue, network)` — one dying ingester does not affect the others.
11. `markBootComplete()` — **last**, and only once every ingester above is
    running: until that line `GET /ready` answers 503, keeping a starting
    instance out of the load balancer (`src/index.ts`, `src/health.ts`).

### Supporting services (`docker-compose.yml`)

| Service | Notes |
|---|---|
| `lens` | Port 3002; `healthcheck: curl -f http://localhost:3002/status`, every 10 s, `start_period: 20s` |
| `postgres` | `postgres:15-alpine`, volume `pgdata`, healthcheck `pg_isready` |
| `redis` | `redis:7-alpine`, `--appendonly yes` (AOF persistence), volume `redisdata` |

### Optional processes (not started by the server)

`examples/oracle-relay`, `examples/alert-bot`, `examples/mcp-server` (stdio),
and `scripts/*` (smoke, seed, key issuance) are run manually via their npm
scripts. Nothing in `src/index.ts` depends on them.

### GitHub Actions

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every PR and push to `main` | `npm ci` → `prisma generate` → `tsc --noEmit` → `npm run build` → `npm test` |
| `release.yml` | push to `main` | changesets: version PR or tag (tag-only release, no npm publish) |
| `openapi-publish.yml` | push to `main` | regenerates `openapi.json`, publishes to `gh-pages` |
| `db-backup.yml` | daily 03:00 UTC | `pg_dump` per network, age-encrypted, 14-day artifact (see §5) |
| `load.yml` | daily 04:00 UTC | k6 load test, p95 < 80 ms @ 5k RPS — **currently red on `main`, see §6** |

---

## 2. External dependencies and what degrades without them

### PostgreSQL — `DATABASE_URL`

**Used for:** everything durable — `price_points`, `price_snapshots`,
`pool_snapshots`, `price_aggregates`, `indexer_state`, pairs, webhooks,
API keys/usage. It is the source of truth; Redis is only a cache
("Redis is a cache and a job broker, not a source of truth" — comment in `src/index.ts`).

| | Behaviour |
|---|---|
| Down at **boot** | `pgPool.connect()` rejects → `fatal startup error` → **process exits 1**. Nothing serves. |
| Down at **runtime** | Queries throw → affected routes return 5xx. `/status` itself queries the DB, so it fails too. |
| Where you see it | `GET /status` refused/500 **and `GET /ready` → 503 with `checks.postgres.status: "down"`** (the probe also asserts the schema exists via `to_regclass('public.indexer_state')`, so a reachable-but-unmigrated database reports not-ready too); `GET /metrics` → `http_requests_total{status_class="5xx"}` rising, `db_query_duration_seconds` tail; pino error logs. |
| Recovery | Restore the nightly dump (`docs/backup-restore.md`, produced by `db-backup.yml`), or re-ingest from chain — Lens data is re-derivable by ingesting again (`docs/DEPLOY_MAINNET.md`). |

### Redis — `REDIS_URL`

**Used for:** the price cache (`getCachedPrice`/`setCachedPrice`, TTL
`PRICE_CACHE_TTL`, default 10 s), BullMQ queues/workers, cross-instance
WebSocket pub/sub.

| | Behaviour |
|---|---|
| Down at **boot** | Soft: `redis unavailable, continuing without cache`. The API still serves — **every cache read falls back to Postgres** (`getCachedPrice` catches and returns `null`), writes are best-effort (swallowed). Per-worker effects: **aggregate refresh is skipped with no fallback**; retention and partition maintenance fall back to hourly in-process timers; ws cross-instance fan-out is skipped. |
| Down at **runtime** | The client rejects commands immediately (`enableOfflineQueue: false`, `src/redis.ts` — no request hangs waiting for a connection), reconnects with backoff capped at 60 s, and logs at most **one `redis connection error` per minute**. Reads keep falling back to Postgres. BullMQ's own connections (separate ioredis instances) log `[ioredis] Unhandled error event` while away and pause the queue-driven jobs. |
| What breaks concretely | • No cache: every `/price` request recomputes from Postgres — correct, just slower.<br>• **`price_aggregates` freeze** if the aggregate-refresh worker is not running (skipped at boot, or paused while BullMQ cannot reach Redis). Consumers: `/price/:assetA/:assetB/history`, `/screener`, and the GraphQL aggregate queries — their buckets stop advancing while `/price/:assetA/:assetB` keeps serving live values (it computes VWAP from `price_points` on a cache miss — `getAggregatedPrice`, `src/aggregator/vwap.ts`).<br>• Multi-instance WebSocket fan-out stops: clients still receive events published by *their own* instance (the local `priceEmitter` subscription always works — `src/ws/fanout.ts`), but not events from other instances.<br>• **Readiness fails**: `GET /ready` PINGs Redis and reports `down` (503) while Redis is away — the instance leaves rotation even though reads still work from Postgres (`READINESS_REDIS_CHECK=false` excludes Redis from readiness). |
| Where you see it | `X-Cache: MISS` on every `/price` response (`src/api/rest.ts`); `/screener` and `/price/.../history` stop moving; `aggregate refresh worker skipped (redis unavailable)` / `redis connection error` in logs; `GET /ready` → 503 with `checks.redis.status: "down"`; `ws_messages_sent_total` low on one instance while ingestion metrics are healthy. **`GET /metrics` has no Redis gauge** — the cache signal is the `X-Cache` response header, the readiness signal is `/ready`. |
| Note on #345 | The issue title says Redis is "noticed once and never again"; today's code reconnects forever with capped backoff and throttled logging (`src/redis.ts`). The genuinely unfixed part is the **missing aggregate-refresh fallback** (see §4). |

### Stellar Horizon — `HORIZON_URL` / `HORIZON_URL_<NETWORK>`

**Used for:** SDEX trade ingestion and Horizon AMM snapshots.

| | Behaviour |
|---|---|
| Down / rate-limited | No 429-specific handling anywhere in the ingest path (#348). SDEX fetch failures are caught inside `fetchSdexTrades` (`src/ingest/venues/sdex.ts`), logged as `error fetching trades`, and the cycle continues having ingested nothing. Failures that escape an adapter fail the cycle and trigger exponential backoff 10 s → 60 s cap: `venue adapter cycle failed; retrying` (`src/ingest/venues/runner.ts`). |
| Where you see it | `GET /status` → `ingestLagSeconds` grows; `GET /metrics` → `trades_ingested_total` flat, `time() - last_trade_timestamp` growing (staleness alert recipe: `docs/ingest-metrics.md`). |
| Recovery | Automatic: backoff retries forever; ingestion resumes from the persisted cursor in `indexer_state` (`setIndexerCursor`), so no trades are skipped once Horizon recovers — only the outage window is missing. |

### Soroban RPC, Soroswap factory, Aquarius API — `RPC_URL*`, `SOROSWAP_FACTORY_ADDRESS*`, `AQUARIUS_*`

**Used for:** AMM pool reserves/snapshots (Soroswap), Aquarius pool discovery,
Reflector oracle reads (on demand, not a background loop).

| | Behaviour |
|---|---|
| Bad/missing config | `config.ts` warns naming the env var and disables the feature; the adapter logs `venue adapter is disabled — ingester not started` and returns. |
| Down at runtime | Cycle failures back off like above. Aquarius is quieter: `if (!res.ok) return []` (`src/ingest/venues/aquarius.ts`) — **a failing API returns empty results with no error**. |
| Where you see it | `GET /metrics` → `amm_snapshots_total` flat; `/pools` pool `timestamp` goes stale; the `ammPrice` half of `/price/:assetA/:assetB` stops updating while `sdexPrice` keeps moving. |

### x402 facilitator — `X402_FACILITATOR_URL` (default `https://x402.org/facilitator`)

**Used for:** verifying payments on the gated routes (`/price`, `/pools`,
`/candles` — `GATED_ROUTES` in `src/middleware/x402.ts`). Only active when
`ORACLE_PAYMENT_ADDRESS` is set; otherwise the plugin logs
`[oracle] ORACLE_PAYMENT_ADDRESS not set — x402 gating disabled` and the gated
routes are **free**.

| | Behaviour |
|---|---|
| Unreachable / verify throws | Caught in the preHandler → **402** `{error: "Payment verification failed", reason: ...}` (fails closed). |
| Settle fails | Settlement is async after the response is sent; failure is only logged `[oracle] x402 settle error` — the request was already served. |
| Where you see it | Paying clients suddenly receive 402s; `GET /metrics` → `x402_payments_received_total` stops incrementing; `webhook`-style pino logs from the `oracle` logger. |

### Subscriber webhook endpoints (outbound HTTP)

**Used for:** threshold alerts registered via `POST /webhooks`.

| | Behaviour |
|---|---|
| Failing subscriber | 10 s timeout, **3 attempts** with delays 1 s, 2 s (`retryDelayMs`, `src/alerts/delivery.ts`), **no jitter** (#341). A 4xx stops immediately; final failure is only logged `webhook delivery failed after retries`. Nothing is persisted or re-queued — **the event is gone** (#342). |
| Where you see it | The `webhook` pino logger only. **`GET /metrics` exports no webhook series at all** — silence on `/metrics` does not mean delivery worked. |

### Keep-alive monitor (production on Render free tier)

`docs/DEPLOY_MAINNET.md`: Render free services sleep after ~15 min idle, so an
UptimeRobot monitor pings `GET /status` every 5 minutes.

| | Behaviour |
|---|---|
| Monitor stops / misconfigured | The service sleeps → `GET /status` connection refused **and ingestion sleeps with it** — staleness follows. |
| Where you see it | `/status` refused while nothing else is wrong; UptimeRobot's own alerting. |

### Environment variables

There is **no central env validation** (#338): `WATCHED_PAIRS` format throws at
startup (`parseWatchedPairs`, `src/config.ts` → fatal exit 1), everything else
is read directly from `process.env` at first use. Common misconfigurations and
their exact symptoms:

| Misconfiguration | Symptom | Signal |
|---|---|---|
| Bad `DATABASE_URL` | Process never starts | log `fatal startup error`, exit 1 |
| Bad `REDIS_URL` | Runs, uncached | boot warn `redis unavailable, continuing without cache`; `X-Cache: MISS` forever on `/price` |
| `ORACLE_PAYMENT_ADDRESS` unset | Payment gating silently off — **gated data served free** | log `x402 gating disabled`; no 402s from `/price` |
| `ADMIN_TOKEN` unset | Admin surface unusable (by design) | every `POST/DELETE /admin/keys` and `/admin/usage*` → **401** `code: admin_unauthorized` (`isAdminAuthorized`, `src/api/auth.ts`), counted in `admin_auth_failures_total` on `GET /metrics` |
| `REQUIRE_API_KEY=false` | API-key auth off entirely | log `[auth] REQUIRE_API_KEY=false — API key authentication disabled` |
| `GLOBAL_RATE_LIMIT_MAX` invalid (not a positive integer) | Process never starts | `buildApp` throws → `fatal startup error`, exit 1. Default ceiling when unset: 1000 req/min per instance, with expensive route templates shed at 80% and health probes exempt (`src/middleware/globalRateLimit.ts`) |
| `READINESS_REDIS_CHECK=false` | Redis dropped from readiness | `GET /ready` no longer fails when Redis is down |
| Bad `WATCHED_PAIRS` | Process never starts | log `fatal startup error` with the parse error, exit 1 |

---

## 3. Telling whether ingestion is healthy

### `GET /status` — liveness + lag, per network

Public (no API key), rate-limit exempt — `/status`, `/live` and `/ready` are
the `PROBE_PATHS` allow-list in `src/app.ts`, and all three are excluded from
`http_requests_total` so probes neither throttle nor pollute the traffic
metrics.
Answers for one network: pass `?network=mainnet` or the `x-network` header.

```json
{
  "ok": true,
  "network": "testnet",
  "watchedPairs": ["XLM:native/USDC:GBBD47..."],
  "lastIndexedLedger": 53842917,
  "lastProcessedAt": "2026-10-19T12:00:00.000Z",
  "ingestLagSeconds": 4
}
```

Read it honestly (implementation: `GET /status` handler, `src/api/rest.ts`):

- **`ok: true` only means the DB query worked.** The handler returns `ok: true`
  unconditionally — it does **not** assert freshness.
- **`ingestLagSeconds`** = seconds since the most recent `indexer_state` write
  for that network. It is `null` until the first write; `lastIndexedLedger` is
  `null` until the SDEX ingester has recorded a ledger.
- **Caveat, checkable in code:** only the **SDEX and AMM** ingesters write
  `indexer_state` (`setIndexerCursor` in `src/ingest/venues/sdex.ts` and
  `src/ingest/venues/amm.ts`), and only when a cycle actually ingested
  records — a network with no trades in the window shows a growing lag **even
  when everything is healthy**. Cross-check `/metrics` (below) before treating
  lag alone as an incident. The 1-minute snapshot ingester is a separate loop
  and never touches `indexer_state`.
- The compose healthcheck (`docker-compose.yml`) and the Render keep-alive
  monitor both poll this endpoint.

### `GET /live` and `GET /ready` — the platform probes

Both public, rate-limit exempt, and excluded from `http_requests_total`;
rationale and semantics live in [`docs/health.md`](health.md).

- **`GET /live`** — `200 {ok, uptimeSeconds}` as long as the event loop is
  turning; it touches neither Postgres nor Redis. That is deliberate: a
  liveness probe that fails during a dependency outage would have the
  orchestrator restart every healthy instance at once.
- **`GET /ready`** — `200` only after **boot completes** (`markBootComplete()`
  is the last line of `main()`) **and** every checked dependency is up;
  otherwise `503` carrying `booted`, `checks.postgres`, `checks.redis` and
  `checkedAt`. Postgres is probed for reachability *and* migration state
  (`to_regclass('public.indexer_state')`), Redis with `PING` (2 s probe
  deadline, 2 s answer cache — `READINESS_TIMEOUT_MS` / `READINESS_CACHE_MS`;
  `READINESS_REDIS_CHECK=false` drops Redis from readiness). Reasons in the
  body are fixed phrases, never raw errors — the endpoint is public; the real
  error is logged instead.

### `GET /snapshot` — one-shot freshness view

`GET /snapshot?network=…` returns the whole network's shape — venues, TVL, 24h
volume, top pairs, peg readings and data freshness — in one cached, timestamped
object (`src/routes/snapshot.ts`, cached in Redis via `getCachedSnapshot`).

### `GET /metrics` — the freshness and error signals

Public Prometheus exposition (`src/metrics.ts`, route in `src/app.ts`).

**Ingestion health:**

| Signal | Meaning / recipe |
|---|---|
| `rate(trades_ingested_total{network}[5m])` | Flat = SDEX/AMM ingestion stopped for those pairs |
| `time() - last_trade_timestamp{pair,network}` | Per-pair staleness — the canonical alert; worked example in `docs/ingest-metrics.md` (labels are `pair × network`, bounded by config) |
| `rate(amm_snapshots_total{network}[5m])` | AMM venue snapshots; flat = Soroswap/Aquarius/Horizon-AMM side stalled |
| `rate(price_snapshots_total{network}[5m])` | Snapshot ingester; healthy ≈ (active pairs) rows/min per network |
| `ws_clients_total`, `ws_messages_sent_total`, `ws_messages_dropped_total`, `ws_clients_dropped_total`, `ws_buffered_bytes` | Subscriber count, delivery rate, backpressure drops, clients killed and in-memory buffer depth (labels are bounded: `pair` is the literal key, `other`, or aggregate — see `docs/websocket-backpressure.md`) |

**API health:**

| Signal | Meaning |
|---|---|
| `http_requests_total{method,route,status_class}` | Rate and 5xx ratio; `route` is the route *template*, `status_class` is `2xx/4xx/5xx` — both deliberately bounded |
| `http_request_duration_seconds` | Latency histogram with Lens-specific buckets (5 ms … 10 s); p95 recipe in `README.md` and `docs/http-metrics.md` |
| `db_query_duration_seconds` | Postgres query latency (includes pool wait — the timer wraps `pgPool.query`) |
| `api_key_auth_failures_total{reason}`, `admin_auth_failures_total` | Auth failures by bounded reason (`missing`/`malformed`/`unknown`/`revoked`/`expired`; admin counted separately) |
| `rate_limit_rejections_total{scope}`, `global_shed_requests_total` | Per-key/IP limiter 429s (`key`/`ip`) and per-instance ceiling sheds (503) |
| `x402_payments_received_total`, `price_requests_total` | Payment/request counters |

**Known blind spots:** no gauge for Redis state, no gauge for the pg pool
(see #339 in §4), no queue-lag metric, no webhook-delivery metric.

### Triage sequence

1. **Is the process answering?** `curl -s localhost:3002/live`, then `/ready`:
   - *`/live` connection refused / sleeping* → process dead or host asleep (see §5 deploys, §2 keep-alive).
   - *`/live` 200 but `/ready` 503* → boot not finished, or a checked dependency is down — the `checks` body says which (Postgres down/unmigrated, Redis down; §2).
   - *`/status` 500 / refused* → PostgreSQL (§2).
2. **Is data fresh?** `ingestLagSeconds` + `time() - last_trade_timestamp` (§3 caveat above).
3. **Which layer?** grep the pino logs for the exact lines named in this
   document: `fatal startup error`, `error fetching trades`,
   `venue adapter cycle failed; retrying`, `ingester crashed; restarting in 10s`,
   `redis connection error`, `aggregate refresh worker skipped`,
   `webhook delivery failed after retries`, `[oracle] x402 settle error`.
4. **Is it only the aggregates/cache?** `/price/:assetA/:assetB` fresh but `/screener` or
   `/price/.../history` frozen → aggregate-refresh worker / Redis (§2).
5. **Full deployed check:** `SMOKE_MAX_AGE_SECONDS=120 npm run smoke -- https://<host>`
   (`scripts/deployed-smoke.mjs`) — asserts `/ready` + `/live` (it fails hard if
   `/ready` 404s or reports `ok: false`), then `/status`, `/price`, and a live
   `graphql-transport-ws` subscription. On an x402-gated installation an
   unauthenticated `/price` call returns 402 and the smoke check **fails by
   design**; it never bypasses payment (README).

---

## 4. Known failure modes in this batch

Each row states what the code does **today**, not what it should do, and names
the endpoint, metric, or log line that shows it. Issue numbers are the open
tracking issues for the batch this runbook was filed in.

| # | Failure mode | What happens today (code) | Where you see it |
|---|---|---|---|
| 1 | **Unhandled rejection kills the process** (#344) | There is **no** `unhandledRejection`/`uncaughtException` handler anywhere in `src/`; Node's default is to exit — with no application log line for the cause. | Process gone: `GET /status` connection refused, compose healthcheck fails, `http_requests_total` flatlines while the container restarts. The cause is only inferable from the last log line before the exit. |
| 2 | **Shutdown is not graceful** (#347) | There is **no** `SIGTERM`/`SIGINT` handler anywhere in `src/`; the process exits immediately. In-flight requests are cut and WebSocket clients are dropped **without a close frame**. | During any deploy/restart: WS clients see an abnormal closure (no `1000/1001` close frame), `ws_clients_total` disappears, `http_requests_total` stops mid-request. |
| 3 | **Horizon rate limiting is not handled** (#348) | No 429 branch exists in the ingest path. SDEX 429s surface as a caught error → log `error fetching trades` → `null`, and the loop retries on the normal poll interval without backoff or accounting. | `GET /status` `ingestLagSeconds` grows; `GET /metrics` `trades_ingested_total` flat + stale `last_trade_timestamp`; repeating `error fetching trades` or `venue adapter cycle failed; retrying` in the logs. |
| 4 | **A single ingester cycle has no deadline** (#351) | `startVenueAdapter` runs `while (true)` and awaits every watched pair **sequentially** with no cycle-level timeout (`src/ingest/venues/runner.ts`); there is no per-cycle upper bound. | The whole network's ingestion quietly spreads/stalls: `last_trade_timestamp` ages and `/status.ingestLagSeconds` grows **while no `venue adapter cycle failed` line appears** — no error, just lag. |
| 5 | **Webhook retries have no jitter** (#341) | Delay is exactly `2^(attempt-1) × 1000` ms (`retryDelayMs`, `src/alerts/delivery.ts`) — subscribers triggered together retry together. | Bursts of `webhook delivery failed after retries` (logger `webhook`) arriving in lockstep after any upstream blip; `GET /metrics` has **no** webhook series to graph this. |
| 6 | **A webhook that fails 3 times disappears** (#342) | After 3 attempts (or any 4xx on the first) the failure is logged and dropped — no persistence, no queue, no dead-letter. | The subscriber silently never receives the threshold event; the only trace is the `webhook` log line. Nothing on `/metrics` moves. |
| 7 | **DB pool is default-sized and unmeasured** (#339) | `new Pool({connectionString})` with pg defaults (max 10 connections); instrumentation is only the `db_query_duration_seconds` histogram — no pool gauge exists (`src/db.ts`, `src/metrics.ts`). | Under saturation both `db_query_duration_seconds` and `http_request_duration_seconds` shift right together (the timer includes pool wait); `GET /metrics` offers **no waiter/pool gauge** to confirm it. |
| 8 | **Env vars are not centrally validated** (#338) | Only `WATCHED_PAIRS` parsing throws at startup; every other variable is consumed lazily at first use. | Misconfiguration surfaces at first use — see the symptom table in §2 (bad `REDIS_URL` → `X-Cache: MISS` forever; unset `ORACLE_PAYMENT_ADDRESS` → gating silently off; unset `ADMIN_TOKEN` → admin routes always 401). |
| 9 | **Redis away at boot: aggregate refresh has no fallback** (the unfixed half of #345) | Retention and partition maintenance fall back to hourly in-process timers when their BullMQ schedule fails at boot; the **aggregate-refresh worker does not** — it is skipped and never retried for the life of the process (`src/index.ts`). | `aggregate refresh worker skipped (redis unavailable)` at boot, then: `/screener` and `/price/:assetA/:assetB/history` (and GraphQL aggregate queries) freeze while `/price/:assetA/:assetB` keeps serving live prices from `price_points`. |

---

## 5. Deploy, rollback, and what a deploy interrupts

### How a deploy happens

- **Production** (`docs/DEPLOY_MAINNET.md`): Render web service built from this
  repo/image, env vars in the Render dashboard only, Neon Postgres, managed
  Redis, UptimeRobot keep-alive on `/status`.
- **Self-hosted / local**: `docker compose up -d --build` (image built by the
  multi-stage `Dockerfile`, `CMD npm start`).
- In both cases the boot sequence in §1 applies — **including the automatic
  `prisma db push --accept-data-loss`**.

### What a deploy interrupts

1. **The schema may change destructively, automatically.** Step 1 of boot runs
   `prisma db push --accept-data-loss` (`src/index.ts`) before the API listens:
   any schema drift is applied on start, and the flag means a change that drops
   a column/table is applied **without prompting**. This is the one
   irreversible part of any deploy.2. **The API is down until `listen` returns, and not *ready* until boot ends.**
   Single instance ⇒ no rolling deploy; compose allows 20 s (`start_period`)
   before healthchecks fail. `GET /ready` stays 503 from process start until
   `markBootComplete()` — gate rollouts on `/ready`; `/live` alone only proves
   the event loop turns.
3. **No graceful shutdown** (#347, §4): in-flight requests are cut and WS
   clients are dropped without a close frame.
4. **Ingestion pauses for the restart, then resumes from persisted cursors.**
   Cursor state lives in `indexer_state`, writes are idempotent
   (`skipDuplicates` in `upsertPricePoints`, `ON CONFLICT DO NOTHING` on
   snapshots), so replay after restart is safe; the gap is the trades that
   happened while the process was down (visible as missing `price_points` for
   that window and a lag spike in `/status`).
5. **In-memory state is lost:** rate-limit windows (429 counters reset), WS
   client list, the ingesters' last-price map (the webhook previous-price
   baseline restarts, so the first post-restart tick compares against itself).
   Redis, being external, keeps the price cache warm across a deploy.
6. **Maintenance jobs re-run safely.** Prune and partition maintenance run once
   at boot regardless, the hourly schedules are re-registered, and BullMQ jobs
   are at-least-once — safe here because every job is an upsert/prune.

### How to roll back

1. **App code:** redeploy the previous known-good revision —
   Render: roll back to the previous deploy in the dashboard;
   self-hosted: `git checkout <good-sha> && docker compose up -d --build`.
2. **Schema:** `prisma db push` is forward-only; rolling back the code does not
   roll back the schema. If the previous revision needs the old schema, run
   `npx prisma db push` **from the old checkout** against the database to
   converge it back. ⚠️ Like the boot-time push, it will accept data loss for
   whatever the diff drops — **take the backup path (step 3) first** if the
   diff in question removes data.
3. **Data (if a bad deploy or its auto-migration destroyed rows):** restore the
   nightly dump per [`docs/backup-restore.md`](backup-restore.md) — dumps are
   produced daily at 03:00 UTC by `.github/workflows/db-backup.yml`,
   age-encrypted, 14-day retention. Alternatively re-ingest: Lens data is
   re-derivable from chain (`docs/DEPLOY_MAINNET.md`), bounded only by how far
   back the cursors point.
4. **Config:** env vars live in the host (Render dashboard / `.env`), not in
   the repo. Keep the previous env set alongside the previous image — a code
   rollback with the new env is only half a rollback.
5. **Verify the rollback:**
   ```bash
   curl -s https://<host>/ready                    # 200 {"ok":true,...}
   curl -s https://<host>/status                  # ok:true, lag small
   curl -s -o /dev/null -w '%{http_code}\n' https://<host>/price/XLM/USDC
   # 200 (ungated) or 402 (x402-gated) — not 5xx
   curl -s https://<host>/metrics | grep -E 'trades_ingested_total|last_trade_timestamp'
   SMOKE_MAX_AGE_SECONDS=120 npm run smoke -- https://<host>
   ```

---

## 6. CI status on `main`

The PR gate is `.github/workflows/ci.yml`; run it locally before opening a PR
(identical to CONTRIBUTING's "Before opening a PR"):

```bash
npm ci
node node_modules/prisma/build/index.js generate
npx tsc --noEmit
npm run build
npm test --if-present
```

**`Load test (prices)` is failing on `main` and is a known, unrelated red.**
It runs daily at 04:00 UTC (`load.yml`, k6 threshold p95 < 80 ms @ 5k RPS) and
has been failing continuously — it is **not** your change that broke it. Every
other check (CI build/typecheck/tests, release, OpenAPI publish, nightly
backup) should be green; treat those as the gate.

---

## Quick reference

```bash
# Health
curl -s localhost:3002/ready | jq             # readiness: boot + dependencies
curl -s localhost:3002/live  | jq             # liveness: event loop only
curl -s localhost:3002/status | jq            # ingestion lag
curl -s localhost:3002/status?network=mainnet # the other network
curl -s localhost:3002/metrics | grep -E 'trades_ingested_total|last_trade_timestamp'

# Logs & restart (compose)
docker compose logs -f lens | grep -E 'fatal|failed|crashed|redis'
docker compose restart lens

# Deployed smoke check (see README for the x402 caveat)
SMOKE_MAX_AGE_SECONDS=120 npm run smoke -- https://<host>

# Tests
npm test                                       # full vitest suite
npx vitest run src/__tests__/status.test.ts    # one file
```

Related docs: [`architecture.md`](architecture.md) ·
[`http-metrics.md`](http-metrics.md) (label reference, alert rules) ·
[`ingest-metrics.md`](ingest-metrics.md) (staleness alert, cardinality) ·
[`backup-restore.md`](backup-restore.md) (nightly dump, restore) ·
[`DEPLOY_MAINNET.md`](DEPLOY_MAINNET.md) (Render/Neon production shape) ·
[`DUAL_NETWORK.md`](DUAL_NETWORK.md) (testnet + mainnet side-by-side)
