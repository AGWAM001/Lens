---
"lens": patch
---

Fix network-blind webhooks and price tracking across SDEX, Horizon AMM, Soroswap, and Aquarius ingesters:
- Key module-level `lastPrice` maps by `(network, pairKey)` so price ticks on one chain do not supply the previous price for another chain.
- Dispatch webhook price updates for the network the event originated from rather than falling back to the process active network.
- Allow specifying network on webhook subscription (`POST /webhooks`) with validation.
