---
'lens': patch
---

Fix the load test so it measures something real and enforces what it claims.

- The workflow now seeds the database (`npm run seed -- --network testnet`)
  after migrations and before starting the server. The run used to execute
  against an empty database, so `/price` had no data to serve.
- Thresholds are per endpoint, using the `endpoint` tag the script already
  sets: price p95 < 80ms (the number in the workflow title and the script
  header — the old global `p(95)<200` was a looser limit than the title
  claimed, and it lumped the slower twap/vwap endpoints in with the hot
  path), twap/vwap p95 < 500ms, plus thresholds on the `twap_duration` and
  `vwap_duration` trends.
- The k6 summary is saved via `handleSummary` and uploaded as a
  `k6-summary` artifact on every run (`if: always()`), so a failing run
  still leaves its numbers behind — including whether a hosted runner can
  hold 5k RPS.
- The job now has `timeout-minutes: 30`, and the README documents a small
  local run (`RATE=200 DURATION=20s` against docker-compose).

Note: there is no config switch to stop live ingestion during the run, so
the ingesters keep running while k6 floods. That is fine for this test —
the checks only assert status, body presence and latency, not exact values
— but it means the seeded data is not frozen during the run.
