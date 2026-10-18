/**
 * Horizon trade ids and paging tokens are `{toid}-{order}`. The TOID packs the
 * ledger sequence into its high 32 bits, and that is the only place a trade
 * exposes its ledger: `/trades` and `/liquidity_pools/{id}/trades` both return
 * `ledger_close_time` but no `ledger` field, and the SDK's `TradeRecord` type
 * says the same.
 *
 * Returns `null` for anything that doesn't parse rather than throwing or
 * yielding `NaN`, because `PricePoint.ledger` is a required `Int` — callers
 * decide the fallback instead of persisting a wrong ledger into the column.
 */
export function ledgerFromPagingToken(token?: string | null): number | null {
  if (!token) return null

  const toid = token.split('-')[0]
  if (!/^\d+$/.test(toid)) return null

  const ledger = Number(BigInt(toid) >> 32n)
  return Number.isSafeInteger(ledger) && ledger > 0 ? ledger : null
}

/**
 * Resolve a page of ascending Horizon trades to one ledger per record.
 *
 * A token that won't parse inherits the nearest ledger we can establish — the
 * first parseable record in the page, else `previousLedger` read back from
 * `indexer_state`. Returns `null` when no ledger can be established at all, so
 * the caller skips the batch rather than writing a fabricated value (a price
 * tagged with the wrong ledger is worse than one we retry next tick).
 */
export function resolvePageLedgers(
  tokens: (string | null | undefined)[],
  previousLedger: number | null,
): number[] | null {
  const parsed = tokens.map(ledgerFromPagingToken)
  const fallback = parsed.find((ledger): ledger is number => ledger !== null) ?? previousLedger
  if (fallback === null) return null
  return parsed.map(ledger => ledger ?? fallback)
}
