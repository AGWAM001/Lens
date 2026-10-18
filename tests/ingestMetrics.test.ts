// Regression tests for network-scoped ingest metrics.
//
// Every ingester runs once per ENABLED network against one shared prom-client
// Registry (see src/metrics.ts). Before `network` was a label on the ingest
// metrics, both loops wrote to the same series for the same pair. For the
// counters that meant a silent merge; for `last_trade_timestamp` — a
// `Gauge.set()`, i.e. last-writer-wins — the testnet loop could overwrite the
// mainnet value outright, which made the only staleness signal Lens exports
// unusable on a dual-network deployment.
//
// These tests drive the real ingesters rather than poking the registry, so a
// call site that forgets the label fails here too.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  upsertPricePoints: vi.fn(),
  getIndexerState: vi.fn(),
  setIndexerCursor: vi.fn(),
  poolSnapshotCreate: vi.fn(),
  query: vi.fn(),
  getActivePairs: vi.fn(),
  dispatchPriceUpdate: vi.fn(),
  publishPriceUpdate: vi.fn(),
  /** Records the stubbed SDEX Horizon server hands back. */
  sdexRecords: [] as any[],
}))

vi.mock('../src/db', () => ({
  upsertPricePoints: mocks.upsertPricePoints,
  getIndexerState: mocks.getIndexerState,
  setIndexerCursor: mocks.setIndexerCursor,
  prisma: { poolSnapshot: { create: mocks.poolSnapshotCreate } },
  pgPool: { query: mocks.query },
}))

vi.mock('../src/pairsRegistry', () => ({ getActivePairs: mocks.getActivePairs }))

vi.mock('../src/webhookDispatcher', () => ({
  dispatchPriceUpdate: mocks.dispatchPriceUpdate,
}))

vi.mock('../src/events', () => ({ publishPriceUpdate: mocks.publishPriceUpdate }))

// The SDEX ingester builds its trade query off a Horizon client; a chainable
// stub is enough — the point of the test is what happens after `.call()`.
vi.mock('../src/network/clients', () => {
  const server: any = {
    trades: () => server,
    forAssetPair: () => server,
    cursor: () => server,
    limit: () => server,
    order: () => server,
    call: () => Promise.resolve({ records: mocks.sdexRecords }),
  }
  return { getHorizonServer: () => server, getRpcServer: () => ({}) }
})

import {
  register,
  trades_ingested_total,
  amm_snapshots_total,
  price_snapshots_total,
  last_trade_timestamp,
} from '../src/metrics'
import { ingestPair } from '../src/ingesters/sdex'
import { snapshotPool, ingestPoolTrades } from '../src/ingesters/amm'
import { appendSnapshots } from '../src/ingesters/snapshot'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const pair = {
  pairKey: 'XLM/USDC',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: USDC_ISSUER },
}

/** One Horizon trade record, closing at `iso` with the given price. */
function trade(iso: string, price: { n: number; d: number }, id: string) {
  return {
    id,
    paging_token: `p-${id}`,
    base_asset_type: 'native',
    base_asset_code: 'XLM',
    base_amount: '100.0',
    counter_amount: '20.0',
    price,
    ledger_close_time: iso,
  }
}

/** Every sample of a metric, keyed by its label set. */
async function samples(name: string) {
  const metric = await register.getSingleMetric(name)!.get()
  return metric.values
}

/** `{ network: 'mainnet': 5, network: 'testnet': 3 }`-shaped lookup by label. */
function byLabel(values: { labels?: Record<string, string | number>; value: number }[], label: string) {
  return Object.fromEntries(
    values.map(v => [String((v.labels as Record<string, string>)[label]), v.value])
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // The Registry is a module singleton shared by everything in this file, so
  // every metric touched here is reset between cases.
  trades_ingested_total.reset()
  amm_snapshots_total.reset()
  price_snapshots_total.reset()
  last_trade_timestamp.reset()

  // These fixtures use synthetic paging tokens, which carry no TOID, so the
  // ingesters fall back to the ledger stored on the cursor row.
  mocks.getIndexerState.mockResolvedValue({ cursor: '0', ledger: 64702061 })
  mocks.getActivePairs.mockReturnValue([pair])
  mocks.dispatchPriceUpdate.mockResolvedValue(undefined)
  mocks.query.mockResolvedValue({ rowCount: 1 })
  mocks.sdexRecords = []
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ _embedded: { records: [] } }) })
})

