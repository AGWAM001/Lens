/**
 * The SEP-40 publisher loop (#222).
 *
 * This is the piece that turns Lens from an oracle consumer into an oracle
 * publisher: read our own aggregate, compare it with what the feed already
 * holds, and — only when `trigger.ts` says the move justifies a transaction —
 * write it. It runs once per enabled network, exactly like the ingest loops it
 * sits next to, and it is the only code in Lens that signs a transaction.
 *
 * Three structural choices worth stating, because they are the ones a reviewer
 * should push on:
 *
 * **Everything the loop depends on is injected.** `runPublicationCycle` takes a
 * `PublicationDeps` — the feed, the aggregate source, the venue source, the
 * audit sink — so the whole policy is exercised in tests against recording
 * fakes, including "the chain was never touched". Production wires the real
 * ones; there is no separate mock mode.
 *
 * **The feed's own parameters decide the math.** `base`, `decimals` and
 * `resolution` are read from the deployed contract, never from an env var, so a
 * mis-declared scale cannot produce a price off by four orders of magnitude. If
 * those reads fail, the cycle aborts before any pair is attempted.
 *
 * **Which leg is published is derived, not configured.** SEP-40 quotes every
 * asset against ONE base, while Lens stores a pair as `price = assetB per
 * assetA`. The base tells us which leg of the pair is quoted and whether the
 * number has to be inverted; a pair whose legs are neither of them is skipped
 * with a reason, because publishing it would put a ratio under the wrong
 * label.
 */

import { activeNetwork, config, getNetworkConfig, type NetworkName } from '../config'
import { getAggregatedPrice } from '../aggregator/vwap'
import { pgPool, prisma } from '../db'
import { sleep } from '../ingest/venues/runner'
import { createLogger } from '../logger'
import type { WatchedPair } from '../types'
import {
  Sep40EncodingError,
  assetKey,
  scalePrice,
  toSep40Asset,
  unscalePrice,
  venuesToSpecArg,
  type Sep40Asset,
} from './sep40'
import {
  decidePublication,
  evaluateGuards,
  feedTimestamp,
  type AggregateSnapshot,
  type PublishedSnapshot,
  type TriggerDecision,
  type TriggerThresholds,
} from './trigger'
import {
  FeedUnavailableError,
  FeedWriteError,
  getSep40Feed,
  type Sep40Feed,
} from './onchain'

const log = createLogger('sep40-publisher')

/**
 * How far back a venue counts as "behind this number".
 *
 * One hour is not arbitrary: it is the window the aggregator's own `sources`
 * count uses, and any aggregate that clears the freshness gate (`maxAgeSeconds`
 * defaults to 120) has trades well inside it. Widening the window would let a
 * venue that has been dead all day keep signing the provenance of a live price.
 */
const VENUE_WINDOW_SECONDS = 3600

/** The slice of the aggregate the publisher needs — keeps the fake small. */
export interface AggregateSource {
  price: number
  stale: boolean
  lastTradeAgeSeconds: number | null
}

/** An audit row, in the shape `OraclePublication` stores. */
export interface PublicationRecord {
  network: NetworkName
  pairKey: string
  quotedAsset: string
  baseAsset: string
  state: 'published' | 'failed'
  trigger: string | null
  price: number | null
  scaledPrice: string | null
  decimals: number | null
  feedTimestamp: number | null
  resolution: number | null
  venues: string | null
  sourceCount: number | null
  deviationPct: number | null
  reason: string
  txHash?: string | null
  errorMessage?: string | null
}

export interface PublicationDeps {
  feed: Sep40Feed
  pairs: readonly WatchedPair[]
  aggregate(pairKey: string, network: NetworkName): Promise<AggregateSource>
  venues(pairKey: string, network: NetworkName): Promise<string[]>
  record(row: PublicationRecord): Promise<void>
}

/** One pair's outcome in a cycle, kept so tests can assert without a log grep. */
export interface PairOutcome {
  pairKey: string
  /** Present when the pair is quotable against the feed's base. */
  quotedAsset?: string
  decision: TriggerDecision | { publish: false; guard: string; reason: string }
}

