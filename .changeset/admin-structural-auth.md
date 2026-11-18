---
'lens': patch
---

Guard admin endpoints structurally (#514). An `onRequest` hook enforces `ADMIN_TOKEN` over every route that declares `{ admin: true, auth: 'admin' }` or is registered under `/admin/`, so a new admin endpoint is protected by where it lives rather than by its handler remembering to call `isAdminAuthorized`. `public: true` now means genuinely unauthenticated, and all seven admin routes declare the admin tier instead. The guard reads the matched route pattern, not `req.url`, so a percent-encoded path cannot route to an admin handler while reading as non-admin.
