---
'lens': minor
---

Add the `lens_get_price` MCP tool, so an agent connected over MCP can ask Lens for
an aggregated price instead of only searching and paying other people's Bazaar
nodes. Assets are `CODE` or `CODE:ISSUER`, the issuer binds when both sides name
one (a same-named asset is refused with `ERR_ASSET_ISSUER_MISMATCH`, never
priced), the network defaults to the one the server runs, and the answer is
structured content carrying the price, venues, source count, confidence, the age
of the last trade and the best route.
