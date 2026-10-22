/**
 * When Lens is allowed to write to its SEP-40 feed (#222).
 *
 * A tick is not an event. Lens polls every few seconds, so a naive publisher
 * writes on every sample and turns a price feed into a transaction spam bot —
 * while also publishing the noise between trades. The contract itself only
 * knows how to store a report; the *policy* of when to call it lives here, as a
 * pure function over (aggregate, what is already on chain, thresholds) so the
 * whole rule set is testable without a chain, a database or a clock.
 *
 * Two rules dominate the ordering below:
 *
 * 1. "A stale aggregate is never published" is a guard, not a trigger. Every
 *    staleness check runs BEFORE any trigger is evaluated, so an old price can
 *    never reach chain because a timer elapsed.
 * 2. "Every row carries the venue it came from" — an aggregate whose venues we
 *    cannot name is not publishable either. A blended number that quietly
 *    averages a live market and a dead one is worse than no feed at all.
 *
 * The deviation reference is the value ALREADY ON CHAIN (`lastprice`), not a
 * local variable. Two publisher instances — a canary and the real one, or a
 * restart racing itself — then agree on what "moved" means, and neither can
 * double-write because both see the same last tick.
 */

/** Codes are stable strings: they are what the audit row and the log line carry. */
export type PublicationGuard =
  /** We cannot name a single venue behind the number, so we cannot source it. */
  | 'no_venue'
  /** Zero / negative / non-finite price. */
  | 'invalid_price'
  /** No trade has ever been seen for this pair on this network. */
  | 'no_observation'
  /** The aggregator itself flagged the series as stale. */
  | 'stale_aggregate'
  /** Newer than the aggregator's own threshold, but older than the feed allows. */
  | 'aggregate_too_old'
  /** The price moved, but less than `deviationPct`. */
  | 'below_deviation'
  /**
   * A trigger fired, but the previous report is too recent for another write.
   * Writes are spaced by the feed's tick, so the effective floor on the spacing
   * between reports is `max(minWriteIntervalMs, resolutionSeconds)`.
   */
  | 'min_write_interval'
  /**
   * A trigger fired, but the tick has not advanced since the last report — the
   * contract would refuse it (`NotNewer`), so we do not send a doomed tx.
   */
  | 'tick_not_advanced'

export type PublicationTrigger = 'first_report' | 'deviation' | 'max_interval'

/** What Lens currently believes the pair is worth, as the aggregator returned it. */
export interface AggregateSnapshot {
  pairKey: string
  /**
   * Price in Lens's stored convention: units of assetB per assetA. The caller
   * has already oriented it against the feed's base if needed — this module
   * compares and publishes numbers, it does not decide which leg is which.
   */
  price: number
  /** Venue names behind this aggregate (`SDEX`, `aquarius_amm`, …). Never blended. */
  venues: string[]
  /** The aggregator's own `stale` flag. */
  stale: boolean
  /** Age of the newest trade in the series, or null if there has never been one. */
  lastTradeAgeSeconds: number | null
}

/** What is already on chain for this asset, read from `lastprice`. */
export interface PublishedSnapshot {
  /** Human-readable price (already un-scaled by the feed's `decimals`). */
  price: number
  /** Unix seconds, already trimmed to the feed's resolution. */
  timestamp: number
}

export interface TriggerThresholds {
  /** Percent move that justifies a write. */
  deviationPct: number
  /** Publish even without movement once the feed is this old. */
  maxIntervalMs: number
  /** Never write twice within this window. */
  minWriteIntervalMs: number
  /** Refuse to publish an aggregate whose newest trade is older than this. */
  maxAgeSeconds: number
  /** The feed's `resolution()` in seconds — its tick. */
  resolutionSeconds: number
}

export type TriggerDecision =
  | {
      publish: true
      trigger: PublicationTrigger
      /** The `timestamp` to report: now, trimmed to the feed's tick. */
      feedTimestamp: number
      /** Percent move against the on-chain price, for the log line. Null on first write. */
      deviationPct: number | null
      /** Age of the on-chain value in ms at the moment of decision; null on first write. */
      publishedAgeMs: number | null
      reason: string
    }
  | {
      publish: false
      guard: PublicationGuard
      feedTimestamp: number
      /** Set when a real trigger existed but a write veto stopped it. */
      suppressedBy?: PublicationTrigger
      reason: string
    }

/**
 * `floor(unix_now()/resolution)*resolution` — SEP-40's definition of a feed
 * timestamp, kept here so the trigger and the writer can never disagree.
 */
export function feedTimestamp(nowMs: number, resolutionSeconds: number): number {
  if (!Number.isInteger(resolutionSeconds) || resolutionSeconds <= 0) {
    throw new Error(`resolution must be a positive whole number of seconds (got ${resolutionSeconds})`)
  }
  const unix = Math.floor(nowMs / 1000)
  return Math.floor(unix / resolutionSeconds) * resolutionSeconds
}

/**
 * Percent distance from `from` to `to`, relative to `from`. An unreachable
 * reference (zero or non-finite) reads as infinite deviation, which is the
 * safe direction: a published value we cannot compare against gets corrected,
 * not treated as "no movement" forever.
 */
export function deviationPercent(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return Infinity
  return (Math.abs(to - from) / Math.abs(from)) * 100
}

/** A decision not to write. `decidePublication` and `evaluateGuards` both return this. */
export type BlockedDecision = Extract<TriggerDecision, { publish: false }>

