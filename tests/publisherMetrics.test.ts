// Metrics for the SEP-40 publisher loop (#772).
//
// The publisher is the only code in Lens that signs a transaction, but its
// `CycleReport` used to end in a log line. These tests drive the metered loop
// body with the same recording fakes as src/__tests__/sep40Publisher.test.ts,
// so a call site that forgets a label — or that counts a blocked tick as a
// write — fails here instead of silently skewing /metrics.

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
        pairs: [pair],
        publisher: { enabled: true, pairs: [pair] },
      }),
    },
  }
})

vi.mock('../src/config', () => configMock)
vi.mock('../src/db', () => ({
  pgPool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  prisma: { oraclePublication: { create: vi.fn().mockResolvedValue({}) } },
  upsertPricePoints: vi.fn(),
}))
vi.mock('../src/aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../src/ingest/venues/runner', () => ({ sleep: async () => {} }))

import {
  register,
  publisher_reports_written_total,
  publisher_pairs_blocked_total,
  publisher_writes_failed_total,
  publisher_cycles_failed_total,
  publisher_last_success_timestamp,
  publisher_cycle_duration_seconds,
} from '../src/metrics'
import {
  recordPublicationCycleMetrics,
  runPublicationCycleWithMetrics,
  type AggregateSource,
  type CycleReport,
  type PublicationDeps,
} from '../src/publish/publisher'
import { FeedUnavailableError, FeedWriteError, type Sep40Feed } from '../src/publish/onchain'
import type { Sep40Asset } from '../src/publish/sep40'

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'
const NOW_MS = 1_760_000_400_000
const TICK = 1_760_000_400

const XLM: Sep40Asset = { kind: 'other', symbol: 'XLM' }
const USDC_SAC_ID = new Asset('USDC', configMock.getNetworkConfig().pairs[0].assetB.issuer!).contractId(
  TESTNET_PASSPHRASE
)

interface FeedOptions {
  published?: Record<string, { price: bigint; timestamp: number }>
  reportError?: Error
  parametersError?: Error
}

/** A feed that records instead of acting. */
function fakeFeed(options: FeedOptions = {}) {
  const calls = {
    parameters: 0,
    report: [] as { asset: Sep40Asset; price: bigint; timestamp: number; venues: string[] }[],
  }
  const key = (asset: Sep40Asset) =>
    asset.kind === 'stellar' ? `stellar:${asset.contractId}` : `other:${asset.symbol}`
  const feed: Sep40Feed = {
    network: 'testnet',
    contractId: 'feed',
    async parameters() {
      calls.parameters++
      if (options.parametersError) throw options.parametersError
      return { base: XLM, decimals: 14, resolution: 60 }
    },
    async lastPrice(asset) {
      return options.published?.[key(asset)] ?? null
    },
    async report(input) {
      calls.report.push(input)
      if (options.reportError) throw options.reportError
      return { txHash: 'txhash-1', ledger: 42 }
    },
  }
  return { feed, calls }
}

function fakeDeps(feed: Sep40Feed, aggregateValue: Partial<AggregateSource> = {}) {
  const deps: PublicationDeps = {
    feed,
    pairs: configMock.getNetworkConfig().pairs,
    async aggregate() {
      return { price: 0.05, stale: false, lastTradeAgeSeconds: 5, ...aggregateValue }
    },
    async venues() {
      return ['SDEX', 'aquarius_amm']
    },
    async record() {},
  }
  return deps
}

/** Every sample of a metric, in prom-client's `Metric.get()` shape. */
async function samples(name: string) {
  const metric = await register.getSingleMetric(name)!.get()
  return metric.values
}

function valueFor(
  values: { labels?: Record<string, string | number>; value: number }[],
  match: Record<string, string>
): number {
  return (
    values.find(v => Object.entries(match).every(([key, val]) => (v.labels as Record<string, string>)[key] === val))
      ?.value ?? 0
  )
}

/** One series per label set, with the registry-wide `app` label left in place. */
async function series(name: string) {
  const values = await samples(name)
  return values.map(v => ({ labels: v.labels as Record<string, string>, value: v.value }))
}

/** `_count` samples of the duration histogram, one per network. */
async function durationCount(network: string): Promise<number> {
  const values = await samples('publisher_cycle_duration_seconds')
  return values
    .filter(v => v.metricName === 'publisher_cycle_duration_seconds_count')
    .filter(v => (v.labels as Record<string, string>).network === network)
    .reduce((sum, v) => sum + v.value, 0)
}

async function scrapedLabelNames(metric: string): Promise<string[]> {
  const text = await register.getSingleMetricAsString(metric)
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    if (!new RegExp(`^${metric}(?:_bucket|_count|_sum)?\\{`).test(line)) continue
    const inner = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
    for (const m of inner.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)=/g)) names.add(m[1])
  }
  names.delete('app')
  return [...names].sort()
}

beforeEach(() => {
  vi.restoreAllMocks()
  publisher_reports_written_total.reset()
  publisher_pairs_blocked_total.reset()
  publisher_writes_failed_total.reset()
  publisher_cycles_failed_total.reset()
  publisher_last_success_timestamp.reset()
  publisher_cycle_duration_seconds.reset()
})

describe('publisher cycle metrics', () => {
  it('counts a written report by trigger, observes duration and moves last success', async () => {
    const { feed } = fakeFeed()
    const cycle = await runPublicationCycleWithMetrics('testnet', fakeDeps(feed), NOW_MS)

    expect(cycle.published).toHaveLength(1)
    expect(valueFor(await samples('publisher_reports_written_total'), {
      network: 'testnet',
      trigger: 'first_report',
    })).toBe(1)
    expect(valueFor(await samples('publisher_last_success_timestamp'), { network: 'testnet' })).toBe(
      Math.floor(NOW_MS / 1000)
    )
    expect(await durationCount('testnet')).toBe(1)
  })

  it('separates deviation from max_interval writes', async () => {
    const deviation = fakeFeed({
      published: { [`stellar:${USDC_SAC_ID}`]: { price: 1_000_000_000_000_000n, timestamp: TICK - 300 } },
    })
    await runPublicationCycleWithMetrics('testnet', fakeDeps(deviation.feed), NOW_MS)

    const interval = fakeFeed({
      published: { [`stellar:${USDC_SAC_ID}`]: { price: 2_000_000_000_000_000n, timestamp: TICK - 1000 } },
    })
    await runPublicationCycleWithMetrics('testnet', fakeDeps(interval.feed), NOW_MS)

    const written = await samples('publisher_reports_written_total')
    expect(valueFor(written, { network: 'testnet', trigger: 'deviation' })).toBe(1)
    expect(valueFor(written, { network: 'testnet', trigger: 'max_interval' })).toBe(1)
  })

  it('counts each blocked pair by guard without counting it as a write', async () => {
    const stale = fakeFeed()
    await runPublicationCycleWithMetrics('testnet', fakeDeps(stale.feed, { stale: true }), NOW_MS)

    const noVenue = fakeFeed()
    const deps = fakeDeps(noVenue.feed)
    deps.venues = async () => []
    await runPublicationCycleWithMetrics('testnet', deps, NOW_MS)

    const blocked = await samples('publisher_pairs_blocked_total')
    expect(valueFor(blocked, { network: 'testnet', guard: 'stale_aggregate' })).toBe(1)
    expect(valueFor(blocked, { network: 'testnet', guard: 'no_venue' })).toBe(1)
    expect(await samples('publisher_reports_written_total')).toHaveLength(0)
    expect(await series('publisher_last_success_timestamp')).toHaveLength(0)
  })

  it('keeps the network of each loop on its own series', async () => {
    const testnet = fakeFeed()
    await runPublicationCycleWithMetrics('testnet', fakeDeps(testnet.feed), NOW_MS)

    const mainnet = fakeFeed()
    await runPublicationCycleWithMetrics('mainnet', fakeDeps(mainnet.feed, { stale: true }), NOW_MS)

    expect(valueFor(await samples('publisher_reports_written_total'), {
      network: 'testnet',
      trigger: 'first_report',
    })).toBe(1)
    expect(valueFor(await samples('publisher_pairs_blocked_total'), {
      network: 'mainnet',
      guard: 'stale_aggregate',
    })).toBe(1)
  })

  it('counts a failed write separately and leaves last success alone', async () => {
    const { feed, calls } = fakeFeed({ reportError: new FeedWriteError('contract rejected the report') })
    const cycle = await runPublicationCycleWithMetrics('testnet', fakeDeps(feed), NOW_MS)

    expect(calls.report).toHaveLength(1)
    expect(cycle.failed).toHaveLength(1)
    expect(valueFor(await samples('publisher_writes_failed_total'), { network: 'testnet' })).toBe(1)
    expect(await samples('publisher_reports_written_total')).toHaveLength(0)
    expect(await samples('publisher_pairs_blocked_total')).toHaveLength(0)
    expect(await series('publisher_last_success_timestamp')).toHaveLength(0)
    expect(await durationCount('testnet')).toBe(1)
  })

  it('counts a failed cycle and rethrows so the loop can back off', async () => {
    const { feed } = fakeFeed({ parametersError: new FeedUnavailableError('rpc is down') })
    await expect(runPublicationCycleWithMetrics('testnet', fakeDeps(feed), NOW_MS)).rejects.toThrow(
      FeedUnavailableError
    )

    expect(valueFor(await samples('publisher_cycles_failed_total'), { network: 'testnet' })).toBe(1)
    expect(await durationCount('testnet')).toBe(1)
    expect(await series('publisher_last_success_timestamp')).toHaveLength(0)
  })

  it('maps unknown trigger and guard codes to other', async () => {
    // A code added to trigger.ts but not yet to the bounded set must not mint a
    // new series: this is the shape of a future code, not of today's publisher.
    const cycle = {
      network: 'testnet',
      base: 'other:XLM',
      decimals: 14,
      resolution: 60,
      outcomes: [
        { pairKey: 'blocked-pair', decision: { publish: false, guard: 'future_guard', reason: 'new' } },
        {
          pairKey: 'written-pair',
          decision: {
            publish: true,
            trigger: 'future_trigger',
            feedTimestamp: TICK,
            deviationPct: null,
            publishedAgeMs: null,
            reason: 'new',
          },
        },
      ],
      published: ['written-pair'],
      failed: [],
    } as unknown as CycleReport
    recordPublicationCycleMetrics(cycle, NOW_MS)

    expect(valueFor(await samples('publisher_pairs_blocked_total'), {
      network: 'testnet',
      guard: 'other',
    })).toBe(1)
    expect(valueFor(await samples('publisher_reports_written_total'), {
      network: 'testnet',
      trigger: 'other',
    })).toBe(1)
    expect(await series('publisher_pairs_blocked_total')).toHaveLength(1)
    expect(await series('publisher_reports_written_total')).toHaveLength(1)
  })

  it('exports only bounded labels and no pair identities', async () => {
    const { feed } = fakeFeed()
    await runPublicationCycleWithMetrics('testnet', fakeDeps(feed), NOW_MS)
    await runPublicationCycleWithMetrics('testnet', fakeDeps(feed, { stale: true }), NOW_MS)

    const failedWrite = fakeFeed({ reportError: new FeedWriteError('contract rejected the report') })
    await runPublicationCycleWithMetrics('testnet', fakeDeps(failedWrite.feed), NOW_MS)
    const failedCycle = fakeFeed({ parametersError: new FeedUnavailableError('rpc is down') })
    await expect(runPublicationCycleWithMetrics('testnet', fakeDeps(failedCycle.feed), NOW_MS)).rejects.toThrow(
      FeedUnavailableError
    )

    expect(await scrapedLabelNames('publisher_reports_written_total')).toEqual(['network', 'trigger'])
    expect(await scrapedLabelNames('publisher_pairs_blocked_total')).toEqual(['guard', 'network'])
    expect(await scrapedLabelNames('publisher_writes_failed_total')).toEqual(['network'])
    expect(await scrapedLabelNames('publisher_cycles_failed_total')).toEqual(['network'])
    expect(await scrapedLabelNames('publisher_last_success_timestamp')).toEqual(['network'])
    // `le` is prom-client's histogram bucket label, not a call-site label.
    expect(await scrapedLabelNames('publisher_cycle_duration_seconds')).toEqual(['le', 'network'])

    expect(await register.metrics()).not.toContain(configMock.getNetworkConfig().pairs[0].pairKey)
  })
})
