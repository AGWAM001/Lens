---
'lens': minor
---

The MCP server can now serve Streamable HTTP, selected with `MCP_TRANSPORT=http`.
Until then stdio was the only transport, so the server could only be used by a
client able to launch this process on the same machine — which rules out every
hosted agent, and means the agent's secret key has to be installed on each
machine that wants to pay.

HTTP reaches the network, so it is only allowed to start authenticated.
`resolveMcpTransportConfig` (`src/mcp/config.ts`) requires a non-empty
`MCP_HTTP_AUTH_TOKEN` before anything else happens, and `runHttp()` throws again
if handed a blank one, so an unauthenticated remote server with `paid_call` in
its tool list cannot be brought up by configuration or by an embedding caller.
The example entrypoint resolves the transport before it builds a signer: a
server that cannot authenticate callers never reaches the point where it can
spend. Every request must then present `Authorization: Bearer <token>`, compared
over SHA-256 digests with `timingSafeEqual`; a missing, malformed or wrong token
is refused with `401`, `www-authenticate: Bearer realm="lens-mcp"` and the new
`ERR_UNAUTHORIZED` code, before the body is read and before any tool runs. The
token is never echoed back into an error message or a log line.

It binds `127.0.0.1` unless `MCP_HTTP_HOST` says otherwise, answers MCP only on
`MCP_HTTP_PATH` (default `/mcp`), rejects anything else with `404` without
revealing whether the path exists, and requires `POST` — `GET` gets `405`, which
spec-compliant clients read as "no server-initiated stream" rather than an
error. Bodies are capped at 1 MiB and must be `application/json`, so a caller
cannot make the payment path stream an unbounded request.

Both transports register the same tools from the same code path, and share
one spend budget and payment ledger per process, so a remote client cannot spend
past a ceiling a local one already used. State is deliberately not shared
across requests: the SDK's stateless Streamable HTTP transport is single-use — a
second request on one instance throws, because message ids from different
clients would collide — so each `POST` gets its own protocol server and
transport.

stdio remains the default: with `MCP_TRANSPORT` unset, or set to `stdio`, the
server talks to stdin and stdout exactly as before. An unrecognised value throws
instead of quietly falling back, because a server that silently ignored the
transport it was told to serve would be hard to trust with a key.
