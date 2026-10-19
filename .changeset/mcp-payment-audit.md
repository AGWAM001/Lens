---
'lens': minor
---

Record what every `paid_call` cost (#406). The server spent from a live key with
no receipt: `wrapFetchWithPayment` hands back a plain `Response`, the price is
only visible on the request the transport makes, and nothing said afterwards how
much left the account. `PaymentLedger` appends one JSON record per attempt —
timestamp, full URL, host, method, price, asset, network, settlement hash,
outcome, spend, error code — to `MCP_PAYMENT_LEDGER_FILE`
(default `~/.lens-mcp/payments.jsonl`), failed and rejected calls included,
since a payment can settle on a call that errored. Each record labels its spend
`settled`, `possible` or `none` so the trail reads as an upper bound instead of
inventing certainty a seller never confirmed. Neither the secret key nor the
signed envelope is ever read out of the payment header. An audit trail that
cannot be written fails closed: `paid_call` refuses further calls rather than
spending unrecorded. The same records are exported as
`mcp_payment_attempts_total`, `mcp_payment_amount_usd_total` and
`mcp_payment_unquantified_total`, whose `host` label may only take a value from
the paid-call allow-list and whose `network` label only the two networks this
signer can use, so no caller mints time series with the URLs it tries — and
`totalSpend()` gives a cumulative ceiling the running sum to read. The stdio
server has no HTTP listener, so those series are registered but not yet
scrapeable from its process.
