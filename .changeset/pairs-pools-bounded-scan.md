---
'lens': patch
---

`GET /pairs` and `GET /pools` no longer scan the whole history of every network
on each request. Both now filter by network (`req.network`, default the active
network) and read one index entry per pair / pool, so cost no longer grows with
table size. Response shape is unchanged. A pair or pool that has gone quiet is
still listed with its real last-update timestamp (it is never dropped).
