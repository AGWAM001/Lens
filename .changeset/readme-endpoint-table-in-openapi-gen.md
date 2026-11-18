---
'lens': patch
---

`npm run openapi:gen` now also regenerates the README endpoint table from `openapi.yaml`, and CI runs `npm run readme:check`, which fails when the committed README differs from a fresh generation (#275).
