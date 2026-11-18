# Venue Classification & Volume Accounting

## Overview

Lens ingests trade and pricing data across multiple venues on the Stellar network. When computing aggregate volume metrics (e.g. `GET /volumes/:asset`), summing reported volumes across all venues naively leads to severe double-counting.

Aggregator venues that route through or quote underlying decentralized exchanges report the exact same underlying trades that are also ingested from the primary venue. If an aggregator routes an order through a Stellar native liquidity pool or SDEX orderbook, counting the volume on both venues overstates actual economic activity.

To solve this, Lens classifies every venue in the venue registry as either a **primary market** or an **aggregator**.

---

## Classification Taxonomy

| Classification | Definition | Volume Accounting Impact |
| :--- | :--- | :--- |
| **`primary`** | An independent market holding its own resting liquidity (orderbook or isolated pool reserves) where trades execute natively. | Counted toward **net** and **gross** volume totals. |
| **`aggregator`** | A router, wrapper, or meta-venue that quotes and executes trades against underlying primary markets. | Excluded from **net** volume (to prevent double-counting); included in **gross** volume. |

---

## Venue Registry & Classification Reasoning

| Venue Name | Source Identifier | Classification | Technical Reasoning |
| :--- | :--- | :--- | :--- |
| **SDEX** | `SDEX` | `primary` | **Stellar Decentralized Exchange**: Stellar's native protocol-level Central Limit Order Book (CLOB). Resting limit orders are stored directly in the Stellar ledger state. Trades execute as native on-ledger operations matching resting buy and sell offers, establishing primary price discovery with independent orderbook liquidity. |
| **AMM** | `AMM` | `primary` | **Stellar Native Liquidity Pools (CAP-0038)**: Protocol-level constant-product liquidity pools. Liquidity providers deposit assets directly into on-chain pool reserves. Trades execute against pool reserves directly on the ledger. Each trade represents primary liquidity consumption in the pool. |
| **Soroswap** | `soroswap_amm` | `primary` | **Soroswap AMM**: Automated market maker smart contracts deployed on the Soroban smart contract platform. Pairs hold isolated pool reserves locked in Soroban contract instances deposited directly by LPs. Trades execute against the contracts' own reserves rather than routing to other venues. |
| **Aquarius** | `aquarius_amm` | `aggregator` | **Aquarius**: On classic Stellar, Aquarius acts as a liquidity aggregator and incentive layer. It quotes and routes trades through underlying Stellar native AMM liquidity pools (`pool_hash`) and SDEX orderbooks rather than settling against an isolated, independent liquidity source. Counting Aquarius volume alongside SDEX and native AMM trades double-counts the same underlying trades. |
| **Phoenix** | `phoenix_amm` | `primary` | **Phoenix AMM**: Constant-product liquidity pools on Soroban. Each pool contract holds its own reserves deposited by LPs, and trades execute against those reserves rather than being routed elsewhere. |
| **DeFindex** | `defindex_vault` | `aggregator` | **DeFindex Vaults**: Yield vaults on Soroban priced per share. A vault holds no market of its own: deposits are allocated to underlying strategies such as lending pools, so any activity it reports belongs to the venues underneath. It is excluded from net volume. |

---

## API Response Format (`/volumes/:asset`)

The aggregated volume endpoint (`GET /volumes/:asset`) reports both figures with explicit labels:

```json
{
  "asset": "XLM",
  "network": "testnet",
  "window": "24h",
  "startTime": "2026-10-16T12:00:00.000Z",
  "endTime": "2026-10-17T12:00:00.000Z",
  "totals": {
    "net": 1000000.0,
    "gross": 1500000.0
  },
  "netVolume": 1000000.0,
  "grossVolume": 1500000.0,
  "totalVolume": 1000000.0,
  "byVenue": {
    "SDEX": 600000.0,
    "AMM": 400000.0,
    "aquarius_amm": 500000.0
  },
  "venues": [
    "SDEX",
    "AMM",
    "aquarius_amm"
  ],
  "tradeCount": 1200,
  "netTradeCount": 1200,
  "grossTradeCount": 1750
}
```

- **`totals.net` / `netVolume`**: Traded volume summed across primary markets only (`SDEX`, `AMM`, `soroswap_amm`, `phoenix_amm`). This is the true, non-duplicated ecosystem trading volume.
- **`totals.gross` / `grossVolume`**: Total volume across all reporting venues including aggregators (`aquarius_amm`, `defindex_vault`).
- **`totalVolume`**: Preserved for backward compatibility, reporting `netVolume` to ensure callers do not overstate real activity.
- **`byVenue`**: Granular breakdown of reported volume by venue source string.
