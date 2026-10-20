import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { config, getNetworkConfig } from '../src/config'
import {
  STALENESS_THRESHOLD_SECONDS,
  HIGH_CONFIDENCE_MAX_AGE_SECONDS,
  MEDIUM_CONFIDENCE_MAX_AGE_SECONDS,
} from '../src/aggregator/vwap'
import { LIVE_WINDOW_MS } from '../src/routes/venues'
import {
  MIN_OUTLIER_SAMPLES,
  IQR_MULTIPLIER,
  MODIFIED_Z_SCORE_THRESHOLD,
  MODIFIED_Z_SCORE_FACTOR,
} from '../src/pricing/twap'
import {
  TWAP_WINDOW_MIN_MINUTES,
  TWAP_WINDOW_MAX_MINUTES,
  TWAP_WINDOW_DEFAULT_MINUTES,
  TWAP_SAMPLE_INTERVAL_MIN_SECONDS,
  TWAP_SAMPLE_INTERVAL_MAX_SECONDS,
  TWAP_SAMPLE_INTERVAL_DEFAULT_SECONDS,
  VWAP_WINDOW_MIN_MINUTES,
  VWAP_WINDOW_MAX_MINUTES,
  VWAP_WINDOW_DEFAULT_MINUTES,
} from '../src/routes/price'
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from '../src/api/rest'
import { SCREENER_DEFAULT_LIMIT, SCREENER_MAX_LIMIT } from '../src/routes/screener'
import { MIN_OBSERVATIONS as SPREAD_MIN_OBSERVATIONS } from '../src/routes/spreads'
import { SNAPSHOT_RETENTION_DAYS, SNAPSHOT_PRUNE_BATCH_SIZE } from '../src/jobs/snapshotRetention'
import { DEFAULT_RETENTION_DAYS as PARTITION_RETENTION_DAYS } from '../src/partitioning/pricePoints'
import { venueAdapters } from '../src/ingest/venues'

const DOC_PATH = resolve(__dirname, '../docs/data-quality.md')
const README_PATH = resolve(__dirname, '../README.md')
const OPENAPI_YAML_PATH = resolve(__dirname, '../openapi.yaml')
const OPENAPI_JSON_PATH = resolve(__dirname, '../openapi.json')

