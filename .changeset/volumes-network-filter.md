---
'lens': patch
---

`GET /volumes/:asset` now filters `price_points` by network instead of summing
testnet and mainnet volume together. It accepts `?network=testnet|mainnet`
(default: the active network), returns 400 for any other value, and echoes the
resolved `network` in the response body.
