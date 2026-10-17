---
'lens': patch
---

MCP tool results are size-bounded (#416). `bazaar_search` and `paid_call` used to
serialise whatever the node returned, pretty-printed and in full, so one large —
or hostile — response could consume the agent's entire context window. Results
are now compact, capped at `MCP_MAX_RESULT_BYTES`, and a truncated result carries
`truncated: true`, the page returned, the total, and a notice explaining how to
ask for more. `bazaar_search` accepts `limit` / `offset` (default and ceiling from
`MCP_DEFAULT_PAGE_LIMIT` / `MCP_MAX_PAGE_LIMIT`), forwards them to the node, and
pages whatever the node returns regardless. Upstream bodies are read through a
capped stream reader (`MCP_MAX_UPSTREAM_BYTES`) that cancels the response once the
cap is passed, so an oversized body is never buffered in full; a discovery body
too large to parse returns the new `ERR_RESPONSE_TOO_LARGE` code.