export interface CycleReport {
  network: NetworkName
  base: string
  decimals: number
  resolution: number
  outcomes: PairOutcome[]
  published: string[]
  failed: string[]
}

/**
 * Which leg of `pair` this feed quotes, and the price in base terms.
 *
 * Lens stores `price` as units of assetB per assetA. SEP-40's `PriceData` is
 * units of BASE per QUOTED asset, so:
 *   base == assetB → the stored number is already base-per-assetA; quote assetA.
 *   base == assetA → the stored number must be inverted; quote assetB.
 */
export function orientAgainstBase(
  pair: WatchedPair,
  base: Sep40Asset,
  network: NetworkName
): { quoted: Sep40Asset; inverted: boolean } | { skip: string } {
  const assetA = toSep40Asset(pair.assetA, network)
  const assetB = toSep40Asset(pair.assetB, network)
  const baseKey = assetKey(base)
  if (baseKey === assetKey(assetB)) return { quoted: assetA, inverted: false }
  if (baseKey === assetKey(assetA)) return { quoted: assetB, inverted: true }
  return {
    skip: `${pair.pairKey}: the feed's base is ${baseKey}, which is neither leg of this pair — there is no correct label for this number on this feed`,
  }
}

/** `price` in the direction the feed wants, from the direction we store it in. */
export function priceForFeed(storedPrice: number, inverted: boolean): number {
  if (!inverted) return storedPrice
  if (storedPrice <= 0 || !Number.isFinite(storedPrice)) return 0
  // Inverting is a division, and a division is where a zero sneaks through as
  // Infinity and then fails the i128 bound far away from here. Returning 0
  // routes it to the `invalid_price` guard, which names the pair.
  return 1 / storedPrice
}

function thresholdsFor(resolutionSeconds: number): TriggerThresholds {
  // Global, not per-network: the thresholds describe how Lens behaves, and an
  // operator tuning mainnet's write rate almost certainly means testnet's too.
  // The per-network half is `publisher.enabled` / contract id / key.
  return {
    deviationPct: config.publisher.deviationPct,
    maxIntervalMs: config.publisher.maxIntervalMs,
    minWriteIntervalMs: config.publisher.minWriteIntervalMs,
    maxAgeSeconds: config.publisher.maxAgeSeconds,
    resolutionSeconds,
  }
}

/**
 * One pass over every watched pair on `network`.
 *
 * A guard that stops a write is a `continue`, never a throw: one pair with a
 * bad issuer must not silence the other feeds. A feed we cannot READ is
 * different — `FeedUnavailableError` propagates, because "we could not check
 * what is already there" means we cannot honour the deviation or monotonicity
 * promises either, and the outer loop should back off rather than churn.
 */
