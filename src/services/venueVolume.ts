import { pgPool } from '../db'
import { getEnabledNetworks } from '../network/enabledNetworks'
import { activeNetwork, getNetworkConfig, type NetworkName } from '../config'

const WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

type VolumeWindow = keyof typeof WINDOW_HOURS

export interface VenueVolumeEntry {
  venue: string
  baseVolume: number
  counterVolume: number
  samples: number
  pairs: number
  marketShare: number
  periodOverPeriodPctChange: number
  lastUpdated: string | null
  ageSeconds: number | null
  enabled: boolean
}

export interface VenueVolumeResponse {
  network: NetworkName
  window: VolumeWindow
  windowHours: number
  startTime: string
  endTime: string
  excludedVenues: string[]
  venues: VenueVolumeEntry[]
  totalVolume: {
    value: number | null
    unit: { code: string; issuer: string | null } | null
    reason: string | null
  }
  marketShares: {
    total: number
    variance: number
  }
  periodOverPeriodPctChange: number
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

/**
 * Calculate venue volume share for a given network and time window.
 * 
 * This function:
 * 1. Aggregates volume per venue across all pairs
 * 2. Calculates market share per venue (percentage of total volume)
 * 3. Calculates period-over-period percentage change
 * 4. Returns excluded/stale venues
 * 
 * @param network - The network to query (testnet or mainnet)
 * @param window - Time window (24h, 7d, 30d)
 * @returns Venue volume response with shares and changes
 */
export async function calculateVenueVolumeShare(
  network: NetworkName,
  window: VolumeWindow = '24h'
): Promise<VenueVolumeResponse> {
  const windowHours = WINDOW_HOURS[window]
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - windowHours * 60 * 60 * 1000)
  const endTimeISO = endTime.toISOString()
  const startTimeISO = startTime.toISOString()

  // Get all venue sources from the registry
  const { venueAdapters } = await import('../ingest/venues')
  const venueSources = [...new Set(venueAdapters.map(a => a.source))]
  const enabledBySource = new Map<string, boolean>()
  for (const a of venueAdapters) {
    enabledBySource.set(a.source, a.isEnabled(network))
  }

  // Only include sources whose config block exists for this network, so a
  // missing config key (as in tests) excludes the venue rather than throwing.
  // Sources that are always-on (SDEX/AMM return true without a config block)
  // are retained via the enabled check.
  const configuredSources = venueSources.filter(source => {
    const a = venueAdapters.find(ad => ad.source === source)
    if (!a) return false
    const enabled = a.isEnabled(network)
    if (enabled) return true
    const cfg = getNetworkConfig(network) as any
    const key = source === 'soroswap_amm' ? 'soroswap'
      : source === 'aquarius_amm' ? 'aquarius'
      : source === 'defindex_vault' ? 'defindex'
      : source === 'phoenix_amm' ? 'phoenix'
      : source === 'blend' ? 'blend'
      : source
    return cfg[key] !== undefined
  })

  // Query volume by venue for the requested window
  const currentQuery = `
    WITH bounds AS (
      SELECT NOW() as end_time,
             NOW() - INTERVAL '${windowHours} hours' as start_time
    )
    SELECT 
      pp.source,
      COUNT(*)::int AS samples,
      COALESCE(SUM(pp.base_volume::numeric), 0)::float AS base_volume,
      COALESCE(SUM(pp.counter_volume::numeric), 0)::float AS counter_volume,
      MAX(pp.timestamp) AS last_seen
    FROM price_points pp
    CROSS JOIN bounds
    WHERE pp.network = $1
      AND pp.timestamp > bounds.start_time
      AND pp.timestamp <= bounds.end_time
    GROUP BY pp.source
    ORDER BY pp.source
  `

  // Query volume by venue for the preceding window (period-over-period)
  const prevStartTime = new Date(startTime.getTime() - windowHours * 60 * 60 * 1000)
  const prevEndTime = new Date(startTime.getTime())

  const previousQuery = `
    WITH bounds AS (
      SELECT $1 as end_time,
             $2 as start_time
    )
    SELECT 
      pp.source,
      COALESCE(SUM(pp.base_volume::numeric), 0)::float AS base_volume
    FROM price_points pp
    CROSS JOIN bounds
    WHERE pp.network = $1
      AND pp.timestamp > bounds.start_time
      AND pp.timestamp <= bounds.end_time
    GROUP BY pp.source
  `

