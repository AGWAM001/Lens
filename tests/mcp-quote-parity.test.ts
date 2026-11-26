import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BazaarMcpServer, type McpHttpServerHandle } from '../src/mcp/server'
import { createLensQuoteQueries } from '../src/mcp/quoteQueries'
import { LENS_QUOTE_TOOL_NAME } from '../src/mcp/quoteTool'
import { registerNetworkSelector } from '../src/middleware/network'

/**
 * #685's done-when is a comparison, not a description: the route, depth and
 * impact a `lens_quote` returns have to *equal* what the three REST routes
 * return for the same pair, size and network.
 *
 * So the pricing legs are stubbed at the module the routes call, and both
 * surfaces are driven against those same stubs: the real Fastify routes and the
 * real MCP tool, fed by `createLensQuoteQueries()`. What is asserted is the body
 * each surface answers with and the arguments each one handed to the shared
 * function — parity of output and of call, not of fixture.
 */

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const TESTNET_PAIR = `USDC:${TESTNET_USDC}/XLM`
const TEST_AUTH_TOKEN = 'lens-mcp-quote-test-token-9c3a7e15b4d2'

/** HTTP handles opened by the transport tests, closed by its `afterEach`. */
const openHandles: McpHttpServerHandle[] = []

// The pair list is settled by `src/config.ts` at import time, so the watched
// pair has to be in the environment before anything reads it. The literals are
// written out here rather than built from the constants below because a
// `vi.hoisted` callback runs before any module-level `const` is initialised.
vi.hoisted(() => {
  process.env.STELLAR_NETWORK = 'testnet'
  process.env.WATCHED_PAIRS_TESTNET =
    'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM'
  process.env.REQUIRE_API_KEY = 'false'
})

const legs = vi.hoisted(() => ({
  getBestRoute: vi.fn(),
  getDepth: vi.fn(),
  getImpact: vi.fn(),
}))

vi.mock('../src/aggregator/bestRoute', () => ({ getBestRoute: legs.getBestRoute }))
vi.mock('../src/pricing/depth', () => ({ getDepth: legs.getDepth, getImpact: legs.getImpact }))
vi.mock('../src/db', () => ({ pgPool: { query: vi.fn() }, prisma: {} }))
vi.mock('../src/redis', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), on: vi.fn(), ping: vi.fn() },
  getCachedPrice: vi.fn().mockResolvedValue(null),
  setCachedPrice: vi.fn(),
}))

// Imported after the mocks above, which vitest hoists regardless.
import { registerRESTRoutes } from '../src/api/rest'

const ROUTE = {
  route: 'AMM',
  sdexPrice: 0.184,
  ammPrice: 0.185,
  estimatedOutput: 46.25,
  slippagePct: 0.54,
  recommendation: 'AMM offers 0.54% better rate',
  network: 'testnet',
}

const DEPTH_OK = {
  status: 'ok',
  network: 'testnet',
  pairKey: TESTNET_PAIR,
  spotPrice: 0.185,
  executionPrice: 0.1843,
  slippagePct: 0.38,
  asks: [
    { price: 0.1851, size: 500 },
    { price: 0.1855, size: 1000 },
  ],
  bids: [{ price: 0.1849, size: 800 }],
  source: 'AMM',
  pool: {
    poolId: 'pool-a',
    feeBp: 30,
    feeReadAt: '2026-11-23T10:00:00.000Z',
    reservesObservedAt: '2026-11-23T09:59:40.000Z',
  },
  excludedPools: [{ poolId: 'pool-b', reason: 'fee could not be read from the venue' }],
}

const DEPTH_UNAVAILABLE = {
  status: 'unavailable',
  network: 'testnet',
  pairKey: TESTNET_PAIR,
  reason: 'no AMM pool snapshots for this pair on this network',
  excludedPools: [],
}

