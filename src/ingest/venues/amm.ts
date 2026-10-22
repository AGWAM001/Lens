import { amm_snapshots_total, trades_ingested_total, last_trade_timestamp, markIngestSuccess } from '../../metrics'
import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import { upsertPricePoints, getIndexerState, setIndexerCursor, prisma } from '../../db'
import { resolvePageLedgers } from '../../ingesters/toid'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import { createLogger } from '../../logger'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  setLastPrice,
  startVenueAdapter,
} from './runner'
import { fetchWithTimeout } from '../../fetch'

const log = createLogger('ingester:amm')

export function _resetLastPrice(): void {
  resetLastPrice('AMM')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('AMM', network, pairKey)
}

export async function fetchPools(pair: WatchedPair, network: NetworkName = activeNetwork): Promise<any[]> {
  try {
    const assetAStr = pair.assetA.issuer
      ? `${pair.assetA.code}:${pair.assetA.issuer}`
      : 'native'
    const assetBStr = pair.assetB.issuer
      ? `${pair.assetB.code}:${pair.assetB.issuer}`
      : 'native'

    const params = new URLSearchParams()
    params.append('reserves[]', assetAStr)
    params.append('reserves[]', assetBStr)
    params.set('limit', '10')

    const response = await fetchWithTimeout(
      `${getNetworkConfig(network).horizon.url}/liquidity_pools?${params.toString()}`
    )
    const data = (await response.json()) as any
    if (!data._embedded?.records) return []
    return data._embedded.records
  } catch (err) {
    log.error({ pair: pair.pairKey, err }, 'failed to fetch pools')
    return []
  }
}

export async function snapshotPool(
  pool: any,
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): Promise<void> {
  try {
    const r0 = pool.reserves[0]
    const r1 = pool.reserves[1]

    const code0 = r0.asset === 'native' ? 'XLM' : r0.asset.split(':')[0]
    const isForward = code0 === pair.assetA.code

    const reserveA = parseFloat(isForward ? r0.amount : r1.amount)
    const reserveB = parseFloat(isForward ? r1.amount : r0.amount)
    const spotPrice = reserveA > 0 ? reserveB / reserveA : 0
    const feeBp = pool.fee_bp ?? 30

    await prisma.poolSnapshot.create({
      data: {
        network,
        poolId: pool.id,
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        reserveA,
        reserveB,
        spotPrice,
        totalShares: parseFloat(pool.total_shares ?? '0'),
        feeBp,
        ledger: pool.last_modified_ledger ?? 0,
        timestamp: new Date(),
      },
    })

    amm_snapshots_total.inc({ pool: pool.id, network })

    // Also record spot price as a price point (no volume — it's a snapshot, not a trade)
    if (spotPrice > 0) {
      await upsertPricePoints(
        [
          {
            assetA: pair.assetA.code,
            assetB: pair.assetB.code,
            pairKey: pair.pairKey,
            source: 'AMM',
            poolId: pool.id,
            price: spotPrice,
            baseVolume: 0,
            counterVolume: 0,
            ledger: pool.last_modified_ledger ?? 0,
            timestamp: new Date(),
            // #237: snapshot price points have no trade event to key on, so
            // the id is derived from the pool's STATE — (pool, ledger) is the
            // version of the reserves, and two ingesters that read the same
            // ledger hold the same spot price. A `Date.now()` id here would
            // mint a fresh identity per attempt, which is exactly the random
            // key the replay absorbing rejects: retried batches and overlapping
            // instances would each insert the same observation again.
            eventId: `amm-snapshot-${pool.id}-${pool.last_modified_ledger ?? 0}`,
          },
        ],
        network
      )
      markIngestSuccess('AMM', network)

      const trackerKey = pair.pairKey
      const { previousPrice } = setLastPrice('AMM', network, trackerKey, spotPrice)

      publishPriceUpdate({
        pair: pair.pairKey,
        price: spotPrice,
        ts: new Date().toISOString(),
        network,
      })

      dispatchPriceUpdate({
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        previousPrice,
        currentPrice: spotPrice,
        network,
      }).catch((err) => log.error({ pool: pool.id, err }, 'webhook dispatch error'))
    }
  } catch (err) {
    log.error({ pool: pool.id, err }, 'snapshot error')
  }
}