describe('trades_ingested_total', () => {
  it('keeps one series per network for the same pair', async () => {
    mocks.sdexRecords = [
      trade('2024-06-01T00:00:00Z', { n: 2, d: 10 }, 't-1'),
      trade('2024-06-01T00:00:01Z', { n: 2, d: 10 }, 't-2'),
    ]

    await ingestPair(pair as never, 'testnet')
    await ingestPair(pair as never, 'mainnet')

    const values = await samples('trades_ingested_total')
    expect(values).toHaveLength(2)
    expect(byLabel(values, 'network')).toEqual({ testnet: 2, mainnet: 2 })

    // `pair` is still the pairing key; `network` is an addition, not a swap.
    for (const v of values) {
      expect(v.labels!.pair).toBe('XLM/USDC')
    }
  })

  it('does not let one network overwrite the other across interleaved loops', async () => {
    // Production order: the two poll loops interleave, so the two networks
    // write to the registry in an arbitrary order on every tick.
    mocks.sdexRecords = [trade('2024-06-01T00:00:00Z', { n: 2, d: 10 }, 't-1')]
    await ingestPair(pair as never, 'testnet')
    await ingestPair(pair as never, 'mainnet')
    await ingestPair(pair as never, 'testnet')
    await ingestPair(pair as never, 'mainnet')

    expect(byLabel(await samples('trades_ingested_total'), 'network')).toEqual({
      testnet: 2,
      mainnet: 2,
    })
  })

  it('produces a single series on a single-network deployment', async () => {
    mocks.sdexRecords = [trade('2024-06-01T00:00:00Z', { n: 2, d: 10 }, 't-1')]

    await ingestPair(pair as never, 'mainnet')
    await ingestPair(pair as never, 'mainnet')

    const values = await samples('trades_ingested_total')
    expect(values).toHaveLength(1)
    expect(values[0].value).toBe(2)
  })
})

describe('last_trade_timestamp', () => {
  it('keeps a separate staleness value per network instead of overwriting one', async () => {
    // Testnet closes at 2024-06-01, mainnet at 2024-07-01 — mainnet is the
    // newer trade. Before the label existed, mainnet's `.set()` clobbered the
    // testnet value and the series reported a single, wrong timestamp.
    const testnetTs = Date.parse('2024-06-01T00:00:00Z') / 1000
    const mainnetTs = Date.parse('2024-07-01T00:00:00Z') / 1000

    mocks.sdexRecords = [trade('2024-06-01T00:00:00Z', { n: 2, d: 10 }, 't-1')]
    await ingestPair(pair as never, 'testnet')
    mocks.sdexRecords = [trade('2024-07-01T00:00:00Z', { n: 2, d: 10 }, 't-2')]
    await ingestPair(pair as never, 'mainnet')

    const values = await samples('last_trade_timestamp')
    expect(values).toHaveLength(2)
    expect(byLabel(values, 'network')).toEqual({ testnet: testnetTs, mainnet: mainnetTs })
  })

  it('tracks the AMM loop per network too', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        _embedded: {
          records: [
            {
              id: 'a-1',
              paging_token: 'pa-1',
              base_asset_type: 'native',
              base_asset_code: 'XLM',
              base_amount: '100.0',
              counter_amount: '20.0',
              ledger_close_time: '2024-06-01T00:00:00Z',
            },
          ],
        },
      }),
    })

    const pool = { id: 'pool-1', reserves: [{ asset: 'native', amount: '1' }] }
    await ingestPoolTrades(pool, pair as never, 'testnet')
    await ingestPoolTrades(pool, pair as never, 'mainnet')

    const values = await samples('last_trade_timestamp')
    expect(values).toHaveLength(2)
    expect(byLabel(values, 'network')).toEqual({
      testnet: Date.parse('2024-06-01T00:00:00Z') / 1000,
      mainnet: Date.parse('2024-06-01T00:00:00Z') / 1000,
    })
  })
})

describe('amm_snapshots_total', () => {
  it('separates the same pool id by network', async () => {
    const pool = {
      id: 'pool-1',
      reserves: [
        { asset: 'native', amount: '100.0' },
        { asset: `USDC:${USDC_ISSUER}`, amount: '20.0' },
      ],
      total_shares: '50',
      last_modified_ledger: 12345,
    }

    await snapshotPool(pool, pair as never, 'testnet')
    await snapshotPool(pool, pair as never, 'mainnet')

    const values = await samples('amm_snapshots_total')
    expect(values).toHaveLength(2)
    expect(byLabel(values, 'network')).toEqual({ testnet: 1, mainnet: 1 })
    for (const v of values) expect(v.labels!.pool).toBe('pool-1')
  })
})

