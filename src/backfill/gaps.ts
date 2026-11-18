import type { NetworkName } from '../config'

function getPrisma() {
  return (globalThis as any).__lens_prisma
}

function getPgPool() {
  return (globalThis as any).__lens_pgPool
}
import type { GapRecord, GapStatus, OverlappingGapSummary } from './types'

interface GapRow {
  id: string
  network: string
  pair: string
  source: string
  start: Date
  end: Date
  status: string
  detectedAt?: Date
  updatedAt?: Date
}

/** Expected maximum cadence between data points before an interval is considered a gap. */
export const EXPECTED_CADENCE_MS: Record<string, number> = {
  SDEX: 300_000, // 5 minutes
  AMM: 300_000, // 5 minutes
  soroswap_amm: 300_000, // 5 minutes (poll is 60s; 5 missed cycles = hole)
  aquarius_amm: 300_000, // 5 minutes
  default: 300_000,
}

/** Returns the expected cadence in milliseconds for a source. */
export function getExpectedCadenceMs(source: string): number {
  return EXPECTED_CADENCE_MS[source] ?? EXPECTED_CADENCE_MS.default
}

/**
 * Determines whether a source supports historical backfill.
 * SDEX and AMM trades can be paged from Stellar Horizon.
 * Soroswap and Aquarius are state-only snapshot APIs without historical trade endpoints.
 */
export function supportsHistory(source: string): boolean {
  const norm = source.toUpperCase()
  return norm === 'SDEX' || norm === 'AMM'
}

export interface DetectGapsOptions {
  network: NetworkName
  pair: string
  source: string
  start?: Date
  end?: Date
  cadenceMs?: number
}

/**
 * Detects holes in ingested price points for a specific (source, pair, network).
 * A hole is any period >= cadenceMs without price points.
 * Records the detected gaps in persistent storage idempotently.
 */
export async function detectGaps(options: DetectGapsOptions): Promise<GapRecord[]> {
  const pgPool = getPgPool()
  if (!pgPool?.query) return []
  const { network, pair, source } = options
  const cadenceMs = options.cadenceMs ?? getExpectedCadenceMs(source)
  const end = options.end ?? new Date()

  // Determine scan start: use provided start, or find earliest point, or default to 24h lookback
  let start = options.start
  if (!start) {
    const earliestResult = await pgPool.query(
      `SELECT MIN(timestamp) as earliest FROM price_points
       WHERE network = $1 AND pair_key = $2 AND source = $3`,
      [network, pair, source]
    )
    const earliest = earliestResult.rows[0]?.earliest
    start = earliest ? new Date(earliest) : new Date(end.getTime() - 24 * 60 * 60 * 1000)
  }

  if (start >= end) {
    return []
  }

  // Fetch all existing price points in [start, end] ordered by timestamp
  const pointsResult = await pgPool.query(
    `SELECT timestamp FROM price_points
     WHERE network = $1 AND pair_key = $2 AND source = $3
       AND timestamp >= $4 AND timestamp <= $5
     ORDER BY timestamp ASC`,
    [network, pair, source, start, end]
  )

  const timestamps = pointsResult.rows.map((r: any) => new Date(r.timestamp))
  const rawGaps: Array<{ start: Date; end: Date }> = []

  if (timestamps.length === 0) {
    // Entire window is missing
    if (end.getTime() - start.getTime() >= cadenceMs) {
      rawGaps.push({ start, end })
    }
  } else {
    // Check leading edge (start -> first point)
    if (timestamps[0].getTime() - start.getTime() >= cadenceMs) {
      rawGaps.push({ start, end: timestamps[0] })
    }

    // Check interior gaps between successive points
    for (let i = 0; i < timestamps.length - 1; i++) {
      const diff = timestamps[i + 1].getTime() - timestamps[i].getTime()
      if (diff >= cadenceMs) {
        rawGaps.push({ start: timestamps[i], end: timestamps[i + 1] })
      }
    }

    // Check trailing edge (last point -> end)
    const lastPoint = timestamps[timestamps.length - 1]
    if (end.getTime() - lastPoint.getTime() >= cadenceMs) {
      rawGaps.push({ start: lastPoint, end })
    }
  }

  if (rawGaps.length === 0) {
    return []
  }

  return await recordGaps({
    network,
    pair,
    source,
    gaps: rawGaps,
  })
}

