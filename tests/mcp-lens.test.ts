import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { BazaarMcpServer } from '../src/mcp/server'
import { createLensDataQueries } from '../src/mcp/lensDataQueries'
import type { McpLimits } from '../src/mcp/limits'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { registerNetworkSelector } from '../src/middleware/network'
import { registerPairsRoutes } from '../src/routes/pairs'
import { registerPoolsRoutes } from '../src/routes/pools'
import { registerScreenerRoutes } from '../src/routes/screener'
import { MARKET_CAP_UNSUPPORTED } from '../src/services/screener'
import { activeNetwork, config, getNetworkConfig } from '../src/config'

// The lens tools share their implementations with the REST routes, so one
// mocked database and one mocked pairs registry answer both surfaces.
const { mockQuery, mockGetActivePairs } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetActivePairs: vi.fn(),
}))

vi.mock('../src/db', () => ({
  pgPool: { query: mockQuery },
  prisma: {},
}))

vi.mock('../src/pairsRegistry', () => ({
  getActivePairs: mockGetActivePairs,
  hasPair: vi.fn().mockReturnValue(false),
  registerPair: vi.fn(),
  persistPair: vi.fn(),
  parseAssetStr: vi.fn(),
  makePairKey: vi.fn(),
}))

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const XLM = { code: 'XLM', issuer: null }
const USDC = { code: 'USDC', issuer: USDC_ISSUER }
const OLD = new Date('2026-10-16T12:00:00.000Z')

const WATCHED = [
  { pairKey: `USDC:${USDC_ISSUER}/XLM`, assetA: XLM, assetB: USDC },
]

function makePairs(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const code = `A${String(i).padStart(3, '0')}`
    const issuer = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    return { pairKey: `${code}:${issuer}/XLM`, assetA: XLM, assetB: { code, issuer } }
  })
}

// ── Harnesses ─────────────────────────────────────────────────────────────────

/**
 * `withData: false` builds the server as a host without Lens's own data would:
 * the three tools must not be advertised at all. `limits` overrides the operator
 * bounds so a test of the page ceiling is not confounded by the byte ceiling.
 */
function buildServer(withData = true, limits?: Partial<McpLimits>) {
  const server = new BazaarMcpServer({
    fetchWithPayment: vi.fn(),
    ...(withData ? { dataQueries: createLensDataQueries() } : {}),
    ...(limits ? { limits } : {}),
  })
  const handlers: Record<string, any> = {}
  ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) handlers.call = fn
    if (schema === ListToolsRequestSchema) handlers.list = fn
  }
  ;(server as any).setupHandlers()
  return {
    listTools: async () => (await handlers.list()).tools,
    callTool: async (name: string, args?: Record<string, unknown>) =>
      handlers.call({ params: { name, arguments: args } }),
  }
}

async function callToolJson(server: ReturnType<typeof buildServer>, name: string, args?: Record<string, unknown>) {
  const response = await server.callTool(name, args)
  expect(response.isError, `tool ${name} errored: ${response.content[0].text}`).toBeFalsy()
  return response.structuredContent ?? JSON.parse(response.content[0].text)
}

async function buildRestApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerPairsRoutes(app)
  await registerPoolsRoutes(app)
  await registerScreenerRoutes(app)
  await app.ready()
  return app
}

// Answers the pairs price probe with one print per queried pair key.
function mockLatestPrices() {
  mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
    const keys = (params as string[][])?.[1] ?? []
    return {
      rows: keys.map(pair_key => ({ pair_key, price: '0.42', timestamp: OLD, source_time: OLD })),
    }
  })
}

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] })
  mockGetActivePairs.mockReset().mockReturnValue([])
})

// ── Tool surface ──────────────────────────────────────────────────────────────

