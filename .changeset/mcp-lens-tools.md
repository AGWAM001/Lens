---
'lens': minor
---

Add the `lens_list_pairs`, `lens_get_pools` and `lens_screen_pairs` MCP tools
(#409), so an agent that can already ask for a price can also ask what is
quotable, what liquidity stands behind it and what is moving — the three
questions REST answered and MCP did not, which left an agent guessing asset
codes. Each tool runs the function its REST route runs (`listPairs`, `listPools`
and the screener service behind `GET /screener` and the GraphQL query), so a
page over MCP is the same rows, filters and cursor as a page over HTTP. Pages
are bounded by the server's configured page limit and carry `nextCursor` and
`hasMore`; a page too large for the tool output limit is returned labelled as
truncated, without a cursor that would skip the rows it dropped. Every asset
carries its issuer in full, since a Stellar asset code alone identifies nothing,
and each description says which of the three questions it answers.
