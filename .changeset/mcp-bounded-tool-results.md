---
'lens': patch
---

MCP tool results are size-bounded (#416). Every result was serialised
pretty-printed and in full, so one large — or hostile — response could consume an
agent's entire context window, and the failure looked like a bad model rather
than an unbounded tool. All four tools (`bazaar_search`, `paid_call`,
`payment_budget`, `lens_get_price`) now return compact JSON capped at
`MCP_MAX_RESULT_BYTES`, and a truncated result says so: `truncated: true`, the
total, the page returned, and a notice explaining how to ask for more.
`bazaar_search` gains `limit` / `offset` arguments (defaults and ceiling from
`MCP_DEFAULT_PAGE_LIMIT` / `MCP_MAX_PAGE_LIMIT`), forwards them to the node, and
pages whatever comes back even if the node ignores them. `lens_get_price` keeps
`structuredContent` only while the payload fits, since shipping it regardless
would move the blow-up into another field.

Upstream bodies are read through a capped stream reader (`MCP_MAX_UPSTREAM_BYTES`)
that keeps the part that fits and cancels the rest, so an oversized body is never
buffered in full. A discovery body too large to parse returns
`ERR_RESPONSE_TOO_LARGE`, which — unlike `ERR_URL_BLOCKED` and
`ERR_HOST_NOT_ALLOWED` — is not a refusal to ask: the request succeeded, the
answer is simply too big to hand over.