export async function runPublicationCycle(
  network: NetworkName,
  deps: PublicationDeps,
  nowMs = Date.now()
): Promise<CycleReport> {
  const params = await deps.feed.parameters()
  const baseKey = assetKey(params.base)
  const thresholds = thresholdsFor(params.resolution)

  const report: CycleReport = {
    network,
    base: baseKey,
    decimals: params.decimals,
    resolution: params.resolution,
    outcomes: [],
    published: [],
    failed: [],
  }

  for (const pair of deps.pairs) {
    const quotedLabel = (asset: Sep40Asset) =>
      asset.kind === 'stellar' ? asset.contractId : asset.symbol

    let orientation: ReturnType<typeof orientAgainstBase>
    try {
      orientation = orientAgainstBase(pair, params.base, network)
    } catch (err) {
      if (err instanceof FeedUnavailableError) throw err
      report.outcomes.push({
        pairKey: pair.pairKey,
        decision: blocked(
          'asset_identity',
          err instanceof Sep40EncodingError ? err.message : `${pair.pairKey}: ${(err as Error).message}`
        ),
      })
      continue
    }

    if ('skip' in orientation) {
      report.outcomes.push({ pairKey: pair.pairKey, decision: blocked('base_not_in_pair', orientation.skip) })
      log.info(orientation.skip)
      continue
    }

    const quotedAsset = quotedLabel(orientation.quoted)
    try {
      const [aggregate, venueNames] = await Promise.all([
        deps.aggregate(pair.pairKey, network),
        deps.venues(pair.pairKey, network),
      ])

      // Validate provenance before the decision, so a venue list the contract
      // would reject shows up as a blocked pair and not as a failed write. An
      // EMPTY list is not an encoding failure — it is the `no_venue` guard's
      // case, with its own code and its own sentence — so it goes through to
      // the decision instead of being renamed here.
      let venues: string[]
      try {
        venues = venueNames.length === 0 ? [] : venuesToSpecArg(venueNames)
      } catch (err) {
        report.outcomes.push({
          pairKey: pair.pairKey,
          quotedAsset,
          decision: blocked('venue_provenance', (err as Sep40EncodingError).message),
        })
        continue
      }

      const snapshot: AggregateSnapshot = {
        pairKey: pair.pairKey,
        price: priceForFeed(aggregate.price, orientation.inverted),
        venues,
        stale: aggregate.stale,
        lastTradeAgeSeconds: aggregate.lastTradeAgeSeconds,
      }

      // Staleness and provenance are checked BEFORE the chain is read. A stale
      // aggregate needs no comparison to decide anything — it is simply not
      // publishable — so spending an RPC call on it would buy nothing, and the
      // "never published" guarantee is easier to trust when the code path does
      // not touch the network at all.
      const tick = feedTimestamp(nowMs, params.resolution)
      const guard = evaluateGuards(snapshot, thresholds, tick)
      if (guard) {
        report.outcomes.push({ pairKey: pair.pairKey, quotedAsset, decision: guard })
        log.debug({ pair: pair.pairKey, network, guard: guard.guard }, 'publication blocked before the feed was read')
        continue
      }

      const raw = await deps.feed.lastPrice(orientation.quoted)
      const published: PublishedSnapshot | null = raw
        ? { price: unscalePrice(raw.price, params.decimals), timestamp: raw.timestamp }
        : null

      const decision = decidePublication(snapshot, published, thresholds, nowMs)
      report.outcomes.push({ pairKey: pair.pairKey, quotedAsset, decision })

      if (!decision.publish) {
        log.debug({ pair: pair.pairKey, guard: decision.guard }, 'publication blocked')
        continue
      }

      const scaled = scalePrice(snapshot.price, params.decimals)
      const receipt = await deps.feed.report({
        asset: orientation.quoted,
        price: scaled,
        timestamp: decision.feedTimestamp,
        venues,
      })

      await deps.record({
        network,
        pairKey: pair.pairKey,
        quotedAsset,
        baseAsset: baseKey,
        state: 'published',
        trigger: decision.trigger,
        price: snapshot.price,
        scaledPrice: scaled.toString(),
        decimals: params.decimals,
        feedTimestamp: decision.feedTimestamp,
        resolution: params.resolution,
        venues: venues.join(','),
        sourceCount: venues.length,
        deviationPct: decision.deviationPct,
        reason: decision.reason,
        txHash: receipt.txHash,
      })
      report.published.push(pair.pairKey)
      log.info({ pair: pair.pairKey, trigger: decision.trigger, tx: receipt.txHash }, decision.reason)
    } catch (err) {
      if (err instanceof FeedUnavailableError) throw err
      const message = (err as Error).message
      const guard = err instanceof FeedWriteError ? 'write_failed' : 'cycle_error'
      report.failed.push(pair.pairKey)
      report.outcomes.push({ pairKey: pair.pairKey, quotedAsset, decision: blocked(guard, message) })
      log.error({ pair: pair.pairKey, network, err }, 'publication attempt failed')
      // A failed write is exactly the audit trail an operator needs: the number
      // we meant to publish, the venues behind it, and why it did not land.
      await deps.record({
        network,
        pairKey: pair.pairKey,
        quotedAsset,
        baseAsset: baseKey,
        state: 'failed',
        trigger: null,
        price: null,
        scaledPrice: null,
        decimals: params.decimals,
        feedTimestamp: null,
        resolution: params.resolution,
        venues: null,
        sourceCount: null,
        deviationPct: null,
        reason: message,
        errorMessage: message.slice(0, 2000),
      }).catch(recErr => log.error({ err: recErr }, 'could not record a failed publication'))
    }
  }

  return report
}

