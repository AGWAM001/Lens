import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BazaarMcpServer } from '../src/mcp/server'

/**
 * `lens_get_price` has to be the same number REST and GraphQL serve, computed in
 * one place. These tests stub the two aggregator modules and check the MCP tool
 * delegates to them with the pair and network it resolved — so the tool cannot
 * quietly grow its own price maths or read the wrong chain's rows.
 */

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const CIRCLE_MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const mocks = vi.hoisted(() => ({
  getAggregatedPrice: vi.fn(),
  getBestRoute: vi.fn(),
}))

vi.mock('../src/aggregator/vwap', () => ({ getAggregatedPrice: mocks.getAggregatedPrice }))
vi.mock('../src/aggregator/bestRoute', () => ({ getBestRoute: mocks.getBestRoute }))

const AGG = {
  price: 0.18, sdexPrice: 0.18, ammPrice: 0.18,
  volume24h: 10, sdexVolume24h: 10, ammVolume24h: 0,
  vwap1m: 0.18, vwap5m: 0.18, vwap1h: 0.18, vwap24h: 0.18,
  priceChange24h: 0, sources: 2,
  confidence: 'high' as const, lastTradeAgeSeconds: 5, stale: false,
}

const ROUTE = {
  route: 'SDEX' as const, sdexPrice: 0.18, ammPrice: 0,
  estimatedOutput: 180, slippagePct: 0, recommendation: 'Only SDEX liquidity available',
}

async function loadPriceQueries() {
  vi.resetModules()
  const { createLensPriceQueries } = await import('../src/mcp/priceQueries')
  return createLensPriceQueries()
}

beforeEach(() => {
  process.env.STELLAR_NETWORK = 'testnet'
  process.env.WATCHED_PAIRS_TESTNET = `USDC:${TESTNET_USDC}/XLM`
  mocks.getAggregatedPrice.mockReset().mockResolvedValue(AGG)
  mocks.getBestRoute.mockReset().mockResolvedValue(ROUTE)
})

describe('the MCP price source is the shared aggregator', () => {
  it('reads watched pairs from the named network, not the active one', async () => {
    const queries = await loadPriceQueries()

    expect(queries.activeNetwork).toBe('testnet')
    expect(queries.watchedPairs('testnet').map(p => p.pairKey)).toEqual([`USDC:${TESTNET_USDC}/XLM`])
    // Mainnet carries its own default, pinned to Circle's issuer.
    expect(queries.watchedPairs('mainnet').map(p => p.pairKey)).toEqual([`USDC:${CIRCLE_MAINNET_USDC}/XLM`])
  })

  it('passes the resolved pair key and network to the aggregation query', async () => {
    const queries = await loadPriceQueries()

    await queries.aggregatedPrice(`USDC:${TESTNET_USDC}/XLM`, 'mainnet')
    expect(mocks.getAggregatedPrice).toHaveBeenCalledWith(`USDC:${TESTNET_USDC}/XLM`, 'mainnet')
  })

  it('routes with the same 1000-unit order size REST uses', async () => {
    const queries = await loadPriceQueries()
    const pair = queries.watchedPairs('testnet')[0]

    await queries.bestRoute(pair.assetA, pair.assetB, pair.pairKey, 'testnet')
    expect(mocks.getBestRoute).toHaveBeenCalledWith(pair.assetA, pair.assetB, pair.pairKey, 1000, 'testnet')
  })

  it('serves the aggregated number through the tool end to end', async () => {
    const queries = await loadPriceQueries()
    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn(), priceQueries: queries })

    let handler: any = null
    ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn
    }
    ;(server as any).setupHandlers()

    const response = await handler({
      params: { name: 'lens_get_price', arguments: { assetA: 'native', assetB: `USDC:${TESTNET_USDC}` } },
    })

    expect(response.isError).toBeFalsy()
    expect(response.structuredContent).toMatchObject({
      network: 'testnet',
      pairKey: `USDC:${TESTNET_USDC}/XLM`,
      price: 0.18,
      confidence: 'high',
      lastTradeAgeSeconds: 5,
      stale: false,
      bestRoute: ROUTE,
    })
    // Both aggregator legs were asked about the same pair, on the same network.
    expect(mocks.getAggregatedPrice).toHaveBeenCalledWith(`USDC:${TESTNET_USDC}/XLM`, 'testnet')
    expect(mocks.getBestRoute).toHaveBeenCalledWith(
      { code: 'USDC', issuer: TESTNET_USDC },
      { code: 'XLM', issuer: null },
      `USDC:${TESTNET_USDC}/XLM`,
      1000,
      'testnet',
    )
  })

  it('refuses a mainnet USDC request on this testnet deployment without querying', async () => {
    const queries = await loadPriceQueries()
    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn(), priceQueries: queries })

    let handler: any = null
    ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn
    }
    ;(server as any).setupHandlers()

    const response = await handler({
      params: { name: 'lens_get_price', arguments: { assetA: 'native', assetB: `USDC:${CIRCLE_MAINNET_USDC}` } },
    })

    expect(response.isError).toBe(true)
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_ASSET_ISSUER_MISMATCH')
    expect(mocks.getAggregatedPrice).not.toHaveBeenCalled()
  })
})
