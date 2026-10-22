import type { NetworkName } from '../config'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { pgPool } from '../db'

export type OracleSourceStatus = 'not_configured' | 'available' | 'unreachable' | 'empty'
export type DeviationStatus = 'aligned' | 'minor_deviation' | 'major_deviation' | 'partial'

export interface OracleSourceComparison {
  name: string
  price: number | null
  timestamp: string | null
  deviationPct: number | null
  status: OracleSourceStatus
  ageSeconds: number | null
}

export interface OracleComparison {
  asset: string
  network: NetworkName
  lens: number | null
  reflector: number | null
  deviationPct: number | null
  status: DeviationStatus
  fetchedAt: string
  oracles: OracleSourceComparison[]
}

export function deviationPct(lens: number | null, oracle: number | null): number | null {
  if (lens === null || oracle === null || oracle === 0) return null
  return parseFloat((Math.abs(oracle - lens) / Math.abs(oracle) * 100).toFixed(4))
}

export function deviationStatus(deviation: number | null): DeviationStatus {
  if (deviation === null) return 'partial'
  return deviation < 1 ? 'aligned' : deviation < 5 ? 'minor_deviation' : 'major_deviation'
}

async function fetchLensPrice(assetCode: string, network: NetworkName): Promise<number | null> {
  const result = await pgPool.query(
    `SELECT
       COALESCE(SUM(price::numeric * base_volume::numeric), 0)
         / NULLIF(SUM(base_volume::numeric), 0) AS vwap
     FROM price_points
     WHERE (asset_a = $1 OR asset_b = $1)
       AND network = $2
       AND timestamp > NOW() - INTERVAL '5 minutes'
     GROUP BY pair_key
     LIMIT 1`,
    [assetCode, network]
  )
  return result.rows[0] ? parseFloat(result.rows[0].vwap) : null
}

type SourceResult =
  | { name: string; status: 'not_configured' | 'unreachable' | 'empty'; quote: null }
  | { name: string; status: 'available'; quote: { price: number; timestamp: number } }

async function fetchSource(adapter: OracleAdapter, assetCode: string, network: NetworkName): Promise<SourceResult> {
  if (!adapter.isConfigured(network)) {
    return { name: adapter.name, status: 'not_configured', quote: null }
  }
  try {
    const quote = await adapter.getPrice(assetCode, network)
    // A configured oracle that answers with nothing is different from one we
    // could not reach, so the two are reported separately.
    return quote
      ? { name: adapter.name, status: 'available', quote }
      : { name: adapter.name, status: 'empty', quote: null }
  } catch {
    // A failed oracle stays visible in the response instead of being dropped.
    return { name: adapter.name, status: 'unreachable', quote: null }
  }
}

/**
 * Compares the Lens VWAP for an asset against every configured oracle.
 * Returns null when there is neither a Lens price nor a configured oracle,
 * which callers map to their own "not found" response.
 */
export async function compareOracles(
  assetCode: string,
  network: NetworkName,
  adapters: OracleAdapter[]
): Promise<OracleComparison | null> {
  const [lensPrice, sources] = await Promise.all([
    fetchLensPrice(assetCode, network),
    Promise.all(adapters.map(adapter => fetchSource(adapter, assetCode, network))),
  ])

  if (lensPrice === null && !sources.some(source => source.status !== 'not_configured')) {
    return null
  }

  const now = Date.now()
  const oracles = sources.map(source => ({
    name: source.name,
    price: source.quote?.price ?? null,
    timestamp: source.quote ? new Date(source.quote.timestamp * 1000).toISOString() : null,
    deviationPct: deviationPct(lensPrice, source.quote?.price ?? null),
    status: source.status,
    ageSeconds: source.quote ? Math.max(0, Math.floor(now / 1000 - source.quote.timestamp)) : null,
  }))
  const reflector = sources.find(source => source.name === 'reflector')
  const reflectorPrice = reflector?.quote?.price ?? null
  const reflectorDeviation = deviationPct(lensPrice, reflectorPrice)

  return {
    asset: assetCode,
    network,
    lens: lensPrice,
    // Keep the original fields while clients migrate to the multi-oracle list.
    reflector: reflectorPrice,
    deviationPct: reflectorDeviation,
    status: deviationStatus(reflectorDeviation),
    fetchedAt: new Date(now).toISOString(),
    oracles,
  }
}
