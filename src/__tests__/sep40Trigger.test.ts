/**
 * The publication policy (#222): deviation, maximum interval, and the guards
 * that outrank both.
 *
 * All of it is arithmetic on injected values, so no clock, chain or database is
 * involved — which is also the point: the rule "a stale aggregate is never
 * published" is asserted here as a property of the decision function, not as a
 * hope about how the loop behaves on a Tuesday.
 */
import { describe, it, expect } from 'vitest'
import {
  decidePublication,
  deviationPercent,
  evaluateGuards,
  feedTimestamp,
  type AggregateSnapshot,
  type PublishedSnapshot,
  type TriggerThresholds,
} from '../publish/trigger'

const NOW_MS = 1_760_000_400_000
const TICK = 1_760_000_400 // NOW_MS floored to a 60-second tick

const thresholds: TriggerThresholds = {
  deviationPct: 0.5,
  maxIntervalMs: 900_000,
  minWriteIntervalMs: 60_000,
  maxAgeSeconds: 120,
  resolutionSeconds: 60,
}

function aggregate(overrides: Partial<AggregateSnapshot> = {}): AggregateSnapshot {
  return {
    pairKey: 'XLM:native/USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    price: 0.05,
    venues: ['SDEX', 'aquarius_amm'],
    stale: false,
    lastTradeAgeSeconds: 5,
    ...overrides,
  }
}

/** On-chain reference, by default a comfortable 600 s ago: past the rate floor,
 *  inside the max interval, so a test that wants a trigger gets to choose it. */
function published(price = 0.05, secondsAgo = 600): PublishedSnapshot {
  return { price, timestamp: TICK - secondsAgo }
}

describe('feedTimestamp', () => {
  it('is SEP-40’s floor(unix_now()/resolution)*resolution', () => {
    expect(feedTimestamp(NOW_MS, 60)).toBe(TICK)
    expect(feedTimestamp(1_760_000_459_999, 60)).toBe(1_760_000_400)
    expect(feedTimestamp(1_760_000_459_999, 300)).toBe(1_760_000_400)
    expect(feedTimestamp(1_760_000_000_000, 1)).toBe(1_760_000_000)
  })

  it('throws rather than dividing by a resolution the feed did not declare', () => {
    expect(() => feedTimestamp(NOW_MS, 0)).toThrow(/positive whole number/)
  })
})

describe('deviationPercent', () => {
  it('measures the move relative to the value being replaced', () => {
    expect(deviationPercent(100, 101)).toBeCloseTo(1, 10)
    expect(deviationPercent(100, 99)).toBeCloseTo(1, 10)
    expect(deviationPercent(0.04, 0.05)).toBeCloseTo(25, 10)
  })

  it('reads an uncomparable reference as infinite, never as "no movement"', () => {
    // A published zero would otherwise look like a price that never changes,
    // and the feed would stay silent forever.
    expect(deviationPercent(0, 0.05)).toBe(Infinity)
    expect(deviationPercent(NaN, 0.05)).toBe(Infinity)
  })
})

describe('guards outrank triggers', () => {
  it('does not publish a stale aggregate, even on a first report', () => {
    const decision = decidePublication(aggregate({ stale: true }), null, thresholds, NOW_MS)
    expect(decision.publish).toBe(false)
    if (!decision.publish) expect(decision.guard).toBe('stale_aggregate')
  })

  it('does not publish a stale aggregate just because the interval elapsed', () => {
    // The one combination that would otherwise turn "stale" into a write: the
    // max-interval trigger with nothing but old data to say.
    const decision = decidePublication(aggregate({ stale: true }), published(0.05, 5_000), thresholds, NOW_MS)
    expect(decision.publish).toBe(false)
    if (!decision.publish) expect(decision.guard).toBe('stale_aggregate')
  })

  it('blocks an unsourced number before anything else is considered', () => {
    const decision = decidePublication(
      aggregate({ venues: [], stale: true }),
      published(0.05, 5_000),
      thresholds,
      NOW_MS
    )
    expect(decision.publish).toBe(false)
    if (!decision.publish) expect(decision.guard).toBe('no_venue')
  })

  it('blocks a price that is not positive', () => {
    for (const price of [0, -3.5, Number.NaN]) {
      const decision = decidePublication(aggregate({ price }), null, thresholds, NOW_MS)
      expect(decision.publish).toBe(false)
      if (!decision.publish) expect(decision.guard).toBe('invalid_price')
    }
  })

  it('blocks a pair with no observation at all on this network', () => {
    const decision = decidePublication(aggregate({ lastTradeAgeSeconds: null }), null, thresholds, NOW_MS)
    expect(decision.publish).toBe(false)
    if (!decision.publish) expect(decision.guard).toBe('no_observation')
  })

  it('blocks an aggregate older than the feed allows, even when the aggregator calls it fresh', () => {
    // The API's own stale flag trips at 300 s; the feed is deliberately
    // stricter, so 200 s passes the API and fails here.
    const decision = decidePublication(aggregate({ lastTradeAgeSeconds: 200 }), published(0.04, 600), thresholds, NOW_MS)
    expect(decision.publish).toBe(false)
    if (!decision.publish) expect(decision.guard).toBe('aggregate_too_old')
  })

  it('is reusable on its own, for a caller that wants to skip without reading the chain', () => {
    expect(evaluateGuards(aggregate({ stale: true }), thresholds, TICK)?.guard).toBe('stale_aggregate')
    expect(evaluateGuards(aggregate(), thresholds, TICK)).toBeNull()
  })
})

describe('triggers', () => {
  it('publishes the first report for an asset the feed does not hold', () => {
    const decision = decidePublication(aggregate(), null, thresholds, NOW_MS)
    expect(decision.publish).toBe(true)
    if (decision.publish) {
      expect(decision.trigger).toBe('first_report')
      expect(decision.feedTimestamp).toBe(TICK)
      expect(decision.deviationPct).toBeNull()
    }
  })

  it('publishes when the price moves past the deviation threshold', () => {
    const decision = decidePublication(aggregate({ price: 0.051 }), published(0.05), thresholds, NOW_MS)
    expect(decision.publish).toBe(true)
    if (decision.publish) {
      expect(decision.trigger).toBe('deviation')
      expect(decision.deviationPct).toBeCloseTo(2, 8)
      expect(decision.publishedAgeMs).toBe(600_000)
    }
  })

  it('publishes without movement once the feed is at its maximum age', () => {
    const decision = decidePublication(aggregate({ price: 0.05 }), published(0.05, 1_000), thresholds, NOW_MS)
    expect(decision.publish).toBe(true)
    if (decision.publish) expect(decision.trigger).toBe('max_interval')
  })

  it('stays silent inside both windows', () => {
    const decision = decidePublication(aggregate({ price: 0.05001 }), published(0.05, 300), thresholds, NOW_MS)
    expect(decision.publish).toBe(false)
    if (!decision.publish) expect(decision.guard).toBe('below_deviation')
  })

  it('takes the deviation branch when both windows are exceeded', () => {
    const decision = decidePublication(aggregate({ price: 0.06 }), published(0.05, 1_000), thresholds, NOW_MS)
    expect(decision.publish).toBe(true)
    if (decision.publish) expect(decision.trigger).toBe('deviation')
  })

  it('republishes when what is on chain cannot be compared', () => {
    const decision = decidePublication(aggregate({ price: 0.05 }), published(0, 300), thresholds, NOW_MS)
    expect(decision.publish).toBe(true)
    if (decision.publish) expect(decision.trigger).toBe('deviation')
  })
})

describe('write rate limiting', () => {
  it('vetoed a deviation that arrived inside the minimum write interval', () => {
    const decision = decidePublication(
      aggregate({ price: 0.06 }),
      published(0.05, 30),
      thresholds,
      NOW_MS
    )
    expect(decision.publish).toBe(false)
    if (!decision.publish) {
      expect(decision.guard).toBe('min_write_interval')
      // The reason says what was suppressed, so an operator reading the log can
      // tell "nothing happened" from "something happened and was rate-limited".
      expect(decision.suppressedBy).toBe('deviation')
    }
  })

  it('vetoed a max-interval refresh inside the minimum write interval', () => {
    const decision = decidePublication(
      aggregate(),
      { price: 0.05, timestamp: TICK - 30 },
      { ...thresholds, maxIntervalMs: 10_000 },
      NOW_MS
    )
    expect(decision.publish).toBe(false)
    if (!decision.publish) {
      expect(decision.guard).toBe('min_write_interval')
      expect(decision.suppressedBy).toBe('max_interval')
    }
  })

  it('does not send a write the contract would reject as NotNewer', () => {
    // Two polls inside the same tick: the second has the same trimmed
    // timestamp, and the contract requires a strictly newer one.
    const decision = decidePublication(
      aggregate({ price: 0.06 }),
      published(0.05, 0),
      thresholds,
      NOW_MS
    )
    expect(decision.publish).toBe(false)
    if (!decision.publish) {
      expect(decision.guard).toBe('tick_not_advanced')
      expect(decision.suppressedBy).toBe('deviation')
    }
  })

  it('never writes twice inside a tick even when both branches would allow it', () => {
    const first = decidePublication(aggregate({ price: 0.06 }), published(0.05, 120), thresholds, NOW_MS)
    expect(first.publish).toBe(true)
    // Same instant, same tick, larger move: rate-limited, not a second write.
    const second = decidePublication(aggregate({ price: 0.08 }), published(0.06, 0), thresholds, NOW_MS)
    expect(second.publish).toBe(false)
  })

  it('publishes at most once per resolution tick across a simulated hour of polling', () => {
    // 30-second polls for one hour with a price that jitters above the
    // threshold on every sample. Expected writes: the deviation-driven ones,
    // bounded by the 60 s tick — not 120.
    let writes = 0
    let onChain: PublishedSnapshot | null = { price: 0.05, timestamp: TICK - 600 }
    let price = 0.05
    for (let offset = 0; offset < 3_600_000; offset += 30_000) {
      price = price === 0.05 ? 0.052 : 0.05
      const decision = decidePublication(aggregate({ price }), onChain, thresholds, NOW_MS + offset)
      if (decision.publish) {
        writes++
        onChain = { price, timestamp: decision.feedTimestamp }
      }
    }
    expect(writes).toBeLessThanOrEqual(60)
    expect(writes).toBeGreaterThan(0)
  })
})
