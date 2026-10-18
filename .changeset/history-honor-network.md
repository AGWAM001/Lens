---
'lens': patch
---

`GET /prices/history` now honours `?network=` / `x-network` instead of always
querying the deployment's default network, and echoes the resolved `network`
in the response. `queryHistory()` takes `network` as a parameter.
