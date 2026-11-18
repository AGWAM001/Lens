---
'lens': minor
---

Split the CORS policy across three route tiers (#268). Public reads stay open to any origin with no credentials; credentialed routes are restricted to `CORS_ALLOWED_ORIGINS` with `credentials: true`; admin routes are closed to cross-origin browsers unless `CORS_ADMIN_ALLOWED_ORIGINS` names them. A request carrying `Authorization` or `Cookie` is treated as credentialed whatever it asks for, so a browser cannot be handed `Access-Control-Allow-Origin: *` for an authenticated call. A bare `*` is refused for the credentialed and admin tiers, and a wildcard entry must match the scheme it names.
