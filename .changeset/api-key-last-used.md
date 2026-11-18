---
'lens': minor
---

Record when an API key was last used to authenticate (#500). `api_keys.last_used_at` is stamped on each successful authentication, throttled to one write per key per `KEY_LAST_USED_THROTTLE_SECONDS` (default 60) so authentication stays a read for busy keys, and surfaced on `GET /admin/keys` — null meaning the key has not authenticated since the column existed, which is what makes an abandoned key visible. A failed write never refuses a valid request, but is logged once per key rather than swallowed.