export async function ingestPoolTrades(
  pool: any,
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): Promise<void> {
  const stateId = `amm:${network}:${pool.id}`
  const state = await getIndexerState(stateId, network)
  const cursor = state.cursor ?? '0'

  try {
    const response = await fetchWithTimeout(
      `${getNetworkConfig(network).horizon.url}/liquidity_pools/${pool.id}/trades?cursor=${cursor}&limit=${config.indexer.ammPageSize}&order=asc`
    )
    const data = (await response.json()) as any
    const records = data._embedded?.records ?? []

    if (!records.length) return

    // Horizon returns no `ledger` on a pool trade; it lives in the TOID prefix.
    const ledgers = resolvePageLedgers(
      records.map((t: any) => t.paging_token ?? t.id),
      state.ledger
    )
    if (ledgers === null) {
      log.error(
        { pool: pool.id, trades: records.length },
        'no ledger derivable from trades; skipping batch'
      )
      return
    }

    const points: VenuePricePoint[] = records.map((t: any, i: number) => {
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

    const trackerKey = pair.pairKey
    const { previousPrice, currentPrice } = setLastPrice(
      'AMM',
      network,
      trackerKey,
      points[points.length - 1].price
    )

    await upsertPricePoints(points, network)
    markIngestSuccess('AMM', network)

    trades_ingested_total.inc({ pair: pair.pairKey, network }, points.length)
    last_trade_timestamp.set(
      { pair: pair.pairKey, network },
      Math.floor(points[points.length - 1].timestamp.getTime() / 1000)
    )

    const lastRecord = records[records.length - 1]
    await setIndexerCursor(stateId, lastRecord.paging_token, network, ledgers[ledgers.length - 1])
    log.info({ pair: pair.pairKey, pool: pool.id, trades: points.length }, 'ingested pool trades')

    publishPriceUpdate({
      pair: pair.pairKey,
      price: currentPrice,
      ts: points[points.length - 1].timestamp.toISOString(),
      network,
    })

    dispatchPriceUpdate({
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      previousPrice,
      currentPrice,
      network,
    }).catch((err) => log.error({ pool: pool.id, err }, 'webhook dispatch error'))
  } catch (err) {
    log.error({ pool: pool.id, err }, 'trade ingest error')
  }
}

export async function ingestPair(pair: WatchedPair, network: NetworkName = activeNetwork): Promise<void> {
  const pools = await fetchPools(pair, network)
  log.info({ pair: pair.pairKey, pools: pools.length }, 'found AMM pools')

  await Promise.all(
    pools.map(async (pool) => {
      await snapshotPool(pool, pair, network)
      await ingestPoolTrades(pool, pair, network)
    })
  )
}

export const ammAdapter: VenueAdapter<any, any> = {
  name: 'AMM',
  kind: 'amm',
  source: 'AMM',

  isEnabled(_network: NetworkName): boolean {
    return true
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<any[]> {
    return fetchPools(pair, network)
  },

  async read(pool: any, _pair: WatchedPair, _network: NetworkName): Promise<any | null> {
    return pool
  },

  derive(_raw: any, _pool: any, _pair: WatchedPair, _network: NetworkName): VenuePricePoint[] {
    return []
  },

  async write(_points: VenuePricePoint[], pool: any, pair: WatchedPair, network: NetworkName): Promise<void> {
    await snapshotPool(pool, pair, network)
    await ingestPoolTrades(pool, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestPair(pair, network)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startAMMIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(ammAdapter, network)
}
