---
'lens': minor
---

Gate `paid_call` behind an operator allow-list of hosts (#404). The tool pays
whatever URL it is given, up to `MCP_MAX_PAYMENT_PRICE`, from a live key — and
an agent that reads attacker-influenced text is one sentence from being told
which URL. `paidCallAllowlist` (server config, `MCP_PAID_CALL_ALLOWED_HOSTS`)
lists origins or URL prefixes; an unlisted, non-http(s) or credential-bearing
URL is refused with `ERR_HOST_NOT_ALLOWED` naming the host, before any request
is sent, and the list cannot be widened by a tool argument. The default is
empty, which pays nobody.
