# Liveness and readiness

`/status` is a health endpoint, but it answers neither question a platform
actually asks, and the two are not the same question:

| | Question | Consequence of a wrong answer |
|---|---|---|
| `/live` | Is this process wedged and in need of a **kill**? | Restarting healthy processes turns a dependency blip into a fleet-wide cold-start storm |
| `/ready` | Should this process receive **traffic** yet? | Sending traffic to a process that cannot answer it |

`/status` reads `indexer_state`, so it fails when Postgres is unreachable — which
makes it useless as a liveness signal — and it says nothing about whether the
process has finished booting. Both probes are public, exempt from rate limiting,
and excluded from `http_requests_total` (see below).

## `GET /live`

```json
{ "ok": true, "uptimeSeconds": 3600 }
```

Answers `200` as long as the event loop is turning — reaching the handler *is*
the signal. It touches neither Postgres nor Redis, deliberately, and it stays
healthy even when every dependency is down.

That is the important property. A liveness probe that fails during a database
outage has the orchestrator restarting every instance at the same moment, which
turns a recoverable dependency outage into a cold-start storm during which
nothing — including the instances that were healthy — can serve.

`uptimeSeconds` lets an operator watching a restart loop tell restarts apart
from a process that is wedged without being restarted.

## `GET /ready`

`200` with `ok: true` when the instance can serve, `503` with `ok: false`
otherwise. The body is identical either way; `ok` and the status code together
say whether to route traffic here.

```json
{
  "ok": false,
  "booted": false,
  "checks": {
    "postgres": { "status": "skipped", "latencyMs": 0, "reason": "not part of readiness" },
    "redis":    { "status": "skipped", "latencyMs": 0, "reason": "not part of readiness" }
  },
  "checkedAt": "2026-10-19T10:00:00.000Z"
}
```

### Before boot completes

`app.listen()` runs part-way through `main()` (see `src/index.ts`), before the
ingesters, the retention worker and the websocket fan-out have started. Between
listening and those loops running, the process accepts requests it cannot yet
answer correctly. So `/ready` reports unhealthy until `markBootComplete()` at
the end of `main()`, and `/live` stays healthy throughout — a starting instance
needs to be **held out of rotation**, not killed.

While not booted, no dependency is probed at all: nothing can make a not-yet-
booted process ready, so polling it costs nothing.

### Dependency checks

- **Postgres** — `SELECT to_regclass('public.indexer_state') IS NOT NULL`. One
  cheap query that answers both reachability and whether migrations were
  applied. Reachability alone would report a process with no tables as ready,
  and every route that reads one would fail. `indexer_state` is the table
  `/status` itself reads, so it is the exact dependency whose absence makes this
  service unable to answer.
- **Redis** — `PING`. Included by default because the snapshot retention worker
  and the aggregate refresh queue are Redis-backed and stop silently when it is
  gone.

A dependency reports `up`, `down` or `skipped`, plus the probe's round-trip time
and, when it is not `up`, a fixed reason phrase. The reason is never the raw
error: a connection error carries the host and port, and this is a public
endpoint. The underlying error is logged with full detail instead.

### Cost of polling

Platforms poll every few seconds, so:

- each probe is bounded by `READINESS_TIMEOUT_MS` (default 2s) — deliberately
  shorter than the house 10s outbound deadline, because a probe slower than its
  own polling interval reports stale answers;
- answers are cached for `READINESS_CACHE_MS` (default 2s) and concurrent
  callers share one in-flight run, so a poll costs at most one round trip per
  dependency per interval.

`node-postgres` exposes no `AbortSignal` on `query()`, so a probe that exceeds
its deadline returns `down` without cancelling the query underneath. The cache
is what bounds that: at most one such outstanding query per interval, instead of
one per poll.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `READINESS_REDIS_CHECK` | `true` | Set to `false` to leave Redis out of readiness |
| `READINESS_TIMEOUT_MS` | `2000` | Deadline for a single dependency probe |
| `READINESS_CACHE_MS` | `2000` | How long one readiness answer is reused |

Set `READINESS_REDIS_CHECK=false` for a deployment that deliberately runs
Redis-less. Startup already treats an unavailable Redis as non-fatal and serves
prices uncached from Postgres (`src/index.ts`), so on such a deployment failing
readiness would pull a perfectly healthy instance out of rotation.

## Why these routes are not counted

`/metrics`, `/live` and `/ready` are excluded from `http_requests_total` and
`http_request_duration_seconds` (`EXCLUDED_ROUTES` in
`src/middleware/httpMetrics.ts`). Each is polled on a fixed interval, so
counting any of them puts a floor under the request rate that no amount of real
traffic dropping could go below — and a real outage could not move the number it
is meant to reveal.

They are also allow-listed from rate limiting alongside `/status`
(`PROBE_PATHS` in `src/app.ts`). A `429` during an incident would take an
instance out of rotation exactly when its health matters most, and the platform
would read "throttled" as "unhealthy".

Both send `Cache-Control: no-store`: a cached readiness answer would keep
routing traffic to an instance that has already gone away.

`/status` is unchanged — it keeps its own cache policy, its own rate-limit
allow-listing and its own response shape.