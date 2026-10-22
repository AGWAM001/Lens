/**
 * The publisher cycle (#222), against a fake feed.
 *
 * What is asserted here is the behaviour an operator can only check after the
 * fact on chain — so it is checked before the fact, with a feed that records
 * every call. The most important assertion in this file is a `not.toHaveProperty`
 * / `toHaveBeenCalledTimes(0)` pair: a blocked tick must not touch the chain at
 * all, because "we read it, decided it was stale, and wrote it anyway" and "we
 * never asked" look identical from the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Asset } from '@stellar/stellar-sdk'

const { configMock } = vi.hoisted(() => {
  const pair = {
    assetA: { code: 'XLM', issuer: null as string | null },
    assetB: {
      code: 'USDC',
      issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    },
    pairKey: 'XLM:native/USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  }
  return {
    configMock: {
      activeNetwork: 'testnet' as const,
      pair,
      config: {
        publisher: {
          deviationPct: 0.5,
          maxIntervalMs: 900_000,
          minWriteIntervalMs: 60_000,
          maxAgeSeconds: 120,
          pollIntervalMs: 30_000,
        },
      },
      getNetworkConfig: (network: string) => ({
        network: {
          passphrase:
            network === 'mainnet'
              ? 'Public Global Stellar Network ; September 2015'
              : 'Test SDF Network ; September 2015',
        },
        publisher: {
          enabled: true,
          contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCD3',
          secretKey: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCD3',
          pairs: [pair],
        },
        pairs: [pair],
      }),
    },
  }
})

vi.mock('../config', () => configMock)
vi.mock('../db', () => ({
  pgPool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  prisma: { oraclePublication: { create: vi.fn().mockResolvedValue({}) } },
  upsertPricePoints: vi.fn(),
}))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../ingest/venues/runner', () => ({ sleep: async () => {} }))

import { runPublicationCycle, type PublicationDeps, type AggregateSource } from '../publish/publisher'
import { FeedUnavailableError, FeedWriteError, type Sep40Feed } from '../publish/onchain'
import type { Sep40Asset } from '../publish/sep40'

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'
const NOW_MS = 1_760_000_400_000
const TICK = 1_760_000_400

const XLM: Sep40Asset = { kind: 'other', symbol: 'XLM' }
// Derived, not copied from a document: the same expression the publisher uses,
// reached from the issuer the pair carries.
const USDC_SAC_ID = new Asset('USDC', configMock.pair.assetB.issuer!).contractId(TESTNET_PASSPHRASE)
const USDC: Sep40Asset = { kind: 'stellar', contractId: USDC_SAC_ID }

interface FeedOptions {
  base?: Sep40Asset
  decimals?: number
  resolution?: number
  published?: Record<string, { price: bigint; timestamp: number }>
  reportError?: Error
  parametersError?: Error
}

/** A feed that records instead of acting. */
function fakeFeed(options: FeedOptions = {}) {
  const calls = {
    parameters: 0,
    lastPrice: [] as Sep40Asset[],
    report: [] as { asset: Sep40Asset; price: bigint; timestamp: number; venues: string[] }[],
  }
  const key = (asset: Sep40Asset) => (asset.kind === 'stellar' ? `stellar:${asset.contractId}` : `other:${asset.symbol}`)
  const feed: Sep40Feed = {
    network: 'testnet',
    contractId: 'feed',
    async parameters() {
      calls.parameters++
      if (options.parametersError) throw options.parametersError
      return {
        base: options.base ?? XLM,
        decimals: options.decimals ?? 14,
        resolution: options.resolution ?? 60,
      }
    },
    async lastPrice(asset) {
      calls.lastPrice.push(asset)
      const entry = options.published?.[key(asset)]
      return entry ?? null
    },
    async report(input) {
      calls.report.push(input)
      if (options.reportError) throw options.reportError
      return { txHash: 'txhash-1', ledger: 42 }
    },
  }
  return { feed, calls }
}

function fakeDeps(
  feed: Sep40Feed,
  aggregateValue: Partial<AggregateSource> = {},
  venues: string[] = ['SDEX', 'aquarius_amm']
) {
  const seen = { aggregate: [] as [string, string][], venues: [] as [string, string][], records: [] as any[] }
  const deps: PublicationDeps = {
    feed,
    pairs: [configMock.pair],
    async aggregate(pairKey, network) {
      seen.aggregate.push([pairKey, network])
      return { price: 0.05, stale: false, lastTradeAgeSeconds: 5, ...aggregateValue }
    },
    async venues(pairKey, network) {
      seen.venues.push([pairKey, network])
      return venues
    },
    async record(row) {
      seen.records.push(row)
    },
  }
  return { deps, seen }
}

describe('runPublicationCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('quotes the pair against the feed’s base, inverting the stored direction', () => {
    // Lens stores 0.05 USDC per XLM. The feed's base is XLM, so what a consumer
    // asks for is the price of USDC in XLM: 20, not 0.05 — and the asset the
    // report is filed under is the USDC contract, not "USDC".
    const { feed, calls } = fakeFeed({ base: XLM })
    const { deps } = fakeDeps(feed)
    return runPublicationCycle('testnet', deps, NOW_MS).then(() => {
      expect(calls.report).toHaveLength(1)
      const report = calls.report[0]
      expect(report.asset).toEqual(USDC)
      expect(report.price).toBe(2_000_000_000_000_000n) // 20 at 14 decimals
      expect(report.timestamp).toBe(TICK)
      expect(report.venues).toEqual(['SDEX', 'aquarius_amm'])
    })
  })

  it('publishes the stored direction when the base is the second leg', () => {
    const { feed, calls } = fakeFeed({ base: USDC })
    const { deps } = fakeDeps(feed)
    return runPublicationCycle('testnet', deps, NOW_MS).then(() => {
      expect(calls.report).toHaveLength(1)
      expect(calls.report[0].asset).toEqual(XLM)
      expect(calls.report[0].price).toBe(5_000_000_000_000n) // 0.05 at 14 decimals
    })
  })

  it('writes nothing for a pair that does not contain the feed’s base', async () => {
    const { feed, calls } = fakeFeed({ base: { kind: 'other', symbol: 'BTC' } })
    const { deps } = fakeDeps(feed)
    const report = await runPublicationCycle('testnet', deps, NOW_MS)
    expect(calls.report).toHaveLength(0)
    expect(calls.lastPrice).toHaveLength(0)
    expect(report.outcomes[0].decision.publish).toBe(false)
    if (!report.outcomes[0].decision.publish) {
      expect(report.outcomes[0].decision.guard).toBe('base_not_in_pair')
    }
  })

  it('does not touch the chain at all for a stale aggregate', async () => {
    const { feed, calls } = fakeFeed()
    const { deps } = fakeDeps(feed, { stale: true })
    const cycle = await runPublicationCycle('testnet', deps, NOW_MS)
    expect(calls.lastPrice).toHaveLength(0)
    expect(calls.report).toHaveLength(0)
    expect(cycle.published).toHaveLength(0)
    expect(cycle.outcomes[0].decision.guard).toBe('stale_aggregate')
  })

  it('does not touch the chain for an aggregate with no venue behind it', async () => {
    const { feed, calls } = fakeFeed()
    const { deps } = fakeDeps(feed, {}, [])
    const cycle = await runPublicationCycle('testnet', deps, NOW_MS)
    expect(calls.lastPrice).toHaveLength(0)
    expect(calls.report).toHaveLength(0)
    expect(cycle.outcomes[0].decision.guard).toBe('no_venue')
  })

  it('refuses a venue name the contract cannot store, rather than sending a doomed write', async () => {
    const { feed, calls } = fakeFeed()
    const { deps } = fakeDeps(feed, {}, ['a_venue_name_that_is_definitely_longer_than_thirty_two_bytes'])
    const cycle = await runPublicationCycle('testnet', deps, NOW_MS)
    expect(calls.report).toHaveLength(0)
    expect(cycle.outcomes[0].decision.guard).toBe('venue_provenance')
  })

  it('asks for the aggregate and the venues on the network it is publishing to', async () => {
    const { feed } = fakeFeed()
    const { deps, seen } = fakeDeps(feed)
    await runPublicationCycle('testnet', deps, NOW_MS)
    expect(seen.aggregate[0][1]).toBe('testnet')
    expect(seen.venues[0][1]).toBe('testnet')
    expect(seen.records[0].network).toBe('testnet')
  })

  it('publishes on deviation from the value already on chain', async () => {
    // The feed holds 10 XLM per USDC; the aggregate says 1/0.06 = 16.666…,
    // which is a 66% move. The reference is the chain, not a local variable, so
    // two publisher instances would make the same call here.
    const { feed, calls } = fakeFeed({
      published: { [`stellar:${USDC_SAC_ID}`]: { price: 1_000_000_000_000_000n, timestamp: TICK - 300 } },
    })
    const { deps } = fakeDeps(feed, { price: 0.06 })
    const cycle = await runPublicationCycle('testnet', deps, NOW_MS)
    expect(calls.report).toHaveLength(1)
    expect(calls.report[0].price).toBe(1_666_666_666_666_667n) // 16.66666666666667 at 14 decimals
    expect(cycle.outcomes[0].decision.publish).toBe(true)
    if (cycle.outcomes[0].decision.publish) {
      expect(cycle.outcomes[0].decision.trigger).toBe('deviation')
    }
  })

  it('does not write when the aggregate matches what the feed already holds', async () => {
    // 20 XLM per USDC is exactly what 0.05 USDC per XLM inverts to, and the
    // feed is only 300 s old: inside the max interval and under the threshold.
    const { feed, calls } = fakeFeed({
      published: { [`stellar:${USDC_SAC_ID}`]: { price: 2_000_000_000_000_000n, timestamp: TICK - 300 } },
    })
    const { deps } = fakeDeps(feed, { price: 0.05 })
    const cycle = await runPublicationCycle('testnet', deps, NOW_MS)
    expect(calls.report).toHaveLength(0)
    expect(cycle.outcomes[0].decision.guard).toBe('below_deviation')
  })

  it('records provenance on every published row and calls it published only after the write', async () => {
    const { feed } = fakeFeed()
    const { deps, seen } = fakeDeps(feed)
    await runPublicationCycle('testnet', deps, NOW_MS)
    expect(seen.records).toHaveLength(1)
    const row = seen.records[0]
    expect(row.state).toBe('published')
    expect(row.trigger).toBe('first_report')
    expect(row.venues).toBe('SDEX,aquarius_amm')
    expect(row.sourceCount).toBe(2)
    expect(row.quotedAsset).toBe(USDC_SAC_ID)
    expect(row.baseAsset).toBe('other:XLM')
    expect(row.price).toBe(20)
    expect(row.scaledPrice).toBe('2000000000000000')
    expect(row.txHash).toBe('txhash-1')
  })

  it('audits a failed write with the number it tried to publish', async () => {
    const { feed, calls } = fakeFeed({ reportError: new FeedWriteError('contract rejected the report: NotNewer') })
    const { deps, seen } = fakeDeps(feed)
    const cycle = await runPublicationCycle('testnet', deps, NOW_MS)
    expect(calls.report).toHaveLength(1)
    expect(cycle.failed).toEqual([configMock.pair.pairKey])
    expect(seen.records).toHaveLength(1)
    expect(seen.records[0].state).toBe('failed')
    expect(seen.records[0].errorMessage).toContain('NotNewer')
  })

  it('aborts the whole cycle when the feed’s parameters cannot be read', async () => {
    // Fail closed: with no decimals there is no correct scale to publish at,
    // and the outer loop is the right place to back off.
    const { feed, calls } = fakeFeed({ parametersError: new FeedUnavailableError('rpc is down') })
    const { deps } = fakeDeps(feed)
    await expect(runPublicationCycle('testnet', deps, NOW_MS)).rejects.toThrow(FeedUnavailableError)
    expect(calls.report).toHaveLength(0)
  })

  it('keeps going after one pair fails so a bad pair cannot silence the feed', async () => {
    const { feed, calls } = fakeFeed()
    const { deps, seen } = fakeDeps(feed)
    deps.pairs = [
      { assetA: { code: 'BAD', issuer: 'not-an-account' }, assetB: { code: 'USD', issuer: null }, pairKey: 'BAD/USD' },
      configMock.pair,
    ]
    const cycle = await runPublicationCycle('testnet', deps, NOW_MS)
    expect(cycle.outcomes[0].decision.guard).toBe('asset_identity')
    expect(calls.report).toHaveLength(1)
    expect(cycle.published).toEqual([configMock.pair.pairKey])
    expect(seen.records).toHaveLength(1)
  })
})