  // Execute both queries
  const [currentResult, previousResult] = await Promise.all([
    pgPool.query(currentQuery, [network]),
    pgPool.query(previousQuery, [prevEndTime, prevStartTime, network]),
  ])

  // Build previous volume map for period-over-period comparison
  const previousVolumes = new Map<string, number>()
  for (const row of previousResult.rows) {
    previousVolumes.set(row.source, row.base_volume || 0)
  }

  // Process current results
  const venuesMap = new Map<string, VenueVolumeEntry>()
  const excludedVenues: string[] = []

  // Build a map of venue data from current results
  const currentRowsMap = new Map<string, typeof currentResult.rows[0]>()
  for (const row of currentResult.rows) {
    currentRowsMap.set(row.source, row)
  }

  // Process all known venue sources from the registry
  for (const source of configuredSources) {
    const row = currentRowsMap.get(source)
    const baseVolume = row?.base_volume || 0
    const counterVolume = row?.counter_volume || 0
    const samples = row?.samples || 0
    const lastSeen = row?.last_seen ? new Date(row.last_seen as string | Date).toISOString() : null
    const ageSeconds = lastSeen ? Math.max(0, Math.floor((endTime.getTime() - new Date(lastSeen).getTime()) / 1000)) : null

    // Determine if venue is stale (no data in 5 minutes = 300 seconds)
    const isStale = samples === 0 || (ageSeconds !== null && ageSeconds > 300)

    if (isStale && samples === 0) {
      excludedVenues.push(source)
    }

    // Calculate period-over-period change
    const prevVolume = previousVolumes.get(source) || 0
    let periodOverPeriodPctChange = 0
    if (prevVolume === 0) {
      periodOverPeriodPctChange = baseVolume > 0 ? 100 : 0
    } else {
      periodOverPeriodPctChange = ((baseVolume - prevVolume) / prevVolume) * 100
    }

    venuesMap.set(source, {
      venue: source,
      baseVolume,
      counterVolume,
      samples,
      pairs: 1, // Could be enhanced to count distinct pairs per venue
      marketShare: 0, // Will calculate after total is known
      periodOverPeriodPctChange,
      lastUpdated: lastSeen,
      ageSeconds,
      enabled: enabledBySource.get(source) ?? false,
    })
  }

  // Convert venues map to array
  const venues: VenueVolumeEntry[] = Array.from(venuesMap.values())

  // Calculate total volume and market shares
  const totalVolume = venues.reduce((sum, v) => sum + v.baseVolume, 0)

  for (const venue of venues) {
    venue.marketShare = totalVolume > 0 ? (venue.baseVolume / totalVolume) * 100 : 0
  }

  // Calculate market share total and variance (for validation)
  const marketShareTotal = venues.reduce((sum, v) => sum + v.marketShare, 0)
  const marketShareVariance = venues.length > 0
    ? venues.reduce((sum, v) => sum + Math.pow(v.marketShare - marketShareTotal / venues.length, 2), 0) / venues.length
    : 0

  // Calculate overall period-over-period change
  const totalPrevVolume = Array.from(previousVolumes.values()).reduce((sum, v) => sum + v, 0)
  let overallPeriodOverPeriodPctChange = 0
  if (totalPrevVolume === 0) {
    overallPeriodOverPeriodPctChange = totalVolume > 0 ? 100 : 0
  } else {
    overallPeriodOverPeriodPctChange = ((totalVolume - totalPrevVolume) / totalPrevVolume) * 100
  }

  // Collapse total volume to single unit (simplified - just base volume sum)
  // In a real implementation, this would properly handle mixed units
  const totalVolumeInfo = {
    value: totalVolume,
    unit: { code: 'base', issuer: null } as { code: string; issuer: string | null } | null,
    reason: null,
  }

  return {
    network,
    window,
    windowHours,
    startTime: startTimeISO,
    endTime: endTimeISO,
    excludedVenues,
    venues: venues.sort((a, b) => a.venue.localeCompare(b.venue)),
    totalVolume: totalVolumeInfo,
    marketShares: {
      total: marketShareTotal,
      variance: marketShareVariance,
    },
    periodOverPeriodPctChange: overallPeriodOverPeriodPctChange,
  }
}

export type { VolumeWindow }