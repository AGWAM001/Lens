---
'lens': minor
---

Add pagination and a revoked filter to `GET /admin/keys`. `limit` (default 50, max 100) and `offset` page the listing, `revoked=true|false` (default `false`) selects live or revoked keys, and the response adds `pagination` metadata with the total matching count. Invalid values return 400.
