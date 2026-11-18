import { impermanentLossPct } from './impermanentLoss'

/**
 * The fields an estimate needs, named as the `pool_snapshots` row spells them.
 *
 * Structural rather than importing `PoolSnapshotRow`, because this module is
 * also used by the MCP tool layer, which is deliberately free of `pg` so it
 * stays testable against a stub. Numerics arrive as strings; `Number` is
 * applied here rather than at two call sites that could drift.
 */
export interface LpReturnInputs {
  spot_price?: string | number | null
  reserve_b?: string | number | null
  fee_bp?: number | null
  window_start_price?: string | number | null
  window_counter_volume?: string | number | null
}

export interface LpReturnEstimates {
  window: '24h'
  feeAprPct: number | null
  impermanentLossPct: number | null
  netReturn24hPct: number | null
  estimate: true
}

/**
 * Estimated 24h LP returns for one pool (#400).
 *
 * Two independent parts, either of which can be unknown:
 *
 *  - **Fee return** — the window's counter-asset volume times the pool's fee,
 *    over the pool's value. A 50/50 constant-product pool is worth twice one
 *    side, so `2 * reserve_b` values it in the counter asset without needing a
 *    second price.
 *  - **Divergence loss** — `impermanentLossPct`, which is zero when the price
 *    has not moved and negative otherwise. `netReturn24hPct` therefore *adds*
 *    it rather than subtracting: it is already signed.
 *
 * Anything missing or unusable yields `null`, never a zero. A pool with no
 * trades in the window has an unknown fee return, not a 0% one, and the
 * difference matters to anyone ranking pools by it. `== null` is deliberate:
 * a row that never selected the window columns has them undefined, which is the
 * same "unknown" as a SQL NULL.
 *
 * One implementation, shared by `GET /pools` and the `lens_get_pools` MCP tool,
 * so the two transports cannot answer the same question differently.
 */
export function estimatedLpReturns(r: LpReturnInputs): LpReturnEstimates {
  const startPrice = r.window_start_price == null ? null : Number(r.window_start_price)
  const endPrice = r.spot_price == null ? null : Number(r.spot_price)
  const divergenceLossPct =
    startPrice === null || endPrice === null ? null : impermanentLossPct(startPrice, endPrice)

  const reserveB = r.reserve_b == null ? NaN : Number(r.reserve_b)
  const poolValueB = Number.isFinite(reserveB) ? 2 * reserveB : 0
  const feeBp = Number(r.fee_bp) || 0
  const volumeB = r.window_counter_volume == null ? null : Number(r.window_counter_volume)
  const feeReturn24hPct =
    poolValueB > 0 && volumeB !== null && Number.isFinite(volumeB)
      ? ((volumeB * feeBp) / 10_000 / poolValueB) * 100
      : null

  return {
    window: '24h',
    feeAprPct: feeReturn24hPct === null ? null : feeReturn24hPct * 365,
    impermanentLossPct: divergenceLossPct,
    netReturn24hPct:
      divergenceLossPct === null || feeReturn24hPct === null
        ? null
        : feeReturn24hPct + divergenceLossPct,
    estimate: true,
  }
}
