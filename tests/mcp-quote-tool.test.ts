import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BazaarMcpServer } from '../src/mcp/server'
import {
  LENS_QUOTE_TOOL_NAME,
  QUOTE_IMPACT_LIQUIDITY_FRACTION,
  QUOTE_IMPACT_THRESHOLDS,
  parseQuoteAmount,
  readLensQuote,
  type LensQuoteQueries,
  type LensQuoteResult,
  type QuoteDepthOutcome,
  type QuoteImpact,
} from '../src/mcp/quoteTool'
import type { McpLimits } from '../src/mcp/limits'
import type { NetworkName } from '../src/config'
import type { RouteInfo, WatchedPair } from '../src/types'

/**
 * #685 — `lens_quote` answers "what would this trade cost" for a size the agent
 * names, from the three reads REST already serves. These tests drive the pure
 * tool half with injected reads only: no database, no Horizon, no network. That
 * is the point of the split, and the last block here checks the split is real.
 */

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const TESTNET_PAIR_KEY = `USDC:${TESTNET_USDC}/XLM`

const jsonOf = (result: unknown) =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)

function watchedPair(issuer: string): WatchedPair {
  return {
    assetA: { code: 'USDC', issuer },
    assetB: { code: 'XLM', issuer: null },
    pairKey: `USDC:${issuer}/XLM`,
  }
}

const routeInfo = (): RouteInfo => ({
  route: 'AMM',
  sdexPrice: 0.184,
  ammPrice: 0.185,
  estimatedOutput: 185,
  slippagePct: 0.5,
  recommendation: 'AMM offers 0.54% better rate',
  network: 'testnet',
})

const depthPriced = (): QuoteDepthOutcome => ({
  status: 'ok',
  network: 'testnet',
  pairKey: TESTNET_PAIR_KEY,
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
})

const depthUnreachable: QuoteDepthOutcome = {
  status: 'unavailable',
  network: 'testnet',
  pairKey: TESTNET_PAIR_KEY,
  reason: 'every AMM pool for this pair was excluded',
  excludedPools: [{ poolId: 'pool-b', reason: 'pool has no reserves in its latest snapshot' }],
}

const impactOk = (): QuoteImpact => ({
  status: 'ok',
  spotPrice: 0.185,
  availableLiquidity: 25_000,
  smallestSize: 100,
  ladder: [
    { size: 100, output: 18.49, executionPrice: 0.1849, slippagePct: 0.05 },
    { size: 25_000, output: 4512.9, executionPrice: 0.1805, slippagePct: 2.43 },
  ],
  thresholds: [
    { thresholdPct: 1, crossed: true, size: 11_800 },
    { thresholdPct: 5, crossed: false, size: null },
    { thresholdPct: 10, crossed: false, size: null },
  ],
  source: 'AMM',
})

interface HarnessOptions {
  pairs?: Partial<Record<NetworkName, readonly WatchedPair[]>>
  activeNetwork?: NetworkName
  route?: RouteInfo | Error
  depth?: QuoteDepthOutcome | Error
  impact?: QuoteImpact | null | Error
}

function buildHarness(options: HarnessOptions = {}) {
  const pairs: Record<NetworkName, readonly WatchedPair[]> = {
    testnet: [watchedPair(TESTNET_USDC)],
    mainnet: [watchedPair(MAINNET_USDC)],
    ...options.pairs,
  }

  const settle = <T>(value: T | Error | undefined, fallback: T): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? fallback)

  const route = vi.fn(() => settle(options.route, routeInfo()))
  const depth = vi.fn(() => settle(options.depth, depthPriced()))
  // `null` is an answer here (the pair has no AMM leg), so it cannot go through
  // `settle`'s nullish fallback.
  const impact = vi.fn(() =>
    options.impact instanceof Error
      ? Promise.reject(options.impact)
      : Promise.resolve(options.impact === undefined ? impactOk() : options.impact)
  )

  const quoteQueries: LensQuoteQueries = {
    activeNetwork: options.activeNetwork ?? 'testnet',
    watchedPairs: network => pairs[network] ?? [],
    route,
    depth,
    impact,
  }

  return {
    quoteQueries,
    route,
    depth,
    impact,
    pairs,
    call: (arguments_: unknown) => readLensQuote(arguments_, quoteQueries),
  }
}