const IMPACT = {
  status: 'ok',
  spotPrice: 0.185,
  availableLiquidity: 25_000,
  smallestSize: 100,
  ladder: [{ size: 100, output: 18.49, executionPrice: 0.1849, slippagePct: 0.05 }],
  thresholds: [{ thresholdPct: 1, crossed: true, size: 11_800 }],
  source: 'AMM',
}

function stubLegs(over: { route?: unknown; depth?: unknown; impact?: unknown } = {}) {
  // `??` would do the wrong thing for `impact: null`, which is exactly the case
  // one test is about: a pair with no AMM leg to measure.
  legs.getBestRoute.mockReset().mockResolvedValue(over.route === undefined ? ROUTE : over.route)
  legs.getDepth.mockReset().mockResolvedValue(over.depth === undefined ? DEPTH_OK : over.depth)
  legs.getImpact.mockReset().mockResolvedValue(over.impact === undefined ? IMPACT : over.impact)
}

async function buildRestApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

function buildToolServer() {
  const server = new BazaarMcpServer({
    fetchWithPayment: vi.fn(),
    quoteQueries: createLensQuoteQueries(),
  })
  let call: ((request: any) => Promise<any>) | null = null
  ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) call = fn
  }
  ;(server as any).setupHandlers()
  // The raw handler response, exactly as an agent receives it: `isError` plus a
  // text block, or structuredContent. Wrapping it in assertions here would hide
  // refusals behind the "did not error" check below.
  const raw = async (arguments_: unknown) =>
    (call as any)({ params: { name: LENS_QUOTE_TOOL_NAME, arguments: arguments_ } })
  return {
    raw,
    quote: async (arguments_: unknown) => {
      const response = await raw(arguments_)
      expect(response.isError, `lens_quote errored: ${response.content?.[0]?.text}`).toBeFalsy()
      return response.structuredContent ?? JSON.parse(response.content[0].text)
    },
  }
}

const restPaths = (assetA: string, assetB: string) => ({
  route: (amount: number, network?: string) =>
    `/price/${assetA}/${assetB}/route?amount=${amount}${network ? `&network=${network}` : ''}`,
  depth: (amount: number, network?: string) =>
    `/price/${assetA}/${assetB}/depth?amount=${amount}${network ? `&network=${network}` : ''}`,
  impact: (network?: string) => `/impact/${assetA}/${assetB}${network ? `?network=${network}` : ''}`,
})

