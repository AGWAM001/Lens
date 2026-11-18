import { describe, it, expect, vi } from 'vitest'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { BazaarMcpServer } from '../src/mcp/server'
import type { AggregatedPriceFields, LensPriceQueries } from '../src/mcp/priceTool'
import type { NetworkName } from '../src/config'
import type { RouteInfo, WatchedPair } from '../src/types'

/**
 * #408 — an agent connected over MCP could reach other people's Bazaar nodes but
 * not Lens's own prices. These tests pin the other half of that: the tool answers
 * about the asset that was actually asked about (issuer included), refuses a
 * same-named asset instead of pricing it, defaults to the server's network but
 * takes another one when named, and reports the age of what it returned.
 */

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

/** Every tool result here is one JSON text block; the SDK types content loosely. */
const jsonOf = (result: unknown) =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const testnetPair = (): WatchedPair => ({
  assetA: { code: 'USDC', issuer: TESTNET_USDC },
  assetB: { code: 'XLM', issuer: null },
  pairKey: `USDC:${TESTNET_USDC}/XLM`,
})

const mainnetPair = (): WatchedPair => ({
  assetA: { code: 'USDC', issuer: MAINNET_USDC },
  assetB: { code: 'XLM', issuer: null },
  pairKey: `USDC:${MAINNET_USDC}/XLM`,
})

const aggregated = (over: Partial<AggregatedPriceFields> = {}): AggregatedPriceFields => ({
  price: 0.185,
  sdexPrice: 0.184,
  ammPrice: 0.186,
  volume24h: 1200,
  sdexVolume24h: 900,
  ammVolume24h: 300,
  vwap1m: 0.1851,
  vwap5m: 0.1852,
  vwap1h: 0.185,
  vwap24h: 0.184,
  priceChange24h: -1.2,
  sources: 3,
  confidence: 'high',
  lastTradeAgeSeconds: 12,
  stale: false,
  ...over,
})

const route = (): RouteInfo => ({
  route: 'SDEX',
  sdexPrice: 0.184,
  ammPrice: 0.186,
  estimatedOutput: 184,
  slippagePct: 0,
  recommendation: 'AMM offers 1.09% better rate',
})

interface HarnessOptions {
  pairs?: Partial<Record<NetworkName, readonly WatchedPair[]>>
  activeNetwork?: NetworkName
  agg?: AggregatedPriceFields | Error
  route?: RouteInfo | Error
}

function buildHarness(options: HarnessOptions = {}) {
  const pairs: Record<NetworkName, readonly WatchedPair[]> = {
    testnet: [testnetPair()],
    mainnet: [mainnetPair()],
    ...options.pairs,
  }

  const settle = <T,>(value: T | Error | undefined, fallback: T): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? fallback)

  const watchedPairs = vi.fn((network: NetworkName) => pairs[network] ?? [])
  const aggregatedPrice = vi.fn(() => settle(options.agg, aggregated()))
  const bestRoute = vi.fn(() => settle(options.route, route()))

  const priceQueries: LensPriceQueries = {
    activeNetwork: options.activeNetwork ?? 'testnet',
    watchedPairs,
    aggregatedPrice,
    bestRoute,
  }

  const server = new BazaarMcpServer({
    fetchWithPayment: vi.fn(),
    priceQueries,
  })

  const handlers: Record<string, any> = {}
  ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) handlers.call = fn
    if (schema === ListToolsRequestSchema) handlers.list = fn
  }
  ;(server as any).setupHandlers()

  const call = async (arguments_: unknown) => {
    const response = await handlers.call({ params: { name: 'lens_get_price', arguments: arguments_ } })
    return {
      response,
      body: JSON.parse(response.content[0].text),
      structured: response.structuredContent,
    }
  }

  return {
    call,
    listTools: () => handlers.list(),
    watchedPairs,
    aggregatedPrice,
    bestRoute,
    priceQueries,
  }
}

/** The same tool over a server that was never given a price source. */
function buildServerWithoutPrices() {
  const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() })
  const handlers: Record<string, any> = {}
  ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) handlers.call = fn
    if (schema === ListToolsRequestSchema) handlers.list = fn
  }
  ;(server as any).setupHandlers()
  return {
    listTools: () => handlers.list(),
    call: async (arguments_: unknown) =>
      handlers.call({ params: { name: 'lens_get_price', arguments: arguments_ } }),
  }
}