describe('price_snapshots_total', () => {
  it('labels the snapshot counter by the network that appended the rows', async () => {
    mocks.query.mockResolvedValue({ rowCount: 2 })

    await appendSnapshots(new Date('2024-06-01T00:00:30Z'), 'testnet')
    await appendSnapshots(new Date('2024-06-01T00:00:30Z'), 'mainnet')

    const values = await samples('price_snapshots_total')
    expect(values).toHaveLength(2)
    expect(byLabel(values, 'network')).toEqual({ testnet: 2, mainnet: 2 })
  })

  it('does not create a series when a re-run inserts nothing', async () => {
    mocks.query.mockResolvedValue({ rowCount: 0 })

    await appendSnapshots(new Date('2024-06-01T00:00:30Z'), 'testnet')

    expect(await samples('price_snapshots_total')).toHaveLength(0)
  })
})

describe('label cardinality', () => {
  /**
   * Label names actually scraped for a metric, minus the registry-wide default
   * label — i.e. exactly what a call site controls.
   */
  async function scrapedLabelNames(metric: string): Promise<string[]> {
    const text = await register.getSingleMetricAsString(metric)
    const names = new Set<string>()
    for (const line of text.split('\n')) {
      if (!line.startsWith(`${metric}{`)) continue
      const inner = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
      for (const m of inner.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)=/g)) names.add(m[1])
    }
    names.delete('app') // setDefaultLabels({ app: 'lens' }), not a call-site label
    return [...names].sort()
  }

  it('labels every ingest metric by network and nothing unbounded', async () => {
    // Seeding is not the point — a metric with no samples exposes no labels in
    // the scrape, so write one sample into each first.
    mocks.sdexRecords = [trade('2024-06-01T00:00:00Z', { n: 2, d: 10 }, 't-1')]
    await ingestPair(pair as never, 'testnet')
    await snapshotPool(
      {
        id: 'pool-1',
        reserves: [
          { asset: 'native', amount: '100.0' },
          { asset: `USDC:${USDC_ISSUER}`, amount: '20.0' },
        ],
        total_shares: '50',
      },
      pair as never,
      'testnet',
    )
    await appendSnapshots(new Date('2024-06-01T00:00:30Z'), 'testnet')

    expect(await scrapedLabelNames('trades_ingested_total')).toEqual(['network', 'pair'])
    expect(await scrapedLabelNames('last_trade_timestamp')).toEqual(['network', 'pair'])
    expect(await scrapedLabelNames('amm_snapshots_total')).toEqual(['network', 'pool'])
    expect(await scrapedLabelNames('price_snapshots_total')).toEqual(['network'])
  })

  it('never puts an issuer in a label', async () => {
    mocks.sdexRecords = [trade('2024-06-01T00:00:00Z', { n: 2, d: 10 }, 't-1')]
    await ingestPair(pair as never, 'testnet')
    await snapshotPool(
      {
        id: 'pool-1',
        reserves: [
          { asset: 'native', amount: '100.0' },
          { asset: `USDC:${USDC_ISSUER}`, amount: '20.0' },
        ],
        total_shares: '50',
      },
      pair as never,
      'testnet',
    )
    await appendSnapshots(new Date('2024-06-01T00:00:30Z'), 'testnet')

    // An issuer label would multiply series by every token in the config and is
    // deliberately out of scope — see docs/ingest-metrics.md.
    const scrape = await register.metrics()
    expect(scrape).not.toContain(USDC_ISSUER)
  })

  it('mints one series per pair per network, not per ingest', async () => {
    const pairs = [
      { ...pair },
      {
        pairKey: 'XLM/USDB',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDB', issuer: USDC_ISSUER },
      },
    ]
    mocks.getActivePairs.mockReturnValue(pairs)
    mocks.sdexRecords = [trade('2024-06-01T00:00:00Z', { n: 2, d: 10 }, 't-1')]

    // 2 pairs x 2 networks x 3 repeated ticks = 2 series per pair, not 12.
    for (let tick = 0; tick < 3; tick++) {
      for (const p of pairs) {
        await ingestPair(p as never, 'testnet')
        await ingestPair(p as never, 'mainnet')
      }
    }

    const values = await samples('trades_ingested_total')
    expect(values).toHaveLength(4) // pairs(2) x networks(2)

    const series = Object.fromEntries(
      values.map(v => [`${v.labels!.pair}/${v.labels!.network}`, v.value])
    )
    expect(series).toEqual({
      'XLM/USDC/testnet': 3,
      'XLM/USDC/mainnet': 3,
      'XLM/USDB/testnet': 3,
      'XLM/USDB/mainnet': 3,
    })
  })
})