export interface RecordGapsInput {
  network: NetworkName
  pair: string
  source: string
  gaps: Array<{ start: Date; end: Date; status?: GapStatus }>
}

/**
 * Idempotently records gap intervals into `ingestion_gaps`.
 * Merges adjacent or overlapping gaps with existing persistent rows.
 * If the source cannot provide history, gaps are automatically marked 'permanent'.
 */
export async function recordGaps(input: RecordGapsInput): Promise<GapRecord[]> {
  const prisma = getPrisma()
  if (!prisma?.ingestionGap?.findMany) return []
  const { network, pair, source, gaps } = input
  if (gaps.length === 0) return []

  const sourceSupportsHistory = supportsHistory(source)
  const defaultStatus: GapStatus = sourceSupportsHistory ? 'open' : 'permanent'

  const savedGaps: GapRecord[] = []

  for (const gap of gaps) {
    const desiredStatus = !sourceSupportsHistory ? 'permanent' : (gap.status ?? defaultStatus)

    // Find any existing gap rows for this (network, pair, source) that overlap or touch [gap.start, gap.end]
    // Tolerance for adjacency: within 1 second
    const overlapping: GapRow[] = await prisma.ingestionGap.findMany({
      where: {
        network,
        pair,
        source,
        AND: [
          { start: { lte: new Date(gap.end.getTime() + 1000) } },
          { end: { gte: new Date(gap.start.getTime() - 1000) } },
        ],
      },
      orderBy: { start: 'asc' },
    })

    if (overlapping.length === 0) {
      // Clean insert
      const created = await prisma.ingestionGap.create({
        data: {
          network,
          pair,
          source,
          start: gap.start,
          end: gap.end,
          status: desiredStatus,
        },
      })
      savedGaps.push({
        id: created.id,
        network: created.network as NetworkName,
        pair: created.pair,
        source: created.source,
        start: created.start,
        end: created.end,
        status: created.status as GapStatus,
        detectedAt: created.detectedAt,
        updatedAt: created.updatedAt,
      })
    } else {
      // Merge with existing overlapping/adjacent rows
      const mergedStart = new Date(Math.min(gap.start.getTime(), ...overlapping.map(o => o.start.getTime())))
      const mergedEnd = new Date(Math.max(gap.end.getTime(), ...overlapping.map(o => o.end.getTime())))

      // Determine merged status:
      // - If source has no history capability -> permanent
      // - If any existing was permanent -> permanent
      // - If all existing were filled and new gap is completely inside filled range -> filled
      // - Otherwise -> open
      let mergedStatus: GapStatus = desiredStatus
      if (!sourceSupportsHistory || overlapping.some(o => o.status === 'permanent')) {
        mergedStatus = 'permanent'
      } else if (overlapping.every(o => o.status === 'filled') && gap.status === 'filled') {
        mergedStatus = 'filled'
      } else if (overlapping.some(o => o.status === 'open') || desiredStatus === 'open') {
        mergedStatus = 'open'
      }

      const primary = overlapping[0]
      const updated = await prisma.ingestionGap.update({
        where: { id: primary.id },
        data: {
          start: mergedStart,
          end: mergedEnd,
          status: mergedStatus,
          updatedAt: new Date(),
        },
      })

      // Delete extra redundant overlapping rows that were consolidated
      if (overlapping.length > 1) {
        const extraIds = overlapping.slice(1).map(o => o.id)
        await prisma.ingestionGap.deleteMany({
          where: { id: { in: extraIds } },
        })
      }

      savedGaps.push({
        id: updated.id,
        network: updated.network as NetworkName,
        pair: updated.pair,
        source: updated.source,
        start: updated.start,
        end: updated.end,
        status: updated.status as GapStatus,
        detectedAt: updated.detectedAt,
        updatedAt: updated.updatedAt,
      })
    }
  }

  return savedGaps
}

function getPairVariants(pair: string): string[] {
  if (pair.includes('/')) {
    const [a, b] = pair.split('/')
    return a === b ? [pair] : [pair, `${b}/${a}`]
  }
  return [pair]
}

export interface FindOverlappingGapsOptions {
  network: NetworkName
  pair: string
  start: Date
  end: Date
  source?: string
}

/**
 * Finds all known gaps (status 'open' or 'permanent') that overlap a given time window.
 * Returns an array of gap summaries. Filled gaps are excluded since the window is complete.
 */
