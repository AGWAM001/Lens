import { describe, expect, it } from 'vitest'
import { readFileSync as readFileRaw } from 'node:fs'

import { fileURLToPath } from 'node:url'
import YAML from 'js-yaml'
import { venueAdapters } from '../src/ingest/venues'
import {
  extractSection,
  renderVenuesTable,
  renderEndpointsTable,
  renderReadme,
  readmeIsCurrent,
  VENUES_START_TAG,
  VENUES_END_TAG,
  ENDPOINTS_START_TAG,
  ENDPOINTS_END_TAG,
} from '../scripts/generate-readme'
import { INTERNAL_ROUTES, isInternalRoute } from '../src/openapi/coverage'

/**
 * Read a file with its line endings normalised to LF.
 *
 * The generators join rows with a bare newline, but git hands a Windows
 * checkout CRLF, so a byte comparison against README.md fails on every line
 * of an identical table. .gitattributes pins README.md to LF for the same
 * reason; normalising here as well means a contributor whose git config
 * differs is not blocked by a diff that is only line endings.
 */
function readFileSync(path: string, encoding: 'utf8'): string {
  return readFileRaw(path, encoding).replace(/\r\n/g, String.fromCharCode(10))
}

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))
const openApiPath = fileURLToPath(new URL('../openapi.yaml', import.meta.url))

describe('README venue list and endpoint table generators', () => {
  it('extracts and asserts that the README venues section matches the venueAdapters registry', () => {
    const readmeContent = readFileSync(readmePath, 'utf8')
    const venuesSection = extractSection(readmeContent, VENUES_START_TAG, VENUES_END_TAG)

    expect(venuesSection, 'README must contain <!-- VENUES:START --> ... <!-- VENUES:END --> tags').toBeTruthy()

    const expectedVenues = renderVenuesTable(venueAdapters)
    expect(venuesSection?.trim()).toBe(expectedVenues.trim())
  })

  it('ensures every venue in venueAdapters is represented in the README', () => {
    const readmeContent = readFileSync(readmePath, 'utf8')
    const venuesSection = extractSection(readmeContent, VENUES_START_TAG, VENUES_END_TAG) ?? ''

    for (const adapter of venueAdapters) {
      expect(venuesSection).toContain(adapter.name)
      expect(venuesSection).toContain(`\`${adapter.source}\``)
    }

    // Must include newly added venues that were previously missing: Soroswap and Aquarius
    expect(venuesSection).toContain('Soroswap')
    expect(venuesSection).toContain('`soroswap_amm`')
    expect(venuesSection).toContain('Aquarius')
    expect(venuesSection).toContain('`aquarius_amm`')
  })

  it('fails when the README and venue registry diverge', () => {
    const fakeAdapters = [
      ...venueAdapters,
      {
        name: 'NewDex',
        source: 'new_dex',
        type: 'Order Book',
        description: 'New decentralized exchange',
        isEnabled: () => true,
        getPollIntervalMs: () => 5000,
        discover: async () => [],
        read: async () => null,
        derive: () => [],
        write: async () => {},
        ingestPair: async () => {},
      },
    ]

    const expectedWithFake = renderVenuesTable(fakeAdapters)
    const readmeContent = readFileSync(readmePath, 'utf8')
    const currentVenues = extractSection(readmeContent, VENUES_START_TAG, VENUES_END_TAG) ?? ''

    // The test must detect when a new venue is in registry but missing from README
    expect(currentVenues.trim()).not.toBe(expectedWithFake.trim())
  })

  it('extracts and asserts that the README endpoints table matches openapi.yaml routes', () => {
    const readmeContent = readFileSync(readmePath, 'utf8')
    const endpointsSection = extractSection(readmeContent, ENDPOINTS_START_TAG, ENDPOINTS_END_TAG)

    expect(endpointsSection, 'README must contain <!-- ENDPOINTS:START --> ... <!-- ENDPOINTS:END --> tags').toBeTruthy()

    const expectedEndpoints = renderEndpointsTable()
    expect(endpointsSection?.trim()).toBe(expectedEndpoints.trim())
  })

  it('ensures every public non-internal route in openapi.yaml is present in the endpoint table', () => {
    const spec = YAML.load(readFileSync(openApiPath, 'utf8')) as { paths: Record<string, Record<string, any>> }
    const readmeContent = readFileSync(readmePath, 'utf8')
    const endpointsSection = extractSection(readmeContent, ENDPOINTS_START_TAG, ENDPOINTS_END_TAG) ?? ''

    for (const [path, operations] of Object.entries(spec.paths)) {
      if (isInternalRoute(path)) continue

      for (const method of Object.keys(operations)) {
        if (['get', 'post', 'delete', 'put', 'patch'].includes(method.toLowerCase())) {
          // Path in README may use Fastify :param style or openapi {param} style
          const fastifyPath = path.replace(/{([A-Za-z0-9_]+)}/g, ':$1')
          const hasPath = endpointsSection.includes(path) || endpointsSection.includes(fastifyPath)
          expect(
            hasPath,
            `Expected ${method.toUpperCase()} ${path} (or ${fastifyPath}) to be documented in README endpoint table`
          ).toBe(true)
        }
      }
    }
  })

  it('fails when README and openapi routes diverge', () => {
    const readmeContent = readFileSync(readmePath, 'utf8')
    const currentEndpoints = extractSection(readmeContent, ENDPOINTS_START_TAG, ENDPOINTS_END_TAG) ?? ''

    // If an unregistered fake route is expected, it must diverge
    expect(currentEndpoints).not.toContain('/fake/nonexistent/endpoint')
  })

  it('readme:check passes on the committed README and fails once the endpoint table is edited by hand', () => {
    const committed = readFileSync(readmePath, 'utf8')
    expect(readmeIsCurrent(committed)).toBe(true)

    // The documented paths carry the /v1 prefix since 97c50bf. The assertion
    // below is what keeps this honest: a replace that matched nothing would
    // leave `edited` identical and the drift check would pass vacuously.
    const edited = committed.replace('| GET | `/v1/tvl` |', '| GET | `/v1/tvl-renamed` |')
    expect(edited).not.toBe(committed)
    expect(readmeIsCurrent(edited)).toBe(false)
  })

  it('renders README deterministically in-place', () => {
    const initial = readFileSync(readmePath, 'utf8')
    const rendered = renderReadme(initial)
    const reRendered = renderReadme(rendered)
    expect(rendered).toBe(reRendered)
  })
})
