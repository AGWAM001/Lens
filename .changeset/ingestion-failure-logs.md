---
'lens': patch
---

Venue ingestion failures are logged through pino on the `ingester:<venue>` child logger, with `venue`, `network`, `pair`, `attempt`, `retryMs`, `durationMs` and `err` as queryable fields, so an operator can count failures per pair and see the stack. The convention is documented in `docs/logging.md`.