function parseBoundsTable(docContent: string): Record<string, { value: number; link: string }> {
  const bounds: Record<string, { value: number; link: string }> = {}
  const lines = docContent.split('\n')
  let inTable = false

  for (const line of lines) {
    if (line.includes('## Summary of Enforced Bounds')) {
      inTable = true
      continue
    }
    if (inTable && line.startsWith('## ')) {
      break
    }
    if (inTable && line.startsWith('|') && line.includes('`')) {
      // Row format: | `param` | [`value`](link) | units | [`link`](link) | description |
      const parts = line.split('|').map((s) => s.trim()).filter(Boolean)
      if (parts.length >= 4) {
        const paramMatch = parts[0].match(/`([^`]+)`/)
        const valueMatch = parts[1].match(/\[`?([0-9.]+)`?\]\(([^)]+)\)/)
        if (paramMatch && valueMatch) {
          bounds[paramMatch[1]] = {
            value: parseFloat(valueMatch[1]),
            link: valueMatch[2],
          }
        }
      }
    }
  }

  return bounds
}

describe('Data Quality Documentation & Drift Guard (#249)', () => {
  it('docs/data-quality.md exists and covers all required guarantee sections', () => {
    expect(existsSync(DOC_PATH)).toBe(true)
    const content = readFileSync(DOC_PATH, 'utf8')
    expect(content.length).toBeGreaterThan(500)

    expect(content).toContain('Freshness Guarantees')
    expect(content).toContain('Completeness Guarantees')
    expect(content).toContain('Precision Guarantees')
    expect(content).toContain('Venue Inclusion Guarantees')
    expect(content).toContain('Violation Semantics Summary')
    expect(content).toContain('Summary of Enforced Bounds')
  })

  it('is linked from README.md and OpenAPI description', () => {
    const readme = readFileSync(README_PATH, 'utf8')
    expect(readme).toContain('docs/data-quality.md')

    const openapiYaml = readFileSync(OPENAPI_YAML_PATH, 'utf8')
    expect(openapiYaml).toContain('docs/data-quality.md')

    const openapiJson = readFileSync(OPENAPI_JSON_PATH, 'utf8')
    expect(openapiJson).toContain('docs/data-quality.md')
  })

  it('ensures every link in docs/data-quality.md points to an existing file', () => {
    const content = readFileSync(DOC_PATH, 'utf8')
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
    const docDir = dirname(DOC_PATH)
    let match: RegExpExecArray | null
    let linkCount = 0

    while ((match = linkRegex.exec(content)) !== null) {
      const url = match[2]
      if (url.startsWith('http://') || url.startsWith('https://')) continue
      linkCount++
      const filePath = url.split('#')[0]
      const resolvedPath = resolve(docDir, filePath)
      expect(
        existsSync(resolvedPath),
        `Link target does not exist: "${url}" (resolved to ${resolvedPath})`
      ).toBe(true)
    }

    expect(linkCount).toBeGreaterThan(20)
  })

  it('ensures every numerical bound in the prose and tables links to code or config', () => {
    const content = readFileSync(DOC_PATH, 'utf8')
    // Strip code blocks and link targets so we only inspect the prose text
    const stripped = content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, 'LINKED')

    // Search for any unlinked numbers (digits) in the remaining text
    const unlinkedNumberMatches = stripped.match(/\b\d+(\.\d+)?\b/g)
    // No unlinked numbers should remain
    expect(unlinkedNumberMatches ?? []).toEqual([])
  })

  it('asserts documented bounds match live configured values exactly', () => {
    const content = readFileSync(DOC_PATH, 'utf8')
    const bounds = parseBoundsTable(content)

    // Verify all key bounds exist in the parsed table
    expect(Object.keys(bounds).length).toBeGreaterThanOrEqual(30)

    // 1. Freshness
    expect(bounds['staleness_threshold'].value).toBe(STALENESS_THRESHOLD_SECONDS)
    expect(bounds['high_confidence_max_age'].value).toBe(HIGH_CONFIDENCE_MAX_AGE_SECONDS)
    expect(bounds['medium_confidence_max_age'].value).toBe(MEDIUM_CONFIDENCE_MAX_AGE_SECONDS)
    expect(bounds['venue_liveness_window'].value).toBe(LIVE_WINDOW_MS)
    expect(bounds['indexer_poll_interval'].value).toBe(config.indexer.pollIntervalMs)
    expect(bounds['sdex_page_size'].value).toBe(config.indexer.sdexPageSize)
    expect(bounds['amm_page_size'].value).toBe(config.indexer.ammPageSize)
    expect(bounds['soroswap_poll_interval'].value).toBe(getNetworkConfig('testnet').soroswap.pollIntervalMs)
    expect(bounds['price_cache_ttl'].value).toBe(config.cache.priceTtl)
    expect(bounds['http_timeout_ms'].value).toBe(config.http.timeoutMs)
    expect(bounds['snapshot_retention_days'].value).toBe(SNAPSHOT_RETENTION_DAYS)
    expect(bounds['snapshot_retention_batch_size'].value).toBe(SNAPSHOT_PRUNE_BATCH_SIZE)
    expect(bounds['price_points_retention_days'].value).toBe(PARTITION_RETENTION_DAYS)

    // 2. Completeness
    expect(bounds['min_outlier_samples'].value).toBe(MIN_OUTLIER_SAMPLES)
    expect(bounds['iqr_multiplier'].value).toBe(IQR_MULTIPLIER)
    expect(bounds['modified_z_score_threshold'].value).toBe(MODIFIED_Z_SCORE_THRESHOLD)
    expect(bounds['modified_z_score_factor'].value).toBe(MODIFIED_Z_SCORE_FACTOR)
    expect(bounds['twap_window_min'].value).toBe(TWAP_WINDOW_MIN_MINUTES)
    expect(bounds['twap_window_max'].value).toBe(TWAP_WINDOW_MAX_MINUTES)
    expect(bounds['twap_window_default'].value).toBe(TWAP_WINDOW_DEFAULT_MINUTES)
    expect(bounds['twap_sample_interval_min'].value).toBe(TWAP_SAMPLE_INTERVAL_MIN_SECONDS)
    expect(bounds['twap_sample_interval_max'].value).toBe(TWAP_SAMPLE_INTERVAL_MAX_SECONDS)
    expect(bounds['twap_sample_interval_default'].value).toBe(TWAP_SAMPLE_INTERVAL_DEFAULT_SECONDS)
    expect(bounds['vwap_window_min'].value).toBe(VWAP_WINDOW_MIN_MINUTES)
    expect(bounds['vwap_window_max'].value).toBe(VWAP_WINDOW_MAX_MINUTES)
    expect(bounds['vwap_window_default'].value).toBe(VWAP_WINDOW_DEFAULT_MINUTES)
    expect(bounds['history_default_limit'].value).toBe(HISTORY_DEFAULT_LIMIT)
    expect(bounds['history_max_limit'].value).toBe(HISTORY_MAX_LIMIT)
    expect(bounds['screener_default_limit'].value).toBe(SCREENER_DEFAULT_LIMIT)
    expect(bounds['screener_max_limit'].value).toBe(SCREENER_MAX_LIMIT)
    expect(bounds['spread_min_observations'].value).toBe(SPREAD_MIN_OBSERVATIONS)

    // 3. Venues
    expect(bounds['registered_venues_count'].value).toBe(venueAdapters.length)

    // 4. Precision
    expect(bounds['database_price_precision'].value).toBe(36)
    expect(bounds['database_price_scale'].value).toBe(18)
    expect(bounds['stellar_native_scale'].value).toBe(7)
  })

  it('ensures line anchors in docs/data-quality.md resolve within valid line numbers', () => {
    const content = readFileSync(DOC_PATH, 'utf8')
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
    const docDir = dirname(DOC_PATH)
    let match: RegExpExecArray | null

    while ((match = linkRegex.exec(content)) !== null) {
      const url = match[2]
      if (url.startsWith('http://') || url.startsWith('https://')) continue
      const [filePath, anchor] = url.split('#')
      if (anchor && anchor.startsWith('L')) {
        const lineNum = parseInt(anchor.slice(1), 10)
        const resolvedPath = resolve(docDir, filePath)
        const targetContent = readFileSync(resolvedPath, 'utf8')
        const totalLines = targetContent.split('\n').length
        expect(
          lineNum,
          `Line anchor L${lineNum} exceeds total lines (${totalLines}) in ${filePath}`
        ).toBeLessThanOrEqual(totalLines)
        expect(lineNum).toBeGreaterThan(0)
      }
    }
  })

  it('detects drift between docs/data-quality.md and prisma schema precision/scale', () => {
    const content = readFileSync(DOC_PATH, 'utf8')
    const bounds = parseBoundsTable(content)
    const schemaPrisma = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8')

    const priceMatch = schemaPrisma.match(/price\s+Decimal\s+@db\.Decimal\((\d+),\s*(\d+)\)/)
    expect(priceMatch).toBeTruthy()
    const [, prismaPrecision, prismaScale] = priceMatch!
    expect(bounds['database_price_precision'].value).toBe(parseInt(prismaPrecision, 10))
    expect(bounds['database_price_scale'].value).toBe(parseInt(prismaScale, 10))

    const volumeMatch = schemaPrisma.match(/baseVolume\s+Decimal\s+@map\("[^"]+"\)\s+@db\.Decimal\((\d+),\s*(\d+)\)/)
    expect(volumeMatch).toBeTruthy()
    const [, , volumeScale] = volumeMatch!
    expect(bounds['stellar_native_scale'].value).toBe(parseInt(volumeScale, 10))
  })

  it('fails drift guard when a documented bound disagrees with configuration', () => {
    const content = readFileSync(DOC_PATH, 'utf8')
    const simulatedDrift = content.replace(
      '`staleness_threshold` | [`300`]',
      '`staleness_threshold` | [`999`]'
    )
    const bounds = parseBoundsTable(simulatedDrift)
    expect(bounds['staleness_threshold'].value).not.toBe(STALENESS_THRESHOLD_SECONDS)
  })
})
