import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { getCachedSnapshot, setCachedSnapshot } from '../redis'
import { config, getNetworkConfig, activeNetwork, type NetworkName } from '../config'
import { snapshotResponseSchema } from '../api/schemas'
import type { AssetId, WatchedPair } from '../types'

/**
 * Register the whole-network snapshot endpoint.
 *
 * GET /snapshot?network=testnet|mainnet
 *
 * One call that answers "what does this network look like right now": every
 * venue's liveness, AMM liquidity (TVL), 24h volume, the busiest pairs, the
 * stablecoin peg readings and how fresh the underlying data is — as a single
 * timestamped object rather than four or five round-trips.
 *
 * Design rules, all in service of not lying:
 *
 *   - Everything is read in ONE SQL statement with a single `as_of` timestamp
 *     taken from the database. Four separate queries could land on four
 *     different clocks, and then the response would describe an instant that
 *     never existed. Every 24h cutoff and every `ageSeconds` is measured from
 *     that same `as_of`.
 *   - Scoped to exactly one network. Testnet and mainnet rows pooled together
 *     are not a market; `network` defaults to this process's own network and
 *     the resolved value is echoed back.
 *   - Absent data is reported, never invented. A venue with no rows is listed
 *     as silent, a pair with no trades in the window gets no volume figure,
 *     the peg check says `no_reference` when it has nothing to compare against,
 *     and a cross-pair volume total is null — with a reason — when the pairs do
 *     not share a unit. The `provenance`/`note` fields carry the same honesty.
 *   - Asset identity is never elided. Where full ids are known (they are, from
 *     the pair_config's watched pairs / the price-point pair key) the issuer is
 *     included, because a coin called "USDC" is a different asset per issuer.
 *   - Always 200. This endpoint summarises state; "no data yet" is state, not a
 *     client error, and a summary that 404s is useless to a dashboard.
 *
 * Cached per network for a few seconds so a dashboard polling it cannot turn
 * into a full table scan per request. The cached whole response carries its own
 * `cache.ageSeconds`, so a hit never pretends to be fresher than it is.
 */

// How many pairs the snapshot returns in `topPairs`, ranked by their own
// base-asset 24h volume.
const TOP_PAIRS_LIMIT = 10

// How long a venue may go without a write before the snapshot calls it stale.
// Generous relative to the ingester poll interval (seconds) so a normal gap
// between polls, or a venue that simply trades rarely, is not flagged.
const STALE_AFTER_SECONDS = 300

// A pair of assets whose value is meant to hold at 1:1 against a fiat target.
// Several issuers exist per code on Stellar; the *code* is what a peg is
// defined against, so the check is keyed on the code and the full asset id is
// still reported back for the entry. Anything not listed here gets
// `no_reference` — the snapshot never guesses that an asset is a stablecoin.
const PEGGED_ASSETS: Readonly<Record<string, string>> = {
  USDC: 'USD',
  USDT: 'USD',
  DAI: 'USD',
  USDP: 'USD',
  PYUSD: 'USD',
  TUSD: 'USD',
  USDY: 'USD',
  EURC: 'EUR',
  EURT: 'EUR',
  EUROC: 'EUR',
}

// A peg that is off by more than this many basis points is reported as
// off_peg. Published in the response so a caller can reinterpret it.
const PEG_TOLERANCE_BPS = 100

interface VenueDescriptor {
  name: string
  source: string
  type: 'orderbook' | 'amm' | 'unknown'
  enabled: boolean | null
}

/** The venue surface this network is expected to ingest, mirroring the venue
 *  registry (src/ingest/venues) without importing its adapters: the snapshot
 *  only needs the name/source and whether the network enables it. Sources seen
 *  in the database but not listed here are still reported (type `unknown`), so
 *  a new venue is never silently omitted. */