describe('lens MCP tools', () => {
  it('lists the three lens tools next to the bazaar tools', async () => {
    const server = buildServer()
    const tools = await server.listTools()
    const names = tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['bazaar_search', 'paid_call']))
    expect(names).toEqual(
      expect.arrayContaining(['lens_list_pairs', 'lens_get_pools', 'lens_screen_pairs'])
    )
  })

  it('does not advertise a tool it cannot answer with', async () => {
    const server = buildServer(false)
    const names = (await server.listTools()).map((t: { name: string }) => t.name)
    expect(names).not.toContain('lens_list_pairs')
    expect(names).not.toContain('lens_get_pools')
    expect(names).not.toContain('lens_screen_pairs')

    // Calling one anyway refuses with the reason, rather than returning an empty
    // page an agent would read as "nothing is watched here".
    const response = await server.callTool('lens_list_pairs', {})
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_INTERNAL_FAILURE')
    expect(payload.reason).toMatch(/no Lens data source/)
  })

  it('describes each tool distinctly and documents the pagination', async () => {
    const server = buildServer()
    const tools = (await server.listTools()) as { name: string; description: string; inputSchema: any }[]
    const byName = Object.fromEntries(tools.map(t => [t.name, t]))

    expect(byName.lens_list_pairs.description).toMatch(/discover/i)
    expect(byName.lens_list_pairs.description).toMatch(/lens_screen_pairs/)
    expect(byName.lens_list_pairs.description).toMatch(/nextCursor/)

    expect(byName.lens_get_pools.description).toMatch(/liquidity/i)
    expect(byName.lens_get_pools.description).toMatch(/lens_list_pairs/)
    expect(byName.lens_get_pools.description).toMatch(/nextCursor/)

    expect(byName.lens_screen_pairs.description).toMatch(/rank/i)
    expect(byName.lens_screen_pairs.description).toMatch(/lens_get_pools/)
    expect(byName.lens_screen_pairs.description).toMatch(/nextCursor/)

    for (const name of ['lens_list_pairs', 'lens_get_pools', 'lens_screen_pairs']) {
      // An issuer is part of an asset's identity on Stellar, so each description
      // has to say the answer carries it in full.
      expect(byName[name].description).toMatch(/issuer/)
      expect(byName[name].inputSchema.properties.cursor).toBeTruthy()
      expect(byName[name].inputSchema.properties.limit).toBeTruthy()
      expect(byName[name].inputSchema.additionalProperties).toBe(false)
    }
  })
})

// ── lens_list_pairs ───────────────────────────────────────────────────────────