describe('lens_quote is the three REST pricing routes in one call', () => {
  // The first test in the file compiles both surfaces cold — Fastify's schema
  // serializers and the MCP SDK's output validator — so it is given the time a
  // slow machine needs rather than being trimmed to fit a 20s default.
  it('returns the route, depth and impact bodies the routes return', { timeout: 60_000 }, async () => {
    stubLegs()
    const app = await buildRestApp()
    const server = buildToolServer()
    const paths = restPaths('XLM', `USDC:${TESTNET_USDC}`)

    const restRoute = await app.inject({ method: 'GET', url: paths.route(250) })
    const restDepth = await app.inject({ method: 'GET', url: paths.depth(250) })
    const restImpact = await app.inject({ method: 'GET', url: paths.impact() })
    expect([restRoute.statusCode, restDepth.statusCode, restImpact.statusCode]).toEqual([200, 200, 200])

    const quote = await server.quote({ assetA: 'XLM', assetB: `USDC:${TESTNET_USDC}`, amount: 250 })

    // Field for field. `lastUpdated` and the envelope are the tool's own; the
    // three legs are the route bodies, untouched.
    expect(quote.route).toEqual(restRoute.json())
    expect(quote.depth).toEqual(restDepth.json())
    expect(quote.impact).toEqual(restImpact.json())

    await app.close()
  })

  it('asks the shared functions for the same pair, size and network REST does', async () => {
    stubLegs()
    const app = await buildRestApp()
    const server = buildToolServer()
    const paths = restPaths('XLM', `USDC:${TESTNET_USDC}`)

    await app.inject({ method: 'GET', url: paths.route(250) })
    await app.inject({ method: 'GET', url: paths.depth(250) })
    await app.inject({ method: 'GET', url: paths.impact() })
    const restCalls = {
      route: legs.getBestRoute.mock.calls[0].slice(),
      depth: legs.getDepth.mock.calls[0].slice(),
      impact: legs.getImpact.mock.calls[0].slice(),
    }

    legs.getBestRoute.mockClear()
    legs.getDepth.mockClear()
    legs.getImpact.mockClear()
    await server.quote({ assetA: 'XLM', assetB: `USDC:${TESTNET_USDC}`, amount: 250 })

    // Not equal output from equal fixtures: the identical arguments. The pair is
    // resolved the way REST resolves it — to the watched order, with issuers —
    // and the order size reaches all three legs.
    expect(legs.getBestRoute.mock.calls[0]).toEqual(restCalls.route)
    expect(legs.getDepth.mock.calls[0]).toEqual(restCalls.depth)
    expect(legs.getImpact.mock.calls[0]).toEqual(restCalls.impact)

    await app.close()
  })

  it('prices the pair base whichever way round the assets were given', async () => {
    stubLegs()
    const app = await buildRestApp()
    const server = buildToolServer()
    const forward = restPaths(`USDC:${TESTNET_USDC}`, 'XLM')

    const restRoute = await app.inject({ method: 'GET', url: forward.route(250) })
    const restDepth = await app.inject({ method: 'GET', url: forward.depth(250) })
    const restImpact = await app.inject({ method: 'GET', url: forward.impact() })

    const reversed = await server.quote({ assetA: 'XLM', assetB: `USDC:${TESTNET_USDC}`, amount: 250 })
    expect(reversed.direction).toBe('reversed')
    expect(reversed.route).toEqual(restRoute.json())
    expect(reversed.depth).toEqual(restDepth.json())
    expect(reversed.impact).toEqual(restImpact.json())

    const asAsked = await server.quote({ assetA: `USDC:${TESTNET_USDC}`, assetB: 'XLM', amount: 250 })
    expect(asAsked.direction).toBe('as-requested')
    // One pair, one quote: the order the caller typed changes nothing but the
    // label, because `amount` is always a quantity of the pair's base side.
    expect(asAsked.route).toEqual(reversed.route)
    expect(asAsked.depth).toEqual(reversed.depth)
    expect(asAsked.impact).toEqual(reversed.impact)

    await app.close()
  })

  it('scopes a named network to that network on every leg', async () => {
    stubLegs()
    const app = await buildRestApp()
    const server = buildToolServer()
    const mainnetPair = `USDC:${MAINNET_USDC}/XLM`
    const paths = restPaths('XLM', `USDC:${MAINNET_USDC}`)

    await app.inject({ method: 'GET', url: paths.route(50, 'mainnet') })
    await app.inject({ method: 'GET', url: paths.depth(50, 'mainnet') })
    await app.inject({ method: 'GET', url: paths.impact('mainnet') })
    const restNetworks = legs.getBestRoute.mock.calls[0].at(-1)
    expect(restNetworks).toBe('mainnet')

    const quote = await server.quote({
      assetA: 'XLM',
      assetB: `USDC:${MAINNET_USDC}`,
      amount: 50,
      network: 'mainnet',
    })
    expect(quote.network).toBe('mainnet')
    expect(quote.pairKey).toBe(mainnetPair)
    expect(legs.getBestRoute.mock.calls.at(-1)![0]).toEqual({ code: 'USDC', issuer: MAINNET_USDC })
    expect(legs.getBestRoute.mock.calls.at(-1)![4]).toBe('mainnet')
    // getDepth is (network, pairKey, amount) — and the pair key it carries is the
    // mainnet one, so a testnet pool can never price a mainnet order.
    expect(legs.getDepth.mock.calls.at(-1)![0]).toBe('mainnet')
    expect(legs.getDepth.mock.calls.at(-1)![1]).toBe(mainnetPair)
    // getImpact is (pairKey, options, network).
    expect(legs.getImpact.mock.calls.at(-1)![0]).toBe(mainnetPair)
    expect(legs.getImpact.mock.calls.at(-1)![2]).toBe('mainnet')

    await app.close()
  })

  it('carries the unavailable depth arm REST answers with a 503, reason and all', async () => {
    stubLegs({ depth: DEPTH_UNAVAILABLE })
    const app = await buildRestApp()
    const server = buildToolServer()
    const paths = restPaths('XLM', `USDC:${TESTNET_USDC}`)

    const restDepth = await app.inject({ method: 'GET', url: paths.depth(250) })
    // REST says 503: watched pair, no price right now, retry.
    expect(restDepth.statusCode).toBe(503)
    expect(restDepth.json().status).toBe('unavailable')

    const quote = await server.quote({ assetA: 'XLM', assetB: `USDC:${TESTNET_USDC}`, amount: 250 })
    expect(quote.depth).toEqual(restDepth.json())
    // The tool does not answer 503 — it reports the leg and keeps the legs that
    // did price the order.
    expect(quote.route).toEqual(ROUTE)
    expect(quote.unavailable.map((u: { leg: string }) => u.leg)).toEqual(['depth'])
    expect(quote.unavailable[0].reason).toContain(DEPTH_UNAVAILABLE.reason)

    await app.close()
  })

  it('reports a missing impact leg the way REST reports it with a 404', async () => {
    stubLegs({ impact: null })
    const app = await buildRestApp()
    const server = buildToolServer()

    const restImpact = await app.inject({ method: 'GET', url: restPaths('XLM', `USDC:${TESTNET_USDC}`).impact() })
    expect(restImpact.statusCode).toBe(404)
    expect(restImpact.json().code).toBe('unknown_pair')

    const quote = await server.quote({ assetA: 'XLM', assetB: `USDC:${TESTNET_USDC}`, amount: 250 })
    expect(quote.impact).toBe(null)
    expect(quote.unavailable.map((u: { leg: string }) => u.leg)).toEqual(['impact'])

    await app.close()
  })

  it('refuses a pair REST refuses, with the pair list rather than a guess', async () => {
    stubLegs()
    const app = await buildRestApp()
    const server = buildToolServer()

    const restRoute = await app.inject({ method: 'GET', url: restPaths('BTC', 'XLM').route(250) })
    expect(restRoute.statusCode).toBe(404)
    expect(restRoute.json().code).toBe('unwatched_pair')

    const refused = await server.raw({ assetA: 'BTC', assetB: 'XLM', amount: 250 })
    expect(refused.isError).toBe(true)
    const body = JSON.parse(refused.content[0].text)
    expect(body.code).toBe('ERR_PAIR_NOT_WATCHED')
    // The same facts in the reason: the pair the caller asked for, the network it
    // was looked up on, and what is actually watched there.
    expect(body.reason).toContain('BTC')
    expect(body.reason).toContain(TESTNET_PAIR)
    // Nothing was priced for a pair neither surface knows.
    expect(legs.getBestRoute).not.toHaveBeenCalled()
    expect(legs.getDepth).not.toHaveBeenCalled()
    expect(legs.getImpact).not.toHaveBeenCalled()

    await app.close()
  })

  it('refuses a mismatched issuer instead of quoting a same-named asset', async () => {
    stubLegs()
    const app = await buildRestApp()
    const server = buildToolServer()

    // Same code, a different issuer — here Circle's mainnet USDC, whose address is
    // copied in full from src/config.ts rather than invented. On Stellar that is a
    // different asset, and the price of one is not the price of the other.
    const refused = await server.raw({
      assetA: 'XLM',
      assetB: `USDC:${MAINNET_USDC}`,
      amount: 250,
    })
    expect(refused.isError).toBe(true)
    const body = JSON.parse(refused.content[0].text)
    expect(body.code).toBe('ERR_ASSET_ISSUER_MISMATCH')
    // Names the issuer this network actually prices, so the caller can fix the request.
    expect(body.reason).toContain(TESTNET_USDC)
    expect(legs.getBestRoute).not.toHaveBeenCalled()

    const restRoute = await app.inject({
      method: 'GET',
      url: restPaths('XLM', `USDC:${MAINNET_USDC}`).route(250),
    })
    // REST refuses the same request with its own 404. The tool refuses it more
    // precisely — a code that matches is not a pair that matches — but neither
    // one quotes a same-named asset.
    expect(restRoute.statusCode).toBe(404)
    expect(restRoute.json().code).toBe('unwatched_pair')

    await app.close()
  })
})

