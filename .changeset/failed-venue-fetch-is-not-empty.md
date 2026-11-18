---
'lens': patch
---

A failed venue fetch is no longer indistinguishable from an empty venue (#329). The Horizon AMM pool fetch, the Soroswap token list, the Aquarius pool fetch and the Reflector oracle read now all return one result shape, `{ ok: true, data } | { ok: false, error }`, instead of turning an error into `[]` or `null`. A failure is logged (Reflector used to swallow it silently) and recorded per source, network and pair; the next successful fetch clears it. `aggregatePrice` excludes a failed source from the composite and from the deviation baseline instead of counting it as though it answered with nothing, and returns the failed sources as `failedSources`. `GET /status` lists them under `failedSources` (source, network, pair or asset, time; the error text stays in the log because the route is public).
