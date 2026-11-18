---
'lens': patch
---

Distinguish an unconfigured admin surface from a rejected token (#508). `checkAdminAuth` returns `authorized` / `unauthorized` / `not_configured`, and admin routes answer 503 `admin_not_configured` when `ADMIN_TOKEN` is unset, blank or an obvious placeholder, instead of a 401 that tells an operator their correct token is wrong. The structural admin hook makes the same three-way distinction, startup logs a warning when the surface is disabled, and `GET /status` reports `adminConfigured` — whether a token is set, never any part of its value.