// ── Both transports ───────────────────────────────────────────────────────────

async function connectStdioClient() {
  const server = new BazaarMcpServer({
    fetchWithPayment: vi.fn(),
    quoteQueries: createLensQuoteQueries(),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await (server as any).server.connect(serverTransport)
  const client = new Client({ name: 'lens-quote-test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  return { client, server }
}

async function connectHttpClient() {
  const server = new BazaarMcpServer({
    fetchWithPayment: vi.fn(),
    quoteQueries: createLensQuoteQueries(),
  })
  const handle = await server.runHttp({
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
    authToken: TEST_AUTH_TOKEN,
  })
  openHandles.push(handle)
  const address = handle.server.address() as AddressInfo
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}` } } }
  )
  const client = new Client({ name: 'lens-quote-http-test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

describe('lens_quote over both transports', () => {
  afterEach(async () => {
    while (openHandles.length) await openHandles.pop()!.close()
  })

  it('is advertised and answered identically over stdio and Streamable HTTP', async () => {
    stubLegs()
    const args = { assetA: 'XLM', assetB: `USDC:${TESTNET_USDC}`, amount: 250 }

    const { client: stdioClient, server: stdioServer } = await connectStdioClient()
    const stdioTools = await stdioClient.listTools()
    const stdioQuote = await stdioClient.callTool({ name: LENS_QUOTE_TOOL_NAME, arguments: args })
    await stdioClient.close()
    await (stdioServer as any).server.close()

    const httpClient = await connectHttpClient()
    const httpTools = await httpClient.listTools()
    const httpQuote = await httpClient.callTool({ name: LENS_QUOTE_TOOL_NAME, arguments: args })
    await httpClient.close()

    // The same declaration, so the same contract, whichever transport connected.
    expect(httpTools).toEqual(stdioTools)
    const declared = stdioTools.tools.find(t => t.name === LENS_QUOTE_TOOL_NAME)
    expect(declared).toBeDefined()
    expect(declared!.outputSchema).toBeDefined()

    expect(stdioQuote.isError).toBeFalsy()
    // `lastUpdated` is stamped when each quote is built, so the two calls cannot
    // be byte-identical; everything else must be.
    const { lastUpdated: stdioAt, ...stdioBody } = stdioQuote.structuredContent as any
    const { lastUpdated: httpAt, ...httpBody } = httpQuote.structuredContent as any
    expect(httpBody).toEqual(stdioBody)
    expect(stdioAt).toMatch(/T.*Z$/)
    expect(httpAt).toMatch(/T.*Z$/)
    expect(httpBody.route).toEqual(ROUTE)
    expect(httpBody.amount).toBe(250)
    // A client that only renders text reads the same numbers.
    expect(JSON.parse((httpQuote.content as any)[0].text).pairKey).toBe(TESTNET_PAIR)
  })

  it('refuses an unauthenticated HTTP caller before any pricing read runs', async () => {
    stubLegs()
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      quoteQueries: createLensQuoteQueries(),
    })
    const handle = await server.runHttp({
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      authToken: TEST_AUTH_TOKEN,
    })
    openHandles.push(handle)
    const address = handle.server.address() as AddressInfo

    const res = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: LENS_QUOTE_TOOL_NAME, arguments: { assetA: 'XLM', assetB: 'USDC', amount: 250 } },
      }),
    })
    expect(res.status).toBe(401)
    // The token gate ran before the tool, so the data layer was never asked.
    expect(legs.getBestRoute).not.toHaveBeenCalled()
  })
})