/** The tool over a real server, so the dispatch and output budget are exercised. */
function buildServer(quoteQueries: LensQuoteQueries | undefined, limits?: Partial<McpLimits>) {
  const server = new BazaarMcpServer({
    fetchWithPayment: vi.fn(),
    ...(quoteQueries ? { quoteQueries } : {}),
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
    callTool: (arguments_: unknown) =>
      handlers.call({ params: { name: LENS_QUOTE_TOOL_NAME, arguments: arguments_ } }),
  }
}

const ask = { assetA: 'XLM', assetB: `USDC:${TESTNET_USDC}`, amount: 250 }

beforeEach(() => {
  vi.restoreAllMocks()
})

// ── The order size ────────────────────────────────────────────────────────────

describe('lens_quote amount validation', () => {
  it('prices a positive decimal number', async () => {
    const outcome = await readLensQuote(
      { assetA: 'native', assetB: `USDC:${TESTNET_USDC}`, amount: 250 },
      buildHarness().quoteQueries
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.amount).toBe(250)
  })

  it('accepts a decimal string, including one without a leading zero', () => {
    for (const raw of ['250', '250.5', '.5', ' 250 ']) {
      const parsed = parseQuoteAmount(raw)
      expect('amount' in parsed, `${raw} refused`).toBe(true)
    }
  })

  it('refuses trailing junk instead of reading it as the number in front', () => {
    // The parseFloat trap this repo has been burned by: parseFloat('100abc') is
    // 100, so a typo'd order size would silently price a different trade.
    for (const raw of ['100abc', '100 AB', '12.5.5', '1_000', '0x10', 'abc']) {
      const parsed = parseQuoteAmount(raw)
      expect('code' in parsed, `${raw} was accepted`).toBe(true)
      if ('code' in parsed) expect(parsed.code).toBe('ERR_BAD_REQUEST')
    }
  })

  it('refuses everything that is not a positive finite number', () => {
    for (const raw of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, '', ' ', '1e5', '100abc']) {
      const parsed = parseQuoteAmount(raw)
      expect('code' in parsed, `${JSON.stringify(raw)} was accepted`).toBe(true)
    }
    expect(parseQuoteAmount(undefined)).toMatchObject({ code: 'ERR_BAD_REQUEST' })
    expect(parseQuoteAmount(true)).toMatchObject({ code: 'ERR_BAD_REQUEST' })
    expect(parseQuoteAmount(null)).toMatchObject({ code: 'ERR_BAD_REQUEST' })
    expect(parseQuoteAmount({ amount: 1 })).toMatchObject({ code: 'ERR_BAD_REQUEST' })
  })

  it('names scientific notation as the thing it will not read', () => {
    const parsed = parseQuoteAmount('1e5')
    expect('reason' in parsed).toBe(true)
    if ('reason' in parsed) expect(parsed.reason).toMatch(/scientific notation/)
  })

  it('requires amount rather than defaulting it, and refuses before reading', async () => {
    const harness = buildHarness()
    const response = buildServer(harness.quoteQueries).callTool({
      assetA: 'native',
      assetB: `USDC:${TESTNET_USDC}`,
    })
    const payload = jsonOf(await response)
    expect(payload.isError).toBe(true)
    expect(payload.code).toBe('ERR_BAD_REQUEST')
    expect(payload.reason).toMatch(/amount/)
    expect(harness.route).not.toHaveBeenCalled()
    expect(harness.depth).not.toHaveBeenCalled()
    expect(harness.impact).not.toHaveBeenCalled()
  })

  it('refuses a bad amount whatever the pair, like REST does', async () => {
    const harness = buildHarness()
    // BTC/XLM is not watched either, so which refusal comes back proves the
    // order: a malformed argument is settled before the pair is looked up.
    const outcome = await harness.call({ assetA: 'BTC', assetB: 'XLM', amount: '100abc' })
    expect(outcome).toMatchObject({ ok: false, error: { code: 'ERR_BAD_REQUEST' } })
    expect(harness.route).not.toHaveBeenCalled()
  })
})

