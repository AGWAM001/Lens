---
'lens': patch
---

Generate README venues section and endpoints table from code registries:
- Added `scripts/generate-readme.ts` (`npm run readme:gen`) to render the venues table from `venueAdapters` and the endpoints table from `openapi.yaml`.
- Added `type` and `description` to `VenueAdapter` and existing venue adapters (SDEX, AMM, Soroswap, Aquarius).
- Added `tests/readme.test.ts` to assert that `README.md` venues and endpoints sections never drift from source registries.
