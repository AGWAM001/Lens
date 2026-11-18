---
'lens': minor
---

Publish market coverage ratio overall and per asset (`GET /coverage` and `GET /coverage/:asset`) comparing Lens indexed trade volume and count against total Stellar network activity from Horizon over a time window. Document reproducible methodology in `docs/coverage-methodology.md`, report unflattering 0% coverage faithfully, and return `coverageRatio: null` with `status: "unanswerable"` when network activity is zero.
