---
'lens': minor
---

Cache API-key lookups in-process so authentication is no longer a Postgres round-trip per request (#495). Positive and negative lookups are held for `API_KEY_CACHE_TTL` seconds (default 30), the cache is bounded at 10,000 entries so invalid keys cannot grow it without limit, hit/miss is exported as `api_key_cache_lookups_total`, and a key's own `expiresAt` is re-checked on every hit so the TTL can never outlive the key. Revoking or rotating a key drops its cached entry immediately on the instance handling the request; another instance picks it up within the TTL. Rotation now also carries the old key's scopes to the replacement.
