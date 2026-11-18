---
'lens': patch
---

Retry Horizon rate limiting instead of reading it as empty data (#348). `fetchHorizonJson` honours `Retry-After` when Horizon sends one and otherwise backs off exponentially with jitter, raises `HorizonRateLimitError` once the attempts are spent so the runner counts and backs off the whole cycle, and exports `horizon_rate_limit_remaining` from the `X-RateLimit-Remaining` header. Requests go through `fetchWithTimeout`, so they carry the configured HTTP timeout and the cycle deadline's abort signal — including during the retry wait.
