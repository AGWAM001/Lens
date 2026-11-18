# Market Coverage Methodology

Lens claims to unify Stellar pricing. The empirical version of that claim is a concrete number: of the trading activity occurring across the Stellar network, what share passes through venues that Lens indexes?

This document defines the methodology, mathematics, data sources, and reproduction steps for calculating market coverage in Lens.

---

## 1. Core Principles

1. **Empirical and Reproducible**: Anyone with access to the Lens database and a public Stellar Horizon endpoint can execute the exact SQL and HTTP requests described below and reproduce the figures byte-for-byte.
2. **Honest Reporting**: Unflattering figures are published without sanitization. A coverage figure that only appears when high is worthless. If Lens indexed 0% of the trading activity for an active asset, the ratio is published as `0.0`.
3. **Saying When We Cannot Answer**: An asset with no liquidity, an untracked pair, or a network window with zero on-chain trades has an honest answer: `coverageRatio: null` with status `"unanswerable"`. Zero is a number people act on — reporting `0` for an inactive market would falsely imply that trades happened and Lens missed all of them.
4. **Complete Provenance**: Every figure carries what it was computed from: which venues contributed, how many samples were evaluated, how fresh the underlying observations are, and which Horizon server answered for the network.
5. **Strict Network Scoping**: Testnet and mainnet trading activity are completely distinct universes. Adding them together is meaningless. Every query strictly scopes to `network = 'testnet'` or `network = 'mainnet'`.

---

## 2. Mathematical Definition

### 2.1 Per-Asset Coverage Ratio

For an asset $A$ over a time window $W = [t_{\text{start}}, t_{\text{end}}]$ on network $N$:

$$\text{coverageRatio}(A, W, N) = \frac{\text{indexedVolume}(A, W, N)}{\text{networkVolume}(A, W, N)}$$

Where:
- $\text{indexedVolume}(A, W, N)$: The volume of asset $A$ traded across all venues indexed by Lens (SDEX, AMM, Soroswap, Aquarius) in window $W$ on network $N$. Volume is counted in the asset's own native units (base volume when $A$ is base, counter volume when $A$ is counter).
- $\text{networkVolume}(A, W, N)$: The total on-chain traded volume of asset $A$ across all matching pairs reported by Stellar Horizon's trade aggregations for the same window $W$ on network $N$.

#### Behavior Table

| Indexed Volume | Network Volume | Coverage Ratio | Status | Explanation |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `0` | `null` | `unanswerable` | No on-chain trading occurred in the window; coverage cannot be answered. |
| `0` | `> 0` | `0.0` | `computed` | On-chain trading occurred, but Lens indexed none of it (0% coverage). Published unflinchingly. |
| `V_idx` | `V_net` (`V_net > 0`) | `V_idx / V_net` | `computed` | Proportion of network volume captured by Lens. |
| `> V_net` | `V_net` (`V_net > 0`) | `> 1.0` | `computed` | Lens indexes venues outside Horizon (e.g. Soroban contracts like Soroswap) whose volume exceeds native orderbook aggregations. |

### 2.2 Trade Coverage Ratio

Trade coverage measures the ratio of individual trade transactions indexed by Lens versus total trades recorded on the network:

$$\text{tradeCoverageRatio}(W, N) = \frac{\text{totalIndexedTrades}(W, N)}{\text{totalNetworkTrades}(W, N)}$$

Because trade count is dimensionless, it can be meaningfully aggregated across different assets to provide a macro picture of network coverage.

---

## 3. Data Sources

### 3.1 Indexed Activity (Lens Postgres)

Indexed trades are stored in the `price_points` table populated by venue ingesters (SDEX ingester, AMM ingester, Soroswap ingester, Aquarius ingester):

```sql
SELECT source,
       SUM(
         CASE
           WHEN asset_a = $1 OR asset_a = $4 THEN base_volume
           WHEN asset_b = $1 OR asset_b = $4 THEN counter_volume
           ELSE 0
         END
       )::numeric AS volume,
       COUNT(*)::int AS trade_count,
       MAX(timestamp) AS last_seen
  FROM price_points
 WHERE (asset_a = $1 OR asset_a = $4 OR asset_b = $1 OR asset_b = $4)
   AND network = $2
   AND timestamp >= $3
 GROUP BY source;
```

Parameters:
- `$1`: Canonical asset identifier (e.g. `'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'` or `'XLM'`)
- `$2`: Network name (`'testnet'` or `'mainnet'`)
- `$3`: Window start timestamp ($t_{\text{start}}$)
- `$4`: Asset code (e.g. `'USDC'` or `'XLM'`)

### 3.2 Network Activity (Stellar Horizon)

Network activity is queried from Stellar Horizon's `/trade_aggregations` endpoint:

```
GET {horizon_url}/trade_aggregations?base_asset_type={type}&base_asset_code={code}&base_asset_issuer={issuer}&counter_asset_type=native&start_time={start_ms}&end_time={end_ms}&resolution={resolution_ms}&limit=200
```

Horizon returns bucketed aggregations:
- `base_volume`: Traded volume of base asset.
- `counter_volume`: Traded volume of counter asset.
- `trade_count`: Number of on-chain trade executions.

Resolution is chosen based on window length:
- `24h`: 1 hour (`3,600,000` ms)
- `7d`: 1 day (`86,400,000` ms)
- `30d`: 1 day (`86,400,000` ms)

---

## 4. Reproducing the Numbers (Step-by-Step)

To reproduce the coverage figure for `XLM` over the last 24 hours on `testnet`:

1. **Calculate time bounds**:
   - $t_{\text{end}} = \text{now}$ (e.g. `2026-10-19T11:00:00Z`)
   - $t_{\text{start}} = t_{\text{end}} - 24\text{ hours}$ (e.g. `2026-10-18T11:00:00Z`)

2. **Run Postgres query for indexed volume**:
   ```sql
   SELECT SUM(
            CASE
              WHEN asset_a = 'XLM' THEN base_volume
              WHEN asset_b = 'XLM' THEN counter_volume
              ELSE 0
            END
          ) AS indexed_xlm_volume,
          COUNT(*) AS indexed_trades
     FROM price_points
    WHERE (asset_a = 'XLM' OR asset_b = 'XLM')
      AND network = 'testnet'
      AND timestamp >= '2026-10-18T11:00:00Z';
   ```

3. **Query Horizon for network volume**:
   For each watched pair with XLM (e.g. XLM / USDC):
   ```
   GET https://horizon-testnet.stellar.org/trade_aggregations?base_asset_type=native&counter_asset_type=credit_alphanum4&counter_asset_code=USDC&counter_asset_issuer=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5&start_time=1792321200000&end_time=1792407600000&resolution=3600000&limit=200
   ```
   Sum `base_volume` across the returned records.

4. **Compute the ratio**:
   $$\text{coverageRatio} = \frac{\text{indexed\_xlm\_volume}}{\text{sum(base\_volume)}}$$

---

## 5. API Endpoints

- **`GET /coverage`**: Overall market coverage ratio across all watched assets, with per-asset list, trade coverage, and full provenance.
- **`GET /coverage/:asset`**: Asset-specific market coverage ratio, venue breakdown, Horizon network activity comparison, and provenance.

Both routes require no authentication and support:
- `?network=testnet|mainnet` (defaults to active network)
- `?window=24h|7d|30d` (defaults to `24h`)