describe('lens_list_pairs vs GET /pairs', () => {
  it('returns the same pairs page by page, issuers in full', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(3))
    mockLatestPrices()
    const server = buildServer()
    const app = await buildRestApp()

    // The route's page and the tool's page for the same arguments: same rows, the
    // same keyset cursor, the same verdict on whether another page exists. The
    // tool adds only the page size it honoured and the network it read.
    const rest1 = (await app.inject({ method: 'GET', url: '/pairs?limit=2' })).json()
    const page1 = await callToolJson(server, 'lens_list_pairs', { limit: 2 })
    expect(page1).toEqual({ network: activeNetwork, limit: 2, ...rest1 })

    // Not just equal output: the identical SQL, because the tool runs the
    // route's own listing.
    const restSql = mockQuery.mock.calls[0][0]
    expect(mockQuery.mock.calls.at(-1)![0]).toBe(restSql)

    const rest2 = (
      await app.inject({ method: 'GET', url: `/pairs?limit=2&cursor=${encodeURIComponent(rest1.nextCursor)}` })
    ).json()
    const page2 = await callToolJson(server, 'lens_list_pairs', { limit: 2, cursor: page1.nextCursor })
    expect(page2).toEqual({ network: activeNetwork, limit: 2, ...rest2 })
    expect(page2.hasMore).toBe(false)
    expect(page2.nextCursor).toBe(null)

    // Issuers are complete strkeys, never shortened.
    expect(page1.pairs[0].assetB.issuer).toMatch(/^G[A-Z2-7]{55}$/)
    expect(page1.pairs[0].assetB.issuer).toHaveLength(56)
    // And the freshness metadata REST carries travels too: an agent deciding
    // whether a price is worth acting on needs the age, not just the number.
    expect(page1.pairs[0].lastUpdated).toBe(OLD.toISOString())
    expect(page1.pairs[0].sourceTime).toBe(OLD.toISOString())
    await app.close()
  })

  it('bounds the page by default and clamps an oversized limit', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(260))
    mockLatestPrices()
    // Roomy byte budget: this test is about the page ceiling, and a 200-pair
    // page would otherwise be truncated by the output-size one.
    const server = buildServer(true, { maxResultBytes: 4 * 1024 * 1024 })

    const page = await callToolJson(server, 'lens_list_pairs', {})
    expect(page.pairs).toHaveLength(config.mcp.defaultPageLimit)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBeTruthy()

    // An ask over the ceiling is clamped rather than refused, and the result says
    // what size was actually honoured.
    const capped = await callToolJson(server, 'lens_list_pairs', { limit: 500 })
    expect(capped.limit).toBe(config.mcp.maxPageLimit)
    expect(capped.pairs).toHaveLength(config.mcp.maxPageLimit)
  })

  it('labels a page too large for the output budget instead of shipping it whole', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(260))
    mockLatestPrices()
    const server = buildServer()

    // maxPageLimit pairs of full strkeys is far past maxResultBytes, so what the
    // agent gets is a labelled fragment — and the cursor that would have skipped
    // the rows between the fragment and the fetched page is gone.
    const raw = await server.callTool('lens_list_pairs', { limit: config.mcp.maxPageLimit })
    expect(raw.structuredContent).toBeUndefined()
    const body = JSON.parse(raw.content[0].text)
    expect(body.truncated).toBe(true)
    expect(body.nextCursor).toBe(null)
    expect(body.pairs.length).toBeLessThan(config.mcp.maxPageLimit)
    expect(body.pairs.length).toBeGreaterThan(0)
    expect(body.notice).toMatch(/smaller limit/)
    // Every row the agent does receive still carries a full issuer.
    expect(body.pairs[0].assetB.issuer).toHaveLength(56)
  })

  it('scopes a named network to that network and to that network\'s pairs', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(1))
    mockLatestPrices()
    const server = buildServer()
    const app = await buildRestApp()

    await app.inject({ method: 'GET', url: '/pairs?network=mainnet' })
    expect(mockQuery.mock.calls[0][1][0]).toBe('mainnet')

    const mainnet = await callToolJson(server, 'lens_list_pairs', { network: 'mainnet' })
    expect(mockQuery.mock.calls.at(-1)![1][0]).toBe('mainnet')

    // The registry belongs to whichever network this process serves, so asking
    // for the other one gets that network's declared pairs — a testnet listing
    // must never be read as a mainnet one.
    const keys = mainnet.pairs.map((p: { pairKey: string }) => p.pairKey)
    expect(keys).toEqual(getNetworkConfig('mainnet').pairs.map(p => p.pairKey))
    expect(keys).not.toContain(makePairs(1)[0].pairKey)
    await app.close()
  })
})

// ── lens_get_pools ────────────────────────────────────────────────────────────