describe('lens_get_price', () => {
  it('returns the aggregated price of a known pair as structured content', async () => {
    const h = buildHarness()
    const { response, structured } = await h.call({
      assetA: 'XLM',
      assetB: `USDC:${MAINNET_USDC}`,
      network: 'mainnet',
    })

    expect(response.isError).toBeFalsy()
    expect(structured.price).toBe(0.185)
    expect(structured.network).toBe('mainnet')
    expect(structured.pairKey).toBe(`USDC:${MAINNET_USDC}/XLM`)
    expect(structured.sources).toBe(3)
    expect(structured.confidence).toBe('high')
    expect(structured.bestRoute.route).toBe('SDEX')
    // The pair is watched USDC/XLM and asked XLM/USDC: the answer says which way
    // round it is stated, so the number cannot be read as its own reciprocal.
    expect(structured.direction).toBe('reversed')
    expect(structured.orientation).toBe('quote-per-base')
    expect(structured.base).toEqual({ code: 'USDC', issuer: MAINNET_USDC })
    expect(structured.quote).toEqual({ code: 'XLM', issuer: null })
  })

  it('queries the resolved pair, not the string the caller typed', async () => {
    const h = buildHarness()
    await h.call({ assetA: 'native', assetB: 'USDC' })

    expect(h.watchedPairs).toHaveBeenCalledWith('testnet')
    expect(h.aggregatedPrice).toHaveBeenCalledWith(`USDC:${TESTNET_USDC}/XLM`, 'testnet')
    expect(h.bestRoute).toHaveBeenCalledWith(
      { code: 'USDC', issuer: TESTNET_USDC },
      { code: 'XLM', issuer: null },
      `USDC:${TESTNET_USDC}/XLM`,
      'testnet',
    )
  })

  it('names the issuer it priced when the caller passes a bare code', async () => {
    const { structured } = await buildHarness().call({ assetA: 'native', assetB: 'USDC' })

    // Bare codes still resolve — XLM has no issuer and single-issuer assets are
    // quoted by code — but the answer must say which USDC it is about.
    expect(structured.base).toEqual({ code: 'USDC', issuer: TESTNET_USDC })
  })

  it('does not answer a mainnet USDC request from the testnet pair', async () => {
    const h = buildHarness()
    const { response, body } = await h.call({
      assetA: 'native',
      assetB: `USDC:${MAINNET_USDC}`,
      network: 'testnet',
    })

    expect(response.isError).toBe(true)
    expect(body.code).toBe('ERR_ASSET_ISSUER_MISMATCH')
    // The refusal is actionable: it names the issuer this network does price,
    // so the agent can correct the request instead of guessing.
    expect(body.reason).toContain(TESTNET_USDC)
    expect(h.aggregatedPrice).not.toHaveBeenCalled()
  })

  it('prices the same code correctly when the network that watches it is named', async () => {
    const h = buildHarness()
    const { response, structured } = await h.call({
      assetA: 'native',
      assetB: `USDC:${MAINNET_USDC}`,
      network: 'mainnet',
    })

    expect(response.isError).toBeFalsy()
    expect(structured.pairKey).toBe(`USDC:${MAINNET_USDC}/XLM`)
  })

  it('refuses a pair nothing watches, and says what is watched instead', async () => {
    const h = buildHarness()
    const { response, body } = await h.call({ assetA: 'XLM', assetB: 'ABCD' })

    expect(response.isError).toBe(true)
    expect(body.code).toBe('ERR_PAIR_NOT_WATCHED')
    expect(body.reason).toContain(`USDC:${TESTNET_USDC}/XLM`)
    expect(h.aggregatedPrice).not.toHaveBeenCalled()
  })

  it('defaults to the network the server runs and takes another when named', async () => {
    const h = buildHarness({ activeNetwork: 'mainnet' })

    const defaulted = await h.call({ assetA: 'native', assetB: 'USDC' })
    expect(defaulted.structured.network).toBe('mainnet')

    const named = await h.call({ assetA: 'native', assetB: 'USDC', network: 'testnet' })
    expect(named.structured.network).toBe('testnet')
    expect(named.structured.pairKey).toBe(`USDC:${TESTNET_USDC}/XLM`)
  })

  it('refuses a network that does not exist before reading anything', async () => {
    const h = buildHarness()
    for (const network of ['public', 'pubnet', 'Mainnet', '', 3]) {
      const { response, body } = await h.call({ assetA: 'native', assetB: 'USDC', network })

      expect(response.isError).toBe(true)
      expect(body.code).toBe('ERR_BAD_REQUEST')
      expect(body.reason).toMatch(/testnet or mainnet/)
    }
    expect(h.watchedPairs).not.toHaveBeenCalled()
  })

  it('reports staleness rather than presenting an old price as current', async () => {
    const h = buildHarness({
      agg: aggregated({ lastTradeAgeSeconds: 4200, stale: true, confidence: 'low', price: 0.17 }),
    })
    const { response, structured } = await h.call({ assetA: 'native', assetB: 'USDC' })

    expect(response.isError).toBeFalsy()
    expect(structured.lastTradeAgeSeconds).toBe(4200)
    expect(structured.stale).toBe(true)
    expect(structured.confidence).toBe('low')
  })

  it('refuses to quote a pair with no ingested trade, or a price of zero', async () => {
    for (const agg of [
      aggregated({ lastTradeAgeSeconds: null, confidence: 'unknown', sources: 0 }),
      aggregated({ price: 0 }),
    ]) {
      const h = buildHarness({ agg })
      const { response, body } = await h.call({ assetA: 'native', assetB: 'USDC' })

      expect(response.isError).toBe(true)
      expect(body.code).toBe('ERR_NO_RESULTS')
      // A 0 is not a price; it is the absence of one, and an agent that trades on
      // it loses money.
      expect(body.reason).toMatch(/no aggregated price/)
    }
  })

  it('still returns the price when only the route leg fails', async () => {
    const h = buildHarness({ route: new Error('No pricing data available') })
    const { response, structured } = await h.call({ assetA: 'native', assetB: 'USDC' })

    expect(response.isError).toBeFalsy()
    expect(structured.price).toBe(0.185)
    expect(structured.bestRoute).toBeNull()
  })

  it('reports an unreachable data source as a service failure, not a price', async () => {
    const h = buildHarness({ agg: new Error('connection refused') })
    const { response, body } = await h.call({ assetA: 'native', assetB: 'USDC' })

    expect(response.isError).toBe(true)
    expect(body.code).toBe('ERR_SERVICE_UNREACHABLE')
  })

  describe('rejects an asset it cannot identify', () => {
    const badAssets = [
      ['usdc', /case-sensitive/],
      [`USDC:${TESTNET_USDC.slice(0, 20)}`, /issuer that is not a Stellar account id/],
      ['USDC:', /issuer that is not a Stellar account id/],
      ['', /non-empty string/],
      ['TOO.LONG-CODE', /not an asset reference/],
      ['1USDC', /not an asset reference/],
      [42, /non-empty string/],
    ] as const

    for (const [assetA, pattern] of badAssets) {
      it(`refuses ${JSON.stringify(assetA)} without asking the database`, async () => {
        const h = buildHarness()
        const { response, body } = await h.call({ assetA, assetB: 'XLM' })

        expect(response.isError).toBe(true)
        expect(body.code).toBe('ERR_INVALID_ASSET')
        expect(body.reason).toMatch(pattern)
        expect(h.watchedPairs).not.toHaveBeenCalled()
      })
    }

    it('requires both sides of the pair', async () => {
      const h = buildHarness()
      const { body } = await h.call({ assetA: 'native' })

      expect(body.code).toBe('ERR_INVALID_ASSET')
      expect(body.reason).toContain('assetB')
    })

    it('prices a native request written either way', async () => {
      for (const native of ['native', 'Native', 'XLM']) {
        const { structured } = await buildHarness().call({ assetA: native, assetB: 'USDC' })
        expect(structured.quote).toEqual({ code: 'XLM', issuer: null })
      }
    })
  })

  describe('argument strictness', () => {
    it('refuses an argument the tool does not accept', async () => {
      const h = buildHarness()
      const { response, body } = await h.call({
        assetA: 'native',
        assetB: 'USDC',
        issuer: MAINNET_USDC,
        network: 'mainnet',
      })

      expect(response.isError).toBe(true)
      expect(body.code).toBe('ERR_BAD_REQUEST')
      expect(body.reason).toContain('issuer')
      expect(h.aggregatedPrice).not.toHaveBeenCalled()
    })

    it('refuses arguments that are not an object', async () => {
      for (const args of [undefined, null, 'native/USDC', ['native', 'USDC']]) {
        const { body } = await buildHarness().call(args)
        expect(body.code).toBe('ERR_BAD_REQUEST')
      }
    })
  })

  describe('tool surface', () => {
    it('accepts exactly the pair and the network', async () => {
      const tools = (await buildHarness().listTools()).tools
      const price = tools.find((t: any) => t.name === 'lens_get_price')

      expect(Object.keys(price.inputSchema.properties).sort()).toEqual(['assetA', 'assetB', 'network'])
      expect(price.inputSchema.required).toEqual(['assetA', 'assetB'])
      expect(price.inputSchema.additionalProperties).toBe(false)
      expect(price.inputSchema.properties.network.enum).toEqual(['testnet', 'mainnet'])
      expect(price.outputSchema.required).toEqual(expect.arrayContaining(['price', 'confidence', 'stale']))
      expect(price.description).toMatch(/issuer/i)
      expect(price.description).toMatch(/stale/i)
    })

    it('is not advertised, and says so if called anyway, when no price source is configured', async () => {
      const server = buildServerWithoutPrices()

      const tools = (await server.listTools()).tools
      expect(tools.map((t: any) => t.name)).not.toContain('lens_get_price')

      const response = await server.call({ assetA: 'native', assetB: 'USDC' })
      expect(response.isError).toBe(true)
      expect(JSON.parse(response.content[0].text).code).toBe('ERR_INTERNAL_FAILURE')
    })
  })
})

