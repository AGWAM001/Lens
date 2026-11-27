---
'lens': patch
---

Point the local stack at `/ready` instead of `/status`.

`docker-compose.yml` called Lens healthy as soon as `/status` answered, which
happens as soon as the server listens — before boot finishes and before the
ingesters run. The Lens health check now polls `/ready`, which stays unhealthy
until `markBootComplete()` and the Postgres/Redis probes pass. Redis gets its
own health check (`redis-cli ping`) and Lens waits for `service_healthy`
instead of `service_started`. `STELLAR_NETWORK=testnet` is stated explicitly,
and the Lens `start_period` is 60s so first-run migrations fit inside it.

The e2e helper and the load workflow wait on `/ready` too, and the Docker
Quickstart in the README now says what `healthy` means.