// ── The envelope ──────────────────────────────────────────────────────────────

describe('lens_quote result', () => {
  it('names the pair, the size and both assets with their issuers in full', async () => {
    const outcome = await buildHarness().call(ask)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result

    expect(result.network).toBe('testnet')
    expect(result.pairKey).toBe(TESTNET_PAIR_KEY)
    expect(result.amount).toBe(250)
    expect(result.orientation).toBe('quote-per-base')
    // The watched pair's own order, not the order the caller typed: XLM was asked
    // for first, but this pair is USDC-issued-by-Circle over XLM.
    expect(result.base).toEqual({ code: 'USDC', issuer: TESTNET_USDC })
    expect(result.quote).toEqual({ code: 'XLM', issuer: null })
    expect(result.direction).toBe('reversed')
    // An issuer is part of an asset's identity, so it travels complete.
    expect(result.base.issuer).toHaveLength(56)
    expect(result.lastUpdated).toMatch(/T.*Z$/)
  })

  it('prices every leg in the pair order at the caller size', async () => {
    const harness = buildHarness()
    await harness.call(ask)

    const pair = harness.pairs.testnet[0]
    // `amount` is a quantity of the pair's base side, so a reversed request still
    // prices base→quote — which is why the result carries `direction`.
    expect(harness.route).toHaveBeenCalledWith(pair.assetA, pair.assetB, TESTNET_PAIR_KEY, 250, 'testnet')
    expect(harness.depth).toHaveBeenCalledWith('testnet', TESTNET_PAIR_KEY, 250)
    expect(harness.impact).toHaveBeenCalledWith(
      TESTNET_PAIR_KEY,
      'testnet',
      QUOTE_IMPACT_THRESHOLDS,
      QUOTE_IMPACT_LIQUIDITY_FRACTION
    )
  })

  it('renders the legs as the REST bodies: codes, pair key, then the read', async () => {
    const outcome = await buildHarness().call(ask)
    if (!outcome.ok) throw new Error('quote was refused')
    const result = outcome.result as LensQuoteResult

    expect(result.route).toEqual(routeInfo())
    expect(result.depth).toEqual({ assetA: 'USDC', assetB: 'XLM', ...depthPriced() })
    expect(result.impact).toEqual({
      assetA: 'USDC',
      assetB: 'XLM',
      pairKey: TESTNET_PAIR_KEY,
      ...impactOk(),
    })
    expect(result.unavailable).toEqual([])
  })

  it('defaults to the server network and quotes another when named', async () => {
    const harness = buildHarness()
    const outcome = await harness.call({
      assetA: 'native',
      assetB: `USDC:${MAINNET_USDC}`,
      amount: 10,
      network: 'mainnet',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.network).toBe('mainnet')
    expect(outcome.result.pairKey).toBe(`USDC:${MAINNET_USDC}/XLM`)
    expect(harness.depth).toHaveBeenCalledWith('mainnet', `USDC:${MAINNET_USDC}/XLM`, 10)
  })
})

// ── Refusals ──────────────────────────────────────────────────────────────────

describe('lens_quote refusals', () => {
  it('refuses a same-named asset with a different issuer instead of pricing it', async () => {
    const harness = buildHarness()
    const outcome = await harness.call({ assetA: 'native', assetB: `USDC:${MAINNET_USDC}`, amount: 100 })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'ERR_ASSET_ISSUER_MISMATCH' } })
    expect(harness.route).not.toHaveBeenCalled()
  })

  it('refuses an unwatched pair and lists what is watched', async () => {
    const harness = buildHarness()
    const outcome = await harness.call({ assetA: 'BTC', assetB: 'XLM', amount: 100 })
    expect(outcome).toMatchObject({ ok: false, error: { code: 'ERR_PAIR_NOT_WATCHED' } })
    if (!outcome.ok) expect(outcome.error.reason).toContain(TESTNET_PAIR_KEY)
  })

  it('refuses a malformed asset with ERR_INVALID_ASSET', async () => {
    const harness = buildHarness()
    for (const bad of ['usdc', 'USDC:GA5', 'TOO_LONG_CODE:X']) {
      const outcome = await harness.call({ assetA: bad, assetB: 'XLM', amount: 1 })
      expect(outcome).toMatchObject({ ok: false, error: { code: 'ERR_INVALID_ASSET' } })
    }
  })

  it('refuses an unknown network with the vocabulary the other tools use', async () => {
    const harness = buildHarness()
    const outcome = await harness.call({ ...ask, network: 'devnet' })
    expect(outcome).toMatchObject({ ok: false, error: { code: 'ERR_BAD_REQUEST' } })
    expect(harness.route).not.toHaveBeenCalled()
  })

  it('refuses an argument it does not take rather than ignoring it', async () => {
    const harness = buildHarness()
    const outcome = await harness.call({ ...ask, thresholds: '1,5,10' })
    expect(outcome).toMatchObject({ ok: false, error: { code: 'ERR_BAD_REQUEST' } })
    if (!outcome.ok) expect(outcome.error.reason).toMatch(/thresholds/)
    expect(harness.impact).not.toHaveBeenCalled()
  })
})