function blocked(guard: string, reason: string) {
  return { publish: false as const, guard, reason }
}

// ── Production wiring ────────────────────────────────────────────────────────

/**
 * Venues that produced rows for this pair on this network.
 *
 * `network` is in the WHERE clause, not implied: this table holds both chains,
 * and a provenance list that leaked mainnet venues onto a testnet report would
 * be the exact silent blending this issue's instructions call out.
 */
export async function queryVenues(pairKey: string, network: NetworkName): Promise<string[]> {
  const result = await pgPool.query(
    `SELECT DISTINCT source
     FROM price_points
     WHERE pair_key = $1 AND network = $2
       AND timestamp > NOW() - ($3 * INTERVAL '1 second')`,
    [pairKey, network, VENUE_WINDOW_SECONDS]
  )
  return result.rows.map((row: { source: string }) => row.source).sort()
}

async function recordPublication(row: PublicationRecord): Promise<void> {
  await prisma.oraclePublication.create({
    data: {
      network: row.network,
      pairKey: row.pairKey,
      quotedAsset: row.quotedAsset,
      baseAsset: row.baseAsset,
      state: row.state,
      trigger: row.trigger,
      price: row.price,
      scaledPrice: row.scaledPrice,
      decimals: row.decimals,
      feedTimestamp: row.feedTimestamp === null ? null : BigInt(row.feedTimestamp),
      resolution: row.resolution,
      venues: row.venues,
      sourceCount: row.sourceCount,
      deviationPct: row.deviationPct,
      reason: row.reason,
      txHash: row.txHash ?? null,
      errorMessage: row.errorMessage ?? null,
    },
  })
}

function productionDeps(network: NetworkName, feed: Sep40Feed): PublicationDeps {
  return {
    feed,
    // The env-declared pairs for THIS network, not the shared runtime registry:
    // the registry is a single list covering whichever network loaded it, and
    // quoting a pair this process has no rows for on this chain is how a feed
    // starts publishing a number that belongs to another network.
    pairs: getNetworkConfig(network).pairs,
    async aggregate(pairKey) {
      const price = await getAggregatedPrice(pairKey, network)
      return { price: price.price, stale: price.stale, lastTradeAgeSeconds: price.lastTradeAgeSeconds }
    },
    venues: queryVenues,
    record: recordPublication,
  }
}

/**
 * The publisher loop for one network. Never resolves: like the venue adapters
 * it runs beside, it sleeps between cycles and backs off on a failed cycle.
 * Returns immediately (without starting anything) when publication is not
 * configured for this network.
 */
export async function startSep40Publisher(network: NetworkName = activeNetwork): Promise<void> {
  const feed = getSep40Feed(network)
  if (!feed) {
    log.info({ network }, 'SEP-40 publication is not configured for this network — publisher not started')
    return
  }

  const pollIntervalMs = config.publisher.pollIntervalMs
  log.info(
    {
      network,
      contract: feed.contractId,
      pollIntervalMs,
      deviationPct: config.publisher.deviationPct,
      maxIntervalMs: config.publisher.maxIntervalMs,
      minWriteIntervalMs: config.publisher.minWriteIntervalMs,
      maxAgeSeconds: config.publisher.maxAgeSeconds,
    },
    'starting SEP-40 publisher'
  )

  let consecutiveErrors = 0
  while (true) {
    try {
      const cycle = await runPublicationCycle(network, productionDeps(network, feed))
      consecutiveErrors = 0
      if (cycle.published.length > 0) {
        log.info({ network, published: cycle.published }, 'publication cycle wrote')
      }
    } catch (err) {
      consecutiveErrors++
      const backoffMs = Math.min(10_000 * Math.pow(2, consecutiveErrors - 1), 60_000)
      log.error(
        { network, attempt: consecutiveErrors, backoffMs, err },
        'SEP-40 publication cycle failed; nothing was written on this pass, retrying'
      )
      await sleep(backoffMs)
      continue
    }
    await sleep(pollIntervalMs)
  }
}
