---
'lens': patch
---

Config now validates every Soroban contract id it hands out (Soroswap factory,
Reflector oracle) with `StrKey.isValidContract`. A malformed id no longer boots
the feature "enabled" and fails on every RPC call: it logs a warning naming the
env var and disables that feature on that network. Two built-in defaults were
55 characters and therefore invalid; the testnet Soroswap factory default is
replaced with the address from Soroswap's published testnet deployment, and the
mainnet Reflector default is removed, so the oracle stays off until
`REFLECTOR_CONTRACT_ID_MAINNET` is set. `.env.example` and the deploy docs are
updated.