// ── A leg that cannot price the order ─────────────────────────────────────────

describe('lens_quote carries an unavailable leg through honestly', () => {
  it('keeps the depth refusal as a result and says why', async () => {
    const harness = buildHarness({ depth: depthUnreachable })
    const outcome = await harness.call(ask)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.depth).toEqual({ assetA: 'USDC', assetB: 'XLM', ...depthUnreachable })
    expect(outcome.result.depth.status).toBe('unavailable')
    // The reason and the excluded pools reach the agent; no zero is invented.
    if (outcome.result.depth.status !== 'unavailable') throw new Error('depth arm changed')
    expect(outcome.result.depth.reason).toBe('every AMM pool for this pair was excluded')
    expect(outcome.result.depth.excludedPools).toHaveLength(1)
    // And it is visible at the top level too, not only inside the leg.
    expect(outcome.result.unavailable).toHaveLength(1)
    expect(outcome.result.unavailable[0].leg).toBe('depth')
    expect(outcome.result.unavailable[0].code).toBe('ERR_NO_RESULTS')
    expect(outcome.result.unavailable[0].reason).toContain('every AMM pool for this pair was excluded')
    // The legs that did price are unaffected.
    expect(outcome.result.route).toEqual(routeInfo())
  })

  it('reports a missing impact leg with the reason REST gives', async () => {
    const harness = buildHarness({ impact: null })
    const outcome = await harness.call(ask)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.impact).toBe(null)
    expect(outcome.result.unavailable).toHaveLength(1)
    expect(outcome.result.unavailable[0]).toMatchObject({ leg: 'impact', code: 'ERR_NO_RESULTS' })
    expect(outcome.result.unavailable[0].reason).toMatch(/No AMM liquidity available for USDC\/XLM/)
  })

  it('flags an empty impact curve as unavailable without hiding its numbers', async () => {
    const thin: QuoteImpact = {
      status: 'insufficient_liquidity',
      spotPrice: 0.185,
      availableLiquidity: 40,
      smallestSize: 100,
      ladder: [],
      thresholds: [{ thresholdPct: 1, crossed: false, size: null }],
      source: 'AMM',
    }
    const outcome = await buildHarness({ impact: thin }).call(ask)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.impact).toMatchObject({ status: 'insufficient_liquidity', ladder: [] })
    expect(outcome.result.unavailable).toHaveLength(1)
    expect(outcome.result.unavailable[0].leg).toBe('impact')
    expect(outcome.result.unavailable[0].reason).toMatch(/insufficient_liquidity/)
  })

  it('turns a failing read into ERR_SERVICE_UNREACHABLE, never into an empty quote', async () => {
    const harness = buildHarness({ route: new Error('connection refused postgres://user:secret@host') })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = buildServer(harness.quoteQueries)

    const response = await server.callTool(ask)
    expect(response.isError).toBe(true)
    const payload = jsonOf(response)
    expect(payload.code).toBe('ERR_SERVICE_UNREACHABLE')
    // "unreachable" and "no liquidity" are different answers, and the reply says
    // which one it is.
    expect(payload.reason).toMatch(/retry later/i)
    // A driver error can carry the connection string; a transcript must not.
    expect(response.content[0].text).not.toMatch(/secret/)
    expect(spy).toHaveBeenCalled()
  })
})