function block(guard: PublicationGuard, tick: number, reason: string): BlockedDecision {
  return { publish: false, guard, feedTimestamp: tick, reason }
}

/**
 * The staleness and provenance guards, on their own.
 *
 * Exported separately because a caller that already knows it has a stale or
 * unsourced number should find out without spending an RPC read: the publisher
 * runs this first and skips the pair entirely, so a blocked tick touches no
 * chain at all. `decidePublication` calls the same function — there is one list
 * of guards, not two that can drift apart.
 */
export function evaluateGuards(
  aggregate: AggregateSnapshot,
  thresholds: TriggerThresholds,
  tick: number
): BlockedDecision | null {
  if (aggregate.venues.length === 0) {
    return block('no_venue', tick,
      `${aggregate.pairKey}: no venue is named behind ${aggregate.price}; a price you cannot source is worse than no price`)
  }
  if (!Number.isFinite(aggregate.price) || aggregate.price <= 0) {
    return block('invalid_price', tick,
      `${aggregate.pairKey}: price ${aggregate.price} is not a positive, finite number`)
  }
  if (aggregate.lastTradeAgeSeconds === null) {
    return block('no_observation', tick,
      `${aggregate.pairKey}: no trade has been recorded on this network, so there is nothing to publish`)
  }
  // The aggregator's own flag first: it is the same signal /api/price reports,
  // so a consumer of the feed can never be shown a price the API calls stale.
  if (aggregate.stale) {
    return block('stale_aggregate', tick,
      `${aggregate.pairKey}: aggregate is stale (last trade ${aggregate.lastTradeAgeSeconds}s ago); a stale aggregate is never published`)
  }
  if (aggregate.lastTradeAgeSeconds > thresholds.maxAgeSeconds) {
    return block('aggregate_too_old', tick,
      `${aggregate.pairKey}: last trade is ${aggregate.lastTradeAgeSeconds}s old, over the feed's ${thresholds.maxAgeSeconds}s limit`)
  }
  return null
}

/**
 * The whole publication policy, as one pure call.
 *
 * `published` is the current on-chain state for the asset under consideration,
 * or null when the feed holds nothing for it yet. `nowMs` is injected so the
 * interval and rate-limit branches are testable against a fixed clock.
 */
export function decidePublication(
  aggregate: AggregateSnapshot,
  published: PublishedSnapshot | null,
  thresholds: TriggerThresholds,
  nowMs: number
): TriggerDecision {
  const tick = feedTimestamp(nowMs, thresholds.resolutionSeconds)

  const blocked = evaluateGuards(aggregate, thresholds, tick)
  if (blocked) return blocked

  // Nothing on chain for this asset. The first report is unconditional once the
  // guards pass: "the feed has never heard of this pair" is not a reason to
  // keep it silent, and there is no rate limit against a value that does not
  // exist. The tick itself is still the contract's monotonicity check.
  if (published === null) {
    return {
      publish: true,
      trigger: 'first_report',
      feedTimestamp: tick,
      deviationPct: null,
      publishedAgeMs: null,
      reason: `${aggregate.pairKey}: the feed holds no price for this asset, publishing ${aggregate.price} from ${aggregate.venues.join(', ')}`,
    }
  }

  const publishedAgeMs = Math.max(0, nowMs - published.timestamp * 1000)
  const deviation = deviationPercent(published.price, aggregate.price)
  const moved = deviation >= thresholds.deviationPct
  const agedOut = publishedAgeMs >= thresholds.maxIntervalMs

  if (!moved && !agedOut) {
    return block('below_deviation', tick,
      `${aggregate.pairKey}: moved ${deviation.toFixed(3)}%, under the ${thresholds.deviationPct}% threshold, and the published price is ${Math.round(publishedAgeMs / 1000)}s old — inside the ${Math.round(thresholds.maxIntervalMs / 1000)}s max interval`)
  }

  const trigger: PublicationTrigger = moved ? 'deviation' : 'max_interval'
  const why = moved
    ? `${aggregate.pairKey}: moved ${deviation.toFixed(3)}% from the published ${published.price} (threshold ${thresholds.deviationPct}%)`
    : `${aggregate.pairKey}: the published price is ${Math.round(publishedAgeMs / 1000)}s old with no move above ${thresholds.deviationPct}% (max interval ${Math.round(thresholds.maxIntervalMs / 1000)}s)`

  // A trigger exists. Two write vetoes still apply, to BOTH branches — a
  // deviation as big as a halving and an interval that merely elapsed are
  // equally unable to justify two transactions inside the same tick.
  if (tick <= published.timestamp) {
    return {
      publish: false,
      guard: 'tick_not_advanced',
      feedTimestamp: tick,
      suppressedBy: trigger,
      reason: `${why}, but the feed's current tick (${tick}) is not newer than the last report (${published.timestamp}); the contract would reject it as NotNewer`,
    }
  }
  if (publishedAgeMs < thresholds.minWriteIntervalMs) {
    return {
      publish: false,
      guard: 'min_write_interval',
      feedTimestamp: tick,
      suppressedBy: trigger,
      reason: `${why}, but only ${Math.round(publishedAgeMs / 1000)}s have passed since the last report (minimum ${Math.round(thresholds.minWriteIntervalMs / 1000)}s between writes)`,
    }
  }

  return {
    publish: true,
    trigger,
    feedTimestamp: tick,
    deviationPct: Number.isFinite(deviation) ? deviation : null,
    publishedAgeMs,
    reason: `${why}; sources ${aggregate.venues.join(', ')}`,
  }
}
