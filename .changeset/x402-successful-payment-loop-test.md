---
'lens': patch
---

Add an end-to-end test for the successful x402 402 payment loop (#423). Drives the real
`@x402/fetch` transport against a stubbed resource + fake facilitator, signing a real Soroban
`transfer` with `@stellar/stellar-sdk` using throwaway testnet keys. Asserts on what was signed —
amount, destination and network passphrase (valid on testnet, invalid on mainnet) — not just the
response body, and covers the failure branches: amount above maxPrice refused before submitting,
a network the client is not registered for, and an expired signature that the facilitator rejects.