// ── Advertising, budget and boundaries ────────────────────────────────────────

describe('lens_quote on the server', () => {
  it('is advertised only when its reads are supplied', async () => {
    const withQuotes = buildServer(buildHarness().quoteQueries)
    expect((await withQuotes.listTools()).map((t: { name: string }) => t.name)).toContain(
      LENS_QUOTE_TOOL_NAME
    )

    const without = buildServer(undefined)
    expect((await without.listTools()).map((t: { name: string }) => t.name)).not.toContain(
      LENS_QUOTE_TOOL_NAME
    )

    // Called anyway, it refuses with the reason instead of an empty quote.
    const response = await without.callTool(ask)
    expect(response.isError).toBe(true)
    expect(jsonOf(response).code).toBe('ERR_INTERNAL_FAILURE')
  })

  it('labels a quote over the output budget rather than dumping it into context', async () => {
    // A depth ladder of 40 levels is comfortably past a 400-byte budget, and the
    // point of #416 is that the agent is told rather than flooded.
    const wide: QuoteDepthOutcome = {
      ...(depthPriced() as Extract<QuoteDepthOutcome, { status: 'ok' }>),
      asks: Array.from({ length: 40 }, (_, i) => ({ price: 0.185 + i / 10_000, size: 1000 + i })),
    }
    const harness = buildHarness({ depth: wide })
    const server = buildServer(harness.quoteQueries, { maxResultBytes: 400 })

    const response = await server.callTool(ask)
    expect(response.structuredContent).toBeUndefined()
    const body = jsonOf(response)
    expect(body.truncated).toBe(true)
    expect(body.notice).toMatch(/depth and impact ladders/)
  })

  it('declares the tool the way an agent needs: parity, size, and refusal vocabulary', async () => {
    const server = buildServer(buildHarness().quoteQueries)
    const tool = (await server.listTools()).find((t: { name: string }) => t.name === LENS_QUOTE_TOOL_NAME)

    expect(tool.inputSchema.required).toEqual(['assetA', 'assetB', 'amount'])
    expect(tool.inputSchema.additionalProperties).toBe(false)
    expect(tool.outputSchema).toBeDefined()
    for (const route of ['/route', '/depth', '/impact']) {
      expect(tool.description).toContain(route)
    }
    // The decisions an agent cannot infer from the payload.
    expect(tool.description).toMatch(/ERR_ASSET_ISSUER_MISMATCH/)
    expect(tool.description).toMatch(/units of/)
    expect(tool.description).toMatch(/read-only/i)
  })

  it('keeps the tool module free of the data layer', () => {
    // #685's rule, checked on the file rather than trusted: the tool's logic is
    // testable with a stub only if it cannot reach a database by itself.
    const source = readFileSync(
      fileURLToPath(new URL('../src/mcp/quoteTool.ts', import.meta.url)),
      'utf8'
    )
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])
    const forbidden = ['db', 'prisma', '/pg', 'pricing/depth', 'aggregator', 'stellar-sdk', 'routes/']
    const offenders = imports.filter(spec => forbidden.some(word => spec.includes(word)))
    expect(offenders, `quoteTool.ts imports ${offenders.join(', ')}`).toEqual([])
    expect(imports).toContain('./codes.js')
    expect(imports).toContain('./priceTool.js')
  })
})
