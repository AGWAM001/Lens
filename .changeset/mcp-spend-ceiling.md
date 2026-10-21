---
'lens': patch
---

The MCP server's spend cap is now cumulative, not just per call. `maxPrice`
bounded a single payment, so an agent in a retry loop — or one told to "try each
of these endpoints" — could pay that amount arbitrarily many times: every
payment individually inside the limit, the sum unbounded. A per-call limit
answers "how much can one mistake cost"; an operator's question is "how much can
today cost".

`SpendBudget` (`src/mcp/budget.ts`) adds a ceiling on the total paid by
`paid_call` within one UTC day, configured with `MCP_DAILY_SPEND_CEILING`
(default `$10.00`) alongside the per-call `MCP_MAX_PAYMENT_PRICE`. The day window
was chosen over a sliding 24 hours because it answers the operator's question
directly, needs one stored number rather than one entry per payment, and rolls
over from the wall clock — so a restarted server resumes the same day's total and
resets it after 00:00 UTC.

Before a call is made the budget reserves its worst case, the per-call maximum,
and refuses when that no longer fits what is left. It refuses with the new
`ERR_BUDGET_EXCEEDED` code carrying the spent, ceiling, remaining and reset time
in `details.budget`, so an agent can report being out of budget instead of
looking broken; the refusal happens before the payment fetch, so no money moves.
Both limits are in the `paid_call` description and the live totals are readable
without spending, through the new `payment_budget` tool. The running total
persists to `MCP_SPEND_STATE_FILE` (default `~/.lens-mcp/spend-state.json`) and is
read back at startup, because a restart does not refund what the previous process
already spent.

Accounting is deliberately conservative: the wrapped x402 transport exposes only
a plain `Response`, so a paid call that could have settled is booked at the
per-call maximum and a rejection that proves nothing settled is not booked at all.
Recorded spend is an upper bound, which means the ceiling is reached early rather
than late — and an unreadable or unwritable state file is treated as fully spent,
not as a clean slate.

Also fixed while wiring this up: `MCP_MAX_PAYMENT_PRICE` was passed to
`wrapFetchWithPaymentFromConfig` as `maxPrice`, which is not an option of the
x402 client config and was silently ignored — every payment was capped by the
library default of `$1` whatever the operator asked for. It is now passed as
`spendControls.maxAmountPerPayment`, so the per-call limit the budget reserves
against is the one actually enforced.
