---
'lens': patch
---

`bazaar_search` no longer fetches any URL it is handed (#407). The MCP server now
parses the target, refuses anything that is not `http`/`https`, resolves the
hostname and rejects it if any address is private, loopback, link-local, or a
cloud metadata endpoint (e.g. `169.254.169.254`), and follows redirects manually
so a permitted host cannot bounce the request to a forbidden address. Operators
can constrain reachable hosts further with the shared `OUTBOUND_ALLOWED_HOSTS`
list, which narrows access but never re-opens a blocked address. Blocked requests
return the new `ERR_URL_BLOCKED` code.
