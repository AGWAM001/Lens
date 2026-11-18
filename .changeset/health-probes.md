---
'lens': minor
---

Add `/live` and `/ready`, so a platform can tell "kill this one" apart from
"stop sending traffic here".

`/status` answered neither question. It reads `indexer_state`, so it fails when
Postgres is unreachable — useless as a liveness signal — and it says nothing
about whether the process has finished booting. `app.listen()` runs part-way
through `main()`, before the ingesters, the retention worker and the websocket
fan-out start, so between listening and those loops running the process accepts
requests it cannot yet answer.

`GET /live` touches no dependency and stays healthy while Postgres is down or
the app is still booting. That is the point: a liveness probe that fails during
a database outage has the orchestrator restarting every instance at once.

`GET /ready` reports `503` with `ok: false` until `main()` finishes booting, and
while Postgres is unreachable or unmigrated, or Redis is unreachable when Redis
is part of readiness (`READINESS_REDIS_CHECK`, default true). The Postgres check
is one `to_regclass` query answering both reachability and whether migrations
were applied — reachability alone would report a process with no tables as
ready. Probes are bounded by `READINESS_TIMEOUT_MS` and answers cached for
`READINESS_CACHE_MS`, so polling every few seconds costs at most one round trip
per dependency per interval.

Both are public, allow-listed from rate limiting next to `/status`, sent
`Cache-Control: no-store`, and excluded from `http_requests_total` — a
fixed-interval poller would otherwise put a floor under the request rate that no
amount of real traffic dropping could go below. `/status` is unchanged.

The deployed smoke check now requires both probes instead of skipping `/ready`
when it is absent, and fails on a failing `/live`.