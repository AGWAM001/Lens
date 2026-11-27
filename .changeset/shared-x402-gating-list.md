---
'lens': patch
---

Cache policy and the x402 payment gate now read the paid-route list, the segment matcher and the "is x402 configured" check from one shared module, `src/x402/gating.ts` (#677). The cache policy previously kept a second copy of the gated-route list (and its own copy of the configuration check) that nothing compared against the real list — a paid route added to `GATED_ROUTES` without updating the copy would have been marked `public` and could sit in a shared cache, letting the next caller skip payment. Both files now import the same definitions, and `cachePolicyFor` accepts an optional `gatedRoutes` list so tests can prove that a newly gated route stops being shared-cacheable. No route, method or price changes; existing imports from `middleware/x402` and `x402/network` keep working through re-exports.
