---
'lens': patch
---

Every `paid_call` now leaves a record of what it cost. A successful call used to
return the response body and nothing else: no log line, metric or persisted trace
of which URL was paid, how much, on which network, with which transaction. For a
tool that signs with a real key, the audit trail is not an enhancement — without
it there is no answer to "where did today's money go", and the cumulative ceiling
had no measurement of spend to read.

`PaymentLedger` (`src/mcp/ledger.ts`) writes one JSON line per attempt to
`MCP_PAYMENT_LEDGER_FILE` (default `~/.lens-mcp/payments.jsonl`): timestamp, full
URL, host, method, price, asset, network, transaction hash, the call's outcome,
what the ledger can vouch for about the money (`settled`, `possible` or `none`)
and the error code if the call failed. A failed call is recorded too, because a
payment can settle on a call that then errors — `outcome` and `spend` are separate
fields so "the call failed" never implies "nothing left the account".

The price is not on the `Response` the x402 client hands back; it is only visible
on the payment header the transport puts on the request. So the ledger wraps that
transport's fetch (`instrumentFetch`) and correlates the offer with the response
it produced. The settlement header is read for the transaction hash and for
whether the seller confirmed it.

`mcp_payment_attempts_total` (labels `host`, `network`, `outcome`) and
`mcp_payment_amount_usd_total` (labels `host`, `network`) export the same spend to
Prometheus, on the shared registry. Labels come from `MCP_METRIC_HOSTS`: series are
permanent, so labelling by whatever URL an agent asks for would let one caller mint
unbounded time series, and anything outside the allow-list is reported as `unknown`.
The audit file always keeps the real host. Amounts that are not a USD money string
are recorded verbatim but cannot join the USD sum, so `mcp_payment_unquantified_total`
and `totalSpend().unquantifiedPayments` make that understatement visible instead of
silent.

No secret material is recorded. Only the seller's echoed `accepted` requirements are
read out of the payment header; the signed envelope alongside it never reaches a
record, a metric or the file, and every header field is length-capped so a seller
cannot forge extra lines into the trail.

Accounting fails closed in both directions: if the audit file cannot be created or a
record cannot be written, `paid_call` is refused with `ERR_INTERNAL_FAILURE` rather
than spending unrecorded. And `payment_budget` now reports `recordedSpend` beside the
budget's own worst-case reservations, so the ceiling has an actual measurement to
read: the budget holds the per-call maximum because it cannot see the price, while
the ledger reports the price it did see.
