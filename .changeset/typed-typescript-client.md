---
'lens': minor
---

Add a generated TypeScript client at `clients/typescript`. `npm run client:gen`
regenerates `clients/typescript/src/schema.d.ts` from `openapi.yaml` with
`openapi-typescript`, and `openapi-fetch` gives a typed `createLensClient`, so
every request and response type is derived from the spec and nothing is
hand-maintained. CI regenerates the client and fails if the committed copy
differs from `openapi.yaml`, then typechecks it with
`npm run client:typecheck`. `clients/typescript/src/example.ts` is a documented
usage example; the README explains how to regenerate and use the client.