export async function findOverlappingGaps(options: FindOverlappingGapsOptions): Promise<OverlappingGapSummary[]> {
  const prisma = getPrisma()
  if (!prisma?.ingestionGap?.findMany) {
    return []
  }
  const { network, pair, start, end, source } = options
  const pairVariants = getPairVariants(pair)

  const whereClause: any = {
    network,
    pair: pairVariants.length > 1 ? { in: pairVariants } : pair,
    status: { in: ['open', 'permanent'] },
    start: { lt: end },
    end: { gt: start },
  }

  if (source) {
    whereClause.source = source
  }

  const gaps: GapRow[] = await prisma.ingestionGap.findMany({
    where: whereClause,
    orderBy: { start: 'asc' },
  })

  return gaps.map((g: any) => ({
    source: g.source,
    start: g.start.toISOString(),
    end: g.end.toISOString(),
    status: g.status as 'open' | 'permanent',
  }))
}

export interface MarkGapsFilledOptions {
  network: NetworkName
  pair: string
  source: string
  start: Date
  end: Date
}

/**
 * Updates gap records as a range gets filled (partially or fully).
 * A gap covered completely is marked 'filled'.
 * A gap covered partially is split into filled and open portions.
 */
export async function markGapsFilled(options: MarkGapsFilledOptions): Promise<number> {
  const prisma = getPrisma()
  if (!prisma?.ingestionGap?.findMany) return 0
  const { network, pair, source, start, end } = options

  const pairVariants = getPairVariants(pair)
  // Find all open gaps overlapping the filled range
  const overlapping: GapRow[] = await prisma.ingestionGap.findMany({
    where: {
      network,
      pair: pairVariants.length > 1 ? { in: pairVariants } : pair,
      source,
      status: 'open',
      start: { lt: end },
      end: { gt: start },
    },
    orderBy: { start: 'asc' },
  })

  let modifiedCount = 0

  for (const gap of overlapping) {
    const isCoveredCompletely = start <= gap.start && end >= gap.end
    if (isCoveredCompletely) {
      await prisma.ingestionGap.update({
        where: { id: gap.id },
        data: { status: 'filled', updatedAt: new Date() },
      })
      modifiedCount++
    } else if (start <= gap.start && end < gap.end) {
      // Partial fill on the left side
      // 1. Update existing row to represent the filled range [gap.start, end]
      await prisma.ingestionGap.update({
        where: { id: gap.id },
        data: { end, status: 'filled', updatedAt: new Date() },
      })
      // 2. Insert new row for remaining open range [end, gap.end]
      await prisma.ingestionGap.create({
        data: {
          network,
          pair,
          source,
          start: end,
          end: gap.end,
          status: 'open',
        },
      })
      modifiedCount++
    } else if (start > gap.start && end >= gap.end) {
      // Partial fill on the right side
      // 1. Update existing row to represent the remaining open range [gap.start, start]
      await prisma.ingestionGap.update({
        where: { id: gap.id },
        data: { end: start, status: 'open', updatedAt: new Date() },
      })
      // 2. Insert new row for filled range [start, gap.end]
      await prisma.ingestionGap.create({
        data: {
          network,
          pair,
          source,
          start,
          end: gap.end,
          status: 'filled',
        },
      })
      modifiedCount++
    } else {
      // Middle fill: gap.start < start && end < gap.end
      // 1. Left remaining open: [gap.start, start]
      await prisma.ingestionGap.update({
        where: { id: gap.id },
        data: { end: start, status: 'open', updatedAt: new Date() },
      })
      // 2. Middle filled: [start, end]
      await prisma.ingestionGap.create({
        data: {
          network,
          pair,
          source,
          start,
          end,
          status: 'filled',
        },
      })
      // 3. Right remaining open: [end, gap.end]
      await prisma.ingestionGap.create({
        data: {
          network,
          pair,
          source,
          start: end,
          end: gap.end,
          status: 'open',
        },
      })
      modifiedCount++
    }
  }

  return modifiedCount
}

export interface MarkGapsPermanentOptions {
  network: NetworkName
  pair: string
  source: string
  start: Date
  end: Date
}

/**
 * Marks overlapping gaps permanent, or creates a permanent gap if none exists.
 * Used when attempting backfill against an unfillable source.
 */
export async function markGapsPermanent(options: MarkGapsPermanentOptions): Promise<GapRecord[]> {
  const { network, pair, source, start, end } = options
  return await recordGaps({
    network,
    pair,
    source,
    gaps: [{ start, end, status: 'permanent' }],
  })
}