describe('lens_get_pools vs GET /pools', () => {
  // `numeric` columns arrive from the driver as strings, which is what lets
  // `?decimalFormat=string` return the stored value exactly.
  const POOLS = [
    { pool_id: 'pool-a', asset_a: 'XLM', asset_b: 'USDC', reserve_a: '10.5', reserve_b: '20', spot_price: '2', fee_bp: 30, timestamp: OLD },
    { pool_id: 'pool-b', asset_a: 'XLM', asset_b: 'USDC', reserve_a: '11', reserve_b: '21', spot_price: '2', fee_bp: 30, timestamp: OLD },
    { pool_id: 'pool-c', asset_a: 'XLM', asset_b: 'USDC', reserve_a: '12', reserve_b: '22', spot_price: '2', fee_bp: 30, timestamp: OLD },
  ]

  it('returns the same pools as the route, each asset with its full issuer', async () => {
    mockGetActivePairs.mockReturnValue(WATCHED)
    // The DB answers the keyset pages: everything for the REST route and page 1,
    // then only what follows pool-b for page 2.
    mockQuery
      .mockResolvedValueOnce({ rows: POOLS })
      .mockResolvedValueOnce({ rows: POOLS })
      .mockResolvedValueOnce({ rows: POOLS.slice(2) })
    const server = buildServer()
    const app = await buildRestApp()

    const rest = (await app.inject({ method: 'GET', url: '/pools' })).json()
    expect(rest.pools).toHaveLength(3)
    expect(rest.pools[0].reserve_a).toBe(10.5)

    const page1 = await callToolJson(server, 'lens_get_pools', { limit: 2 })
    expect(page1.pools).toHaveLength(2)
    // Every REST field is present and equal, plus the resolved full asset ids.
    expect(page1.pools[0]).toEqual({
      ...rest.pools[0],
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: USDC_ISSUER },
    })
    expect(page1.hasMore).toBe(true)
    expect(typeof page1.nextCursor).toBe('string')

    // The cursor is a keyset on pool_id: the next page starts after pool-b.
    const page2 = await callToolJson(server, 'lens_get_pools', { limit: 2, cursor: page1.nextCursor })
    const [sql, params] = mockQuery.mock.calls.at(-1)!
    expect(sql).toMatch(/pool_id > \$2/)
    expect(params).toEqual([activeNetwork, 'pool-b', 3])
    expect(page2.pools).toHaveLength(1)
    expect(page2.pools[0].pool_id).toBe('pool-c')
    expect(page2.hasMore).toBe(false)
    await app.close()
  })

  it('falls back to a null issuer for a pool whose pair is no longer watched', async () => {
    mockGetActivePairs.mockReturnValue(WATCHED)
    mockQuery.mockResolvedValue({
      rows: [{ pool_id: 'pool-x', asset_a: 'FOO', asset_b: 'BAR', reserve_a: '1', reserve_b: '2', spot_price: '2', fee_bp: 30, timestamp: OLD }],
    })
    const server = buildServer()

    // A pool whose codes match no watched pair keeps null issuers rather than
    // borrowing the only one on hand: a wrong issuer is a different asset.
    const page = await callToolJson(server, 'lens_get_pools', {})
    expect(page.pools[0].assetA).toEqual({ code: 'FOO', issuer: null })
    expect(page.pools[0].assetB).toEqual({ code: 'BAR', issuer: null })
  })

  it('clamps an oversized pool page to the server ceiling', async () => {
    mockGetActivePairs.mockReturnValue(WATCHED)
    mockQuery.mockResolvedValue({ rows: POOLS })
    const server = buildServer()

    const capped = await callToolJson(server, 'lens_get_pools', { limit: 500 })
    // limit 500 is clamped to the ceiling, so the query asks for one more than that.
    expect(capped.limit).toBe(config.mcp.maxPageLimit)
    expect(mockQuery.mock.calls.at(-1)![1].at(-1)).toBe(config.mcp.maxPageLimit + 1)
  })
})

// ── lens_screen_pairs ─────────────────────────────────────────────────────────