function venueDescriptors(network: NetworkName): VenueDescriptor[] {
  const net = getNetworkConfig(network)
  return [
    { name: 'SDEX', source: 'SDEX', type: 'orderbook', enabled: true },
    { name: 'AMM', source: 'AMM', type: 'amm', enabled: true },
    { name: 'Soroswap', source: 'soroswap_amm', type: 'amm', enabled: net.soroswap.enabled },
    { name: 'Aquarius', source: 'aquarius_amm', type: 'amm', enabled: net.aquarius.enabled },
  ]
}

function assetKey(a: AssetId): string {
  return `${a.code}:${a.issuer ?? 'native'}`
}

function assetObj(a: AssetId): { code: string; issuer: string | null } {
  return { code: a.code, issuer: a.issuer }
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function ageSeconds(asOfMs: number, timestamp: string | null): number | null {
  if (!timestamp) return null
  const t = Date.parse(timestamp)
  return Number.isFinite(t) ? Math.max(0, Math.round((asOfMs - t) / 1000)) : null
}

/** Parse one asset from a pair-key segment (`CODE` or `CODE:ISSUER`). */
function parseAssetSegment(s: string): AssetId {
  const [code, issuer] = s.split(':')
  return {
    code: (code ?? '').toUpperCase(),
    issuer: issuer && issuer.toLowerCase() !== 'native' ? issuer : null,
  }
}

/** Split an alphabetically-sorted pair key back into its two assets. */
function parsePairKey(pairKey: string): { assetA: AssetId; assetB: AssetId } | null {
  const parts = pairKey.split('/')
  if (parts.length !== 2) return null
  return { assetA: parseAssetSegment(parts[0]), assetB: parseAssetSegment(parts[1]) }
}

/** Resolve a stored row's pair to the config's asset order (and identity). The
 *  stored `price` is assetB-per-assetA in that order; a pair missing from the
 *  config falls back to the alphabetically-sorted key order and is marked as
 *  unconfigured so the caller knows the direction was inferred, not declared. */
function resolvePair(
  pairIndex: Map<string, WatchedPair>,
  pairKey: string,
): { assetA: AssetId; assetB: AssetId; configured: boolean } | null {
  const cfg = pairIndex.get(pairKey)
  if (cfg) return { assetA: cfg.assetA, assetB: cfg.assetB, configured: true }
  const parsed = parsePairKey(pairKey)
  if (!parsed) return null
  return { ...parsed, configured: false }
}

/**
 * Reduce a set of per-pair base/counter amounts to one figure in one unit, or
 * refuse. A total is only honest when every pair shares the same denomination
 * on one side: one distinct base asset admits summing the base amounts, else one
 * distinct counter asset admits the counter amounts. Two bases *and* two
 * counters (e.g. XLM/USDC and BTC/USDC would actually collapse on USDC — but
 * XLM/USDC and BTC/EUR would not) yields a null with the reason spelled out.
 */
function collapseVolume(
  rows: { assetA: AssetId; assetB: AssetId; base: number; counter: number }[],
): { value: number | null; unit: { code: string; issuer: string | null } | null; reason: string | null } {
  if (rows.length === 0) {
    return { value: null, unit: null, reason: 'no trades in the last 24h' }
  }
  const bases = new Map<string, AssetId>()
  const counters = new Map<string, AssetId>()
  for (const r of rows) {
    bases.set(assetKey(r.assetA), r.assetA)
    counters.set(assetKey(r.assetB), r.assetB)
  }
  if (bases.size === 1) {
    const [asset] = bases.values()
    const value = rows.reduce((s, r) => s + r.base, 0)
    return { value, unit: assetObj(asset), reason: null }
  }
  if (counters.size === 1) {
    const [asset] = counters.values()
    const value = rows.reduce((s, r) => s + r.counter, 0)
    return { value, unit: assetObj(asset), reason: null }
  }
  return {
    value: null,
    unit: null,
    reason: `pairs span ${bases.size} base and ${counters.size} counter assets; a single-unit total is not defined`,
  }
}

interface SeriesRow {
  source: string
  pair_key: string
  samples_24h: number | null
  base_volume_24h: number | null
  counter_volume_24h: number | null
  last_seen_24h: unknown
}
interface LatestRow {
  pair_key: string
  price: number | null
  last_seen: unknown
}
interface VenueLifetimeRow {
  source: string
  samples: number | null
  last_seen: unknown
}
interface PoolRow {
  pool_id: string
  asset_a: string
  asset_b: string
  reserve_a: number | null
  reserve_b: number | null
  spot_price: number | null
  fee_bp: number | null
  timestamp: unknown
  pair_key: string | null
}

export async function registerSnapshotRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { network?: string } }>(
    '/snapshot',
    {
      // A public, cheap, pollable summary. No API key: a market overview that
      // requires auth is not a health/observability surface. (x402 does not
      // gate this path.)
      config: { public: true },
      schema: { response: { 200: snapshotResponseSchema } },
    },
    async (req, reply) => {
      const requested = req.query.network
      if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
        return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
      }
      const network: NetworkName = (requested as NetworkName) ?? activeNetwork
      const ttl = config.cache.snapshotTtl

      // ── Cache ────────────────────────────────────────────────────────────
      // The cached object is the whole response, `asOf` included, so a hit is
      // one Redis GET and no Postgres at all. Its own age is recomputed and
      // republished under `cache` so it never masquerades as fresh.
      const cached = await getCachedSnapshot(network)
      if (cached) {
        try {
          const parsed = JSON.parse(cached)
          const storedAt = typeof parsed?.cache?.storedAt === 'string' ? parsed.cache.storedAt : null
          parsed.generatedAt = new Date().toISOString()
          parsed.cache = {
            ...parsed.cache,
            hit: true,
            ageSeconds: storedAt ? ageSeconds(Date.now(), storedAt) : null,
          }
          reply.header('X-Cache', 'HIT')
          reply.header('Cache-Control', `public, max-age=${ttl}`)
          return parsed
        } catch {
          // Corrupt cache entry — fall through and recompute.
        }
      }

      // ── One statement, one clock ─────────────────────────────────────────
      // `as_of` is the database's `now()`, and it is the reference for every
      // window boundary and every age below. Four queries would each take
      // their own `now()` and could describe an instant that never existed.
      let asOf: Date
      let venueLifetime: VenueLifetimeRow[]
      let series: SeriesRow[]
      let latest: LatestRow[]
      let pools: PoolRow[]
      try {
        const { rows } = await pgPool.query(
          `WITH clock AS (SELECT now() AS as_of),
                bounds AS (SELECT as_of, as_of - INTERVAL '24 hours' AS since FROM clock),
                series AS (
                  SELECT pp.source, pp.pair_key,
                         COUNT(*)::int AS samples_24h,
                         COALESCE(SUM(pp.base_volume), 0)::float AS base_volume_24h,
                         COALESCE(SUM(pp.counter_volume), 0)::float AS counter_volume_24h,
                         MAX(pp.timestamp) AS last_seen_24h
                    FROM price_points pp, bounds b
                   WHERE pp.network = $1 AND pp.timestamp > b.since AND pp.timestamp <= b.as_of
                   GROUP BY pp.source, pp.pair_key
                ),
                venue_lifetime AS (
                  SELECT source, COUNT(*)::int AS samples, MAX(timestamp) AS last_seen
                    FROM price_points
                   WHERE network = $1
                   GROUP BY source
                ),
                latest AS (
                  SELECT DISTINCT ON (pair_key) pair_key, price::float AS price, timestamp AS last_seen
                    FROM price_points
                   WHERE network = $1
                   ORDER BY pair_key, timestamp DESC
                ),
                pools AS (
                  SELECT DISTINCT ON (pool_id)
                         pool_id, asset_a, asset_b,
                         reserve_a::float AS reserve_a, reserve_b::float AS reserve_b,
                         spot_price::float AS spot_price, fee_bp, timestamp
                    FROM pool_snapshots
                   WHERE network = $1
                   ORDER BY pool_id, timestamp DESC
                ),
                pool_pair AS (
                  SELECT DISTINCT ON (pool_id) pool_id, pair_key
                    FROM price_points
                   WHERE network = $1 AND pool_id IS NOT NULL
                   ORDER BY pool_id, timestamp DESC
                )
           SELECT (SELECT as_of FROM clock) AS as_of,
                  (SELECT COALESCE(json_agg(v), '[]') FROM venue_lifetime v) AS venues,
                  (SELECT COALESCE(json_agg(s), '[]') FROM series s) AS series,
                  (SELECT COALESCE(json_agg(l), '[]') FROM latest l) AS latest,
                  (SELECT COALESCE(json_agg(p), '[]') FROM (
                     SELECT p.*, pp.pair_key
                       FROM pools p
                       LEFT JOIN pool_pair pp ON pp.pool_id = p.pool_id
                  ) p) AS pools`,
          [network],
        )
        const row = rows[0] ?? {}
        asOf = row.as_of instanceof Date ? row.as_of : new Date(String(row.as_of ?? Date.now()))
        if (!Number.isFinite(asOf.getTime())) asOf = new Date()
        venueLifetime = Array.isArray(row.venues) ? row.venues : []
        series = Array.isArray(row.series) ? row.series : []
        latest = Array.isArray(row.latest) ? row.latest : []
        pools = Array.isArray(row.pools) ? row.pools : []
      } catch (err) {
        return reply
          .status(500)
          .send({ error: `Snapshot aggregation failed: ${(err as Error).message}` })
      }

      const asOfMs = asOf.getTime()
      const pairIndex = new Map<string, WatchedPair>(
        getNetworkConfig(network).pairs.map(p => [p.pairKey, p]),
      )

      // ── Aggregate per pair (24h volumes + venues, and the latest price) ──
      interface PairAgg {
        pairKey: string
        samples24h: number
        baseVolume: number
        counterVolume: number
        venues: Set<string>
        lastSeen24h: string | null
        price: number | null
        lastSeen: string | null
      }
      const pairs = new Map<string, PairAgg>()
      const pairAgg = (pairKey: string): PairAgg => {
        let p = pairs.get(pairKey)
        if (!p) {
          p = {
            pairKey,
            samples24h: 0,
            baseVolume: 0,
            counterVolume: 0,
            venues: new Set(),
            lastSeen24h: null,
            price: null,
            lastSeen: null,
          }
          pairs.set(pairKey, p)
        }
        return p
      }
      for (const s of series) {
        const p = pairAgg(s.pair_key)
        p.samples24h += Number(s.samples_24h) || 0
        p.baseVolume += num(s.base_volume_24h) ?? 0
        p.counterVolume += num(s.counter_volume_24h) ?? 0
        p.venues.add(s.source)
        const seen = iso(s.last_seen_24h)
        if (seen && (!p.lastSeen24h || seen > p.lastSeen24h)) p.lastSeen24h = seen
      }
      for (const l of latest) {
        const p = pairAgg(l.pair_key)
        p.price = num(l.price)
        p.lastSeen = iso(l.last_seen)
      }

      // ── Venues ───────────────────────────────────────────────────────────
      const lifetimeBySource = new Map<string, VenueLifetimeRow>()
      for (const v of venueLifetime) lifetimeBySource.set(v.source, v)

      const descriptors = venueDescriptors(network)
      const knownSources = new Set(descriptors.map(d => d.source))
      for (const v of venueLifetime) {
        if (!knownSources.has(v.source)) {
          descriptors.push({ name: v.source, source: v.source, type: 'unknown', enabled: null })
        }
      }

      const venue24h = new Map<string, { samples: number; pairs: number; lastSeen: string | null }>()
      for (const s of series) {
        const acc = venue24h.get(s.source) ?? { samples: 0, pairs: 0, lastSeen: null }
        acc.samples += Number(s.samples_24h) || 0
        acc.pairs += 1
        const seen = iso(s.last_seen_24h)
        if (seen && (!acc.lastSeen || seen > acc.lastSeen)) acc.lastSeen = seen
        venue24h.set(s.source, acc)
      }

      const venues = descriptors.map(d => {
        const life = lifetimeBySource.get(d.source)
        const lifeLastSeen = iso(life?.last_seen)
        const samples = Number(life?.samples) || 0
        const w = venue24h.get(d.source)
        const age = ageSeconds(asOfMs, lifeLastSeen)
        let status: 'reporting' | 'stale' | 'silent' | 'disabled'
        if (samples > 0) {
          status = age !== null && age > STALE_AFTER_SECONDS ? 'stale' : 'reporting'
        } else if (d.enabled === false) {
          status = 'disabled'
        } else {
          status = 'silent'
        }
        return {
          name: d.name,
          source: d.source,
          type: d.type,
          enabled: d.enabled,
          status,
          samples,
          samples24h: w?.samples ?? 0,
          pairs24h: w?.pairs ?? 0,
          lastUpdated: lifeLastSeen,
          ageSeconds: age,
        }
      })

      const venuesExpected = descriptors.filter(d => d.enabled === true).length
      const venuesReporting = venues.filter(v => v.samples > 0).length

      // ── 24h volume: per venue, and a cross-pair total only when one unit ─
      const venueVolume = new Map<string, { base: number; counter: number }>()
      for (const s of series) {
        const acc = venueVolume.get(s.source) ?? { base: 0, counter: 0 }
        acc.base += num(s.base_volume_24h) ?? 0
        acc.counter += num(s.counter_volume_24h) ?? 0
        venueVolume.set(s.source, acc)
      }
      const totalRows = [...pairs.values()].map(p => {
        const resolved = resolvePair(pairIndex, p.pairKey)
        return {
          assetA: resolved?.assetA ?? { code: p.pairKey, issuer: null },
          assetB: resolved?.assetB ?? { code: p.pairKey, issuer: null },
          base: p.baseVolume,
          counter: p.counterVolume,
        }
      })
      const volume24h = {
        window: '24h',
        sampleCount: series.reduce((s, r) => s + (Number(r.samples_24h) || 0), 0),
        byVenue: [...venueVolume.entries()]
          .map(([venue, v]) => ({
            venue,
            baseVolume: v.base,
            counterVolume: v.counter,
            samples: venue24h.get(venue)?.samples ?? 0,
            pairs: venue24h.get(venue)?.pairs ?? 0,
            lastUpdated: venue24h.get(venue)?.lastSeen ?? null,
            ageSeconds: ageSeconds(asOfMs, venue24h.get(venue)?.lastSeen ?? null),
          }))
          .sort((a, b) => a.venue.localeCompare(b.venue)),
        // NOTE: baseVolume sums each pair's base-asset amount (asset A units)
        // and counterVolume the counter side, so a per-venue sum mixes units
        // when that venue trades pairs with different bases. `total` is the
        // unit-correct figure and is null when no single unit fits.
        total: collapseVolume(totalRows),
      }

      // ── Top pairs ────────────────────────────────────────────────────────
      // Ranked by the pair's own base-asset volume (a heuristic across mixed
      // units), ties broken by activity then key. Each entry names its unit.
      const topPairs = [...pairs.values()]
        .sort((a, b) =>
          b.baseVolume - a.baseVolume ||
          b.samples24h - a.samples24h ||
          a.pairKey.localeCompare(b.pairKey),
        )
        .slice(0, TOP_PAIRS_LIMIT)
        .map(p => {
          const resolved = resolvePair(pairIndex, p.pairKey)
          return {
            pairKey: p.pairKey,
            configured: resolved?.configured ?? false,
            assetA: resolved ? assetObj(resolved.assetA) : null,
            assetB: resolved ? assetObj(resolved.assetB) : null,
            price: p.price,
            baseVolume24h: p.baseVolume,
            counterVolume24h: p.counterVolume,
            samples24h: p.samples24h,
            venues: [...p.venues].sort(),
            lastUpdated: p.lastSeen ?? p.lastSeen24h,
            ageSeconds: ageSeconds(asOfMs, p.lastSeen ?? p.lastSeen24h),
          }
        })

      // ── TVL ──────────────────────────────────────────────────────────────
      // No USD valuation is fabricated: reserves are reported in each pool's
      // own asset units, per asset and per pool. A pool snapshot stores only
      // asset codes, so the issuer is recovered from the watched-pair config
      // when the pool's pair is known.
      const tvlByAsset = new Map<string, { asset: AssetId; amount: number; pools: Set<string> }>()
      let tvlLastUpdated: string | null = null
      const poolDetails = pools.map(row => {
        const resolved = row.pair_key ? resolvePair(pairIndex, row.pair_key) : null
        const assetA: AssetId = resolved?.assetA.code === row.asset_a
          ? resolved.assetA
          : resolved?.assetB.code === row.asset_a
            ? resolved.assetB
            : { code: row.asset_a, issuer: null }
        const assetB: AssetId = resolved?.assetB.code === row.asset_b
          ? resolved.assetB
          : resolved?.assetA.code === row.asset_b
            ? resolved.assetA
            : { code: row.asset_b, issuer: null }
        const reserveA = num(row.reserve_a)
        const reserveB = num(row.reserve_b)
        if (reserveA != null) {
          const acc = tvlByAsset.get(assetKey(assetA)) ?? { asset: assetA, amount: 0, pools: new Set<string>() }
          acc.amount += reserveA
          acc.pools.add(row.pool_id)
          tvlByAsset.set(assetKey(assetA), acc)
        }
        if (reserveB != null) {
          const acc = tvlByAsset.get(assetKey(assetB)) ?? { asset: assetB, amount: 0, pools: new Set<string>() }
          acc.amount += reserveB
          acc.pools.add(row.pool_id)
          tvlByAsset.set(assetKey(assetB), acc)
        }
        const ts = iso(row.timestamp)
        if (ts && (!tvlLastUpdated || ts > tvlLastUpdated)) tvlLastUpdated = ts
        return {
          poolId: row.pool_id,
          pairKey: row.pair_key,
          assetA: assetObj(assetA),
          assetB: assetObj(assetB),
          reserveA,
          reserveB,
          spotPrice: num(row.spot_price),
          feeBp: row.fee_bp == null ? null : Number(row.fee_bp),
          lastUpdated: ts,
          ageSeconds: ageSeconds(asOfMs, ts),
        }
      })
      const tvlAge = ageSeconds(asOfMs, tvlLastUpdated)
      const tvl = {
        note: 'Reserves are reported in each pool asset\'s own units — no USD valuation is inferred, because the snapshot holds no trustworthy USD price to convert at.',
        poolCount: pools.length,
        sampleCount: pools.length,
        lastUpdated: tvlLastUpdated,
        ageSeconds: tvlAge,
        stale: tvlAge === null ? pools.length > 0 : tvlAge > STALE_AFTER_SECONDS,
        byAsset: [...tvlByAsset.values()]
          .map(a => ({ asset: assetObj(a.asset), amount: a.amount, pools: a.pools.size }))
          .sort((a, b) => b.amount - a.amount),
        pools: poolDetails,
      }

      // ── Pegs ─────────────────────────────────────────────────────────────
      // One entry per watched pair that contains a known stablecoin. The
      // reading is that asset's price in the pair's other asset, ideally 1.0
      // against its fiat target. When the other side is not the target (or a
      // sibling stablecoin of the same target) there is nothing to compare
      // against, and the snapshot says so rather than inventing a reference.
      const pegs: {
        asset: { code: string; issuer: string | null }
        target: string
        pairKey: string
        quote: { code: string; issuer: string | null } | null
        price: number | null
        deviationBp: number | null
        status: 'on_peg' | 'off_peg' | 'no_reference' | 'no_data'
        reason: string | null
        samples24h: number
        lastUpdated: string | null
      }[] = []
      for (const pair of getNetworkConfig(network).pairs) {
        for (const side of ['assetA', 'assetB'] as const) {
          const pegged = pair[side]
          const quote = side === 'assetA' ? pair.assetB : pair.assetA
          const target = PEGGED_ASSETS[pegged.code]
          if (!target) continue

          const agg = pairs.get(pair.pairKey)
          const lastUpdated = agg?.lastSeen ?? null
          const samples24h = agg?.samples24h ?? 0
          const base = {
            asset: assetObj(pegged),
            target,
            pairKey: pair.pairKey,
            quote: assetObj(quote),
            samples24h,
            lastUpdated,
          }

          if (agg?.price == null) {
            pegs.push({ ...base, price: null, deviationBp: null, status: 'no_data', reason: 'no price observed for this pair' })
            continue
          }

          // Stored price is assetB-per-assetA. Read as quote-per-pegged so a
          // pair quoted directly in its fiat target sits near 1.0: the pegged
          // asset is asset A → price is already quote-per-pegged; the pegged
          // asset is asset B → invert it.
          const reading = side === 'assetA' ? agg.price : 1 / agg.price
          const quoteIsReference =
            quote.code === target || PEGGED_ASSETS[quote.code] === target

          if (!quoteIsReference) {
            pegs.push({
              ...base,
              price: reading,
              deviationBp: null,
              status: 'no_reference',
              reason: `quoted in ${quote.code}, which is not ${target} or a ${target} stablecoin; deviation from ${target} is not measurable here`,
            })
            continue
          }

          const deviationBp = (reading - 1) * 10_000
          pegs.push({
            ...base,
            price: reading,
            deviationBp,
            status: Math.abs(deviationBp) <= PEG_TOLERANCE_BPS ? 'on_peg' : 'off_peg',
            reason: null,
          })
        }
      }

      // ── Freshness ────────────────────────────────────────────────────────
      const candidateLastSeen = [
        ...venueLifetime.map(v => iso(v.last_seen)),
        ...latest.map(l => iso(l.last_seen)),
        tvlLastUpdated,
      ].filter((x): x is string => x != null)
      const lastUpdated = candidateLastSeen.length
        ? candidateLastSeen.reduce((a, b) => (a > b ? a : b))
        : null
      const freshnessAge = ageSeconds(asOfMs, lastUpdated)
      const freshness = {
        asOf: asOf.toISOString(),
        windowStart: new Date(asOfMs - 24 * 60 * 60 * 1000).toISOString(),
        windowEnd: asOf.toISOString(),
        lastUpdated,
        ageSeconds: freshnessAge,
        staleAfterSeconds: STALE_AFTER_SECONDS,
        stale: lastUpdated === null || (freshnessAge !== null && freshnessAge > STALE_AFTER_SECONDS),
        venuesReporting,
        venuesExpected,
        venuesSilent: Math.max(0, venuesExpected - venuesReporting),
      }

      const result = {
        network,
        asOf: asOf.toISOString(),
        generatedAt: new Date().toISOString(),
        window: '24h',
        cache: {
          ttlSeconds: ttl,
          maxAgeSeconds: ttl,
          hit: false,
          storedAt: asOf.toISOString(),
          ageSeconds: 0,
        },
        venues,
        tvl,
        volume24h,
        topPairs,
        pegs,
        freshness,
      }

      await setCachedSnapshot(network, result, ttl)
      reply.header('X-Cache', 'MISS')
      reply.header('Cache-Control', `public, max-age=${ttl}`)
      return result
    },
  )
}
