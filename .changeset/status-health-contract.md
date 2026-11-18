---
'lens': minor
---

Document and separate process health from data health on `GET /status` (#273). The response now carries `status`, `health.process`, `health.data`, a `process` block (uptime, heap) and a `data` block (last ledger, lag, `isStale`); the previous top-level fields are unchanged, so existing consumers keep working. Ingest lag over 300s reports `status: "degraded"` with a 200, and a Postgres failure returns 503 with `pagingCondition: "DATABASE_DOWN"` — so an uptime monitor pages on infrastructure, not on upstream ledger delay. The 503 body is a fixed phrase: `/status` is public, so the driver's message goes to the log, never the response. `health.process` is read from boot state, so the first seconds of a deploy report a degraded process with healthy data.
