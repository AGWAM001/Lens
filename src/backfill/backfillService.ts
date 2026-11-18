import { Asset } from '@stellar/stellar-sdk'
import { activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import { getHorizonServer } from '../network/clients'
import { upsertPricePoints } from '../db'
import { resolvePageLedgers } from '../ingest/toid'
import { deriveSdexPricePoints, type SdexRawTrades } from '../ingest/venues/sdex'
import { getActivePairs, parseAssetStr, makePairKey } from '../pairsRegistry'
import type { WatchedPair, AssetId } from '../types'
import type { VenuePricePoint } from '../ingest/venues/types'
import {
  supportsHistory,
  markGapsFilled,
  markGapsPermanent,
} from './gaps'
import type { BackfillResult } from './types'
import { createLogger } from '../logger'

const log = createLogger('backfill')

function toAsset(asset: { code: string; issuer: string | null }): Asset {
  if (!asset.issuer || asset.code === 'XLM') return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

function resolvePair(pairStr: string, network: NetworkName): WatchedPair {
  const active = getNetworkConfig(network).pairs.find(
    p => p.pairKey.toUpperCase() === pairStr.toUpperCase()
  ) ?? getActivePairs().find(
    p => p.pairKey.toUpperCase() === pairStr.toUpperCase()
  )

  if (active) return active

  // Try parsing "CODE:ISSUER/CODE:ISSUER" or "CODE/CODE"
  const [aStr, bStr] = pairStr.split('/')
  if (!aStr || !bStr) {
    throw new Error(`Invalid pair format: "${pairStr}". Expected "ASSET_A/ASSET_B"`)
  }

  const assetA = parseAssetStr(aStr) ?? { code: aStr.toUpperCase(), issuer: null }
  const assetB = parseAssetStr(bStr) ?? { code: bStr.toUpperCase(), issuer: null }
  return {
    assetA,
    assetB,
    pairKey: makePairKey(assetA, assetB),
  }
}

export interface BackfillOptions {
  source: string
  pair: string
  start: Date
  end: Date
  network?: NetworkName
}

/**
 * Executes a backfill for a given source, pair, and time range.
 *
 * 1. Validates input range (start < end, not in the future).
 * 2. Checks if the source supports historical data fetch.
 *    If NOT: marks any overlapping gaps as 'permanent' and reports unfillable without failing noisily.
 * 3. If supported: refetches data from the source and writes it through the SAME
 *    idempotent write path as live ingestion (`upsertPricePoints`).
 * 4. Running the same backfill twice produces no duplicates and no changes the second time.
 * 5. Updates gap records as ranges get filled.
 */
export async function backfill(options: BackfillOptions): Promise<BackfillResult> {
  const network = options.network ?? activeNetwork
  const { source, start, end } = options

  // Validate range
  if (isNaN(start.getTime())) {
    throw new Error('Invalid start date: must be a valid ISO 8601 date string')
  }
  if (isNaN(end.getTime())) {
    throw new Error('Invalid end date: must be a valid ISO 8601 date string')
  }
  if (start >= end) {
    throw new Error(`Invalid time range: start (${start.toISOString()}) must be before end (${end.toISOString()})`)
  }
  const now = new Date()
  if (end.getTime() > now.getTime() + 60_000) {
    throw new Error(`Invalid time range: end (${end.toISOString()}) cannot be in the future`)
  }

  const pair = resolvePair(options.pair, network)

  // 1. Check history capability
  if (!supportsHistory(source)) {
    await markGapsPermanent({
      network,
      pair: pair.pairKey,
      source,
      start,
      end,
    })

    const message = `Source "${source}" does not support historical data fetch; gap [${start.toISOString()} - ${end.toISOString()}] cannot be filled and has been marked permanent.`
    log.warn({ source, start, end }, message)

    return {
      success: false,
      unfillable: true,
      source,
      pair: pair.pairKey,
      network,
      start,
      end,
      pointsIngested: 0,
      gapsFilled: 0,
      message,
    }
  }

  // 2. Fetch history for supported source
  let pointsIngested = 0

  if (source.toUpperCase() === 'SDEX') {
    pointsIngested = await backfillSdexTrades(pair, start, end, network)
  } else if (source.toUpperCase() === 'AMM') {
    pointsIngested = await backfillAmmTrades(pair, start, end, network)
  }

  // 3. Update gap records (fully or partially covered)
  const gapsFilled = await markGapsFilled({
    network,
    pair: pair.pairKey,
    source,
    start,
    end,
  })

  return {
    success: true,
    source,
    pair: pair.pairKey,
    network,
    start,
    end,
    pointsIngested,
    gapsFilled,
  }
}

/**
 * Backfills SDEX trades by paging Horizon across [start, end].
 * Writes derived points directly through `upsertPricePoints`.
 */
async function backfillSdexTrades(
  pair: WatchedPair,
  start: Date,
  end: Date,
  network: NetworkName
): Promise<number> {
  const assetA = toAsset(pair.assetA)
  const assetB = toAsset(pair.assetB)
  const horizon = getHorizonServer(network)

  let totalIngested = 0
  let cursor = '0'
  let hasMore = true

  // Loop pages of trades until reaching trades past `end`
  while (hasMore) {
    try {
      const page = await horizon
        .trades()
        .forAssetPair(assetA, assetB)
        .cursor(cursor)
        .limit(200)
        .order('asc')
        .call()

      const records = page.records
      if (!records || records.length === 0) {
        break
      }

      // Filter records within [start, end]
      const inRangeRecords = records.filter((t: any) => {
        const time = new Date(t.ledger_close_time).getTime()
        return time >= start.getTime() && time <= end.getTime()
      })

      if (inRangeRecords.length > 0) {
        const raw: SdexRawTrades = {
          records: inRangeRecords,
          cursor,
          stateId: `sdex:backfill:${pair.pairKey}`,
          lastLedger: null,
        }

        const derived = deriveSdexPricePoints(raw, pair)
        if (derived && derived.points.length > 0) {
          const count = await upsertPricePoints(derived.points, network)
          totalIngested += count
        }
      }

      const lastRecord = records[records.length - 1]
      cursor = lastRecord.paging_token

      // If the last trade in this page is past `end`, we are done
      if (new Date(lastRecord.ledger_close_time).getTime() > end.getTime()) {
        hasMore = false
      }
    } catch (err) {
      log.error({ err, pair: pair.pairKey }, 'Error paging SDEX trades')
      break
    }
  }

  return totalIngested
}

/**
 * Backfills AMM liquidity pool trades by paging Horizon across [start, end].
 * Writes derived points directly through `upsertPricePoints`.
 */
async function backfillAmmTrades(
  pair: WatchedPair,
  start: Date,
  end: Date,
  network: NetworkName
): Promise<number> {
  let totalIngested = 0
  const netConfig = getNetworkConfig(network)

  try {
    const assetAStr = pair.assetA.issuer ? `${pair.assetA.code}:${pair.assetA.issuer}` : 'native'
    const assetBStr = pair.assetB.issuer ? `${pair.assetB.code}:${pair.assetB.issuer}` : 'native'

    const params = new URLSearchParams()
    params.append('reserves[]', assetAStr)
    params.append('reserves[]', assetBStr)

    const response = await fetch(`${netConfig.horizon.url}/liquidity_pools?${params.toString()}`)
    const data = (await response.json()) as any
    const pools = data._embedded?.records ?? []

    for (const pool of pools) {
      let cursor = '0'
      let hasMore = true

      while (hasMore) {
        const tradesRes = await fetch(
          `${netConfig.horizon.url}/liquidity_pools/${pool.id}/trades?cursor=${cursor}&limit=200&order=asc`
        )
        const tradesData = (await tradesRes.json()) as any
        const records = tradesData._embedded?.records ?? []
        if (records.length === 0) break

        const inRange = records.filter((t: any) => {
          const time = new Date(t.ledger_close_time).getTime()
          return time >= start.getTime() && time <= end.getTime()
        })

        if (inRange.length > 0) {
          const ledgers = resolvePageLedgers(
            inRange.map((t: any) => t.paging_token ?? t.id),
            null
          )

          if (ledgers !== null) {
            const points: VenuePricePoint[] = inRange.map((t: any, i: number) => {
              const baseCode = t.base_asset_type === 'native' ? 'XLM' : t.base_asset_code
              const isForward = baseCode === pair.assetA.code
              const price = isForward
                ? parseFloat(t.counter_amount) / parseFloat(t.base_amount)
                : parseFloat(t.base_amount) / parseFloat(t.counter_amount)

              return {
                assetA: pair.assetA.code,
                assetB: pair.assetB.code,
                pairKey: pair.pairKey,
                source: 'AMM',
                poolId: pool.id,
                price,
                baseVolume: parseFloat(t.base_amount),
                counterVolume: parseFloat(t.counter_amount),
                ledger: ledgers[i],
                timestamp: new Date(t.ledger_close_time),
                eventId: t.id,
              }
            })

            const count = await upsertPricePoints(points, network)
            totalIngested += count
          }
        }

        const lastRec = records[records.length - 1]
        cursor = lastRec.paging_token
        if (new Date(lastRec.ledger_close_time).getTime() > end.getTime()) {
          hasMore = false
        }
      }
    }
  } catch (err) {
    log.error({ err, pair: pair.pairKey }, 'Error paging AMM trades')
  }

  return totalIngested
}
