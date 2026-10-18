---
'lens': patch
---

Fix `GET /status`: scope `indexer_state` to the requested network (`?network=`
/ `x-network`, defaulting to `STELLAR_NETWORK`) instead of returning whichever
chain wrote most recently, and report the answering network and its watched
pairs in the response.

The SDEX and AMM ingesters now derive each trade's ledger from the TOID prefix
of its Horizon id — Horizon sends no `ledger` field on a trade — so price points
carry a real ledger again and `lastIndexedLedger` is no longer permanently null.
A malformed id falls back to the last stored ledger, and the batch is deferred
if no ledger can be established. A new `ingestLagSeconds` field surfaces a
stalled ingester without Prometheus.
