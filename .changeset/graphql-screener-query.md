---
'lens': minor
---

Add a `screener` GraphQL query (#367). REST and GraphQL now share one implementation in `src/services/screener.ts`, so filters, sorting, the keyset cursor and the `[1, 100]` limit clamp cannot drift between the two surfaces. `sortBy` and `order` are allow-listed at the SQL boundary, and every CTE is scoped to a single network.