describe('lens_screen_pairs vs GET /screener', () => {
  const ROWS = [
    { pair_key: `USDC:${USDC_ISSUER}/XLM`, volume: 30, price: 0.12, change_24h: 1.5, liquidity: 50000 },
    { pair_key: 'A000:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/XLM', volume: 20, price: 0.5, change_24h: -2, liquidity: 40000 },
    { pair_key: 'B001:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/XLM', volume: 10, price: 0.8, change_24h: 0, liquidity: 30000 },
  ]

  it('returns exactly the route body for the same filters, sort and page', async () => {
    mockQuery.mockResolvedValue({ rows: ROWS })
    const server = buildServer()
    const app = await buildRestApp()

    const rest = await app.inject({
      method: 'GET',
      url: '/screener?volume=10&sortBy=liquidity&order=asc&limit=2',
    })
    expect(rest.statusCode).toBe(200)
    const restBody = rest.json()

    const toolBody = await callToolJson(server, 'lens_screen_pairs', {
      volume: 10,
      sortBy: 'liquidity',
      order: 'asc',
      limit: 2,
    })
    // The route renders the service page as-is; the tool adds the page size it
    // actually ran, because a clamped ask is not something an agent should have
    // to infer from a short page. Everything else is byte-identical.
    expect(toolBody).toEqual({ ...restBody, limit: 2 })

    // Not just equal output: the identical SQL and bound parameters, because the
    // tool runs the same service the route and GraphQL do.
    expect(mockQuery.mock.calls[1]).toEqual(mockQuery.mock.calls[0])

    // pair_key carries the full issuer, never a shortened one.
    expect(toolBody.data[0].pair_key).toContain(USDC_ISSUER)
    await app.close()
  })

  it('pages with the same cursor as the route', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: ROWS })
      .mockResolvedValueOnce({ rows: ROWS.slice(2) })
    const server = buildServer()

    const page1 = await callToolJson(server, 'lens_screen_pairs', { limit: 2 })
    expect(page1.hasMore).toBe(true)
    expect(page1.data).toHaveLength(2)

    const page2 = await callToolJson(server, 'lens_screen_pairs', { limit: 2, cursor: page1.nextCursor })
    expect(page2.data).toHaveLength(1)
    expect(page2.hasMore).toBe(false)
    expect(page2.nextCursor).toBe(null)
  })

  it('refuses market_cap with the message REST uses', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_screen_pairs', { market_cap: '1000' })
    expect(response.isError).toBe(true)
    expect(JSON.parse(response.content[0].text).reason).toBe(MARKET_CAP_UNSUPPORTED)
  })
})

// ── Error mapping ─────────────────────────────────────────────────────────────

describe('lens tool errors', () => {
  it('rejects an unknown network with ERR_BAD_REQUEST', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_list_pairs', { network: 'devnet' })
    expect(response.isError).toBe(true)
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_BAD_REQUEST')
  })

  it('rejects an argument it does not take rather than ignoring it', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_list_pairs', { limitd: 5 })
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_BAD_REQUEST')
    expect(payload.reason).toMatch(/limitd/)
  })

  it('rejects a malformed cursor with ERR_BAD_REQUEST', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(1))
    mockLatestPrices()
    const server = buildServer()

    for (const name of ['lens_list_pairs', 'lens_get_pools', 'lens_screen_pairs']) {
      const response = await server.callTool(name, { cursor: 'not-base64-json' })
      expect(response.isError, `${name} accepted a malformed cursor`).toBe(true)
      expect(JSON.parse(response.content[0].text).code).toBe('ERR_BAD_REQUEST')
    }
  })

  it('rejects a non-numeric filter with the screener validation message', async () => {
    const server = buildServer()
    const response = await server.callTool('lens_screen_pairs', { volume: 'lots' })
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_BAD_REQUEST')
    expect(payload.reason).toMatch(/volume must be a valid number/)
  })

  it('maps a database failure to ERR_SERVICE_UNREACHABLE without leaking it', async () => {
    mockGetActivePairs.mockReturnValue(makePairs(1))
    mockQuery.mockRejectedValue(new Error('connection refused postgres://user:secret@host'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = buildServer()

    const response = await server.callTool('lens_list_pairs', {})
    expect(response.isError).toBe(true)
    const payload = JSON.parse(response.content[0].text)
    expect(payload.code).toBe('ERR_SERVICE_UNREACHABLE')
    // A tool reply lands in an agent's transcript, so the driver error — which
    // carries the connection string — belongs in the log and nowhere else.
    expect(response.content[0].text).not.toMatch(/secret/)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