/**
 * The handler-level tests above drive the server the way its own code does. This
 * one drives it the way an agent does — a real MCP client over a linked
 * transport — because the point of #408 is that a connected agent could not get
 * a price at all. It catches a declaration the SDK will not accept, or a result
 * shape a client will not parse, which neither of the other layers can see.
 */
describe('lens_get_price through an MCP client', () => {
  async function connect(queries: LensPriceQueries) {
    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn(), priceQueries: queries })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await (server as any).server.connect(serverTransport)

    const client = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} })
    await client.connect(clientTransport)
    return client
  }

  it('is advertised, called, and answered with structured content', async () => {
    const { priceQueries } = buildHarness()
    const client = await connect(priceQueries)

    const tools = await client.listTools()
    const declared = tools.tools.find(t => t.name === 'lens_get_price')
    expect(declared).toBeDefined()
    expect(declared!.outputSchema).toBeDefined()

    const result = await client.callTool({
      name: 'lens_get_price',
      arguments: { assetA: 'native', assetB: `USDC:${TESTNET_USDC}` },
    })

    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as any).price).toBe(0.185)
    // A client that only renders text still reads the same answer.
    expect(jsonOf(result).pairKey).toBe(`USDC:${TESTNET_USDC}/XLM`)

    const refused = await client.callTool({
      name: 'lens_get_price',
      arguments: { assetA: 'native', assetB: `USDC:${MAINNET_USDC}` },
    })
    expect(refused.isError).toBe(true)
    expect(jsonOf(refused).code).toBe('ERR_ASSET_ISSUER_MISMATCH')
  })

  it('refuses an argument the schema does not declare', async () => {
    const { priceQueries, aggregatedPrice } = buildHarness()
    const client = await connect(priceQueries)

    const result = await client.callTool({
      name: 'lens_get_price',
      arguments: { assetA: 'native', assetB: 'USDC', pairKey: 'XLM/USDC' },
    })

    expect(result.isError).toBe(true)
    expect(jsonOf(result).code).toBe('ERR_BAD_REQUEST')
    expect(aggregatedPrice).not.toHaveBeenCalled()
  })
})
