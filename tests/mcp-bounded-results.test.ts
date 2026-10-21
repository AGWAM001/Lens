import { describe, it, expect, vi } from 'vitest'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BazaarMcpServer } from '../src/mcp/server'

/**
 * #416 — a tool result is written straight into an agent's context window, so an
 * unbounded one is self-inflicted denial of service whose failure gets blamed on
 * the model. These tests pin the four things that make a result safe to hand
 * back: a byte ceiling, an explicit truncation label, no pretty-printing, and a
 * bounded page plus a count wherever paging is something the agent can ask for.
 *
 * They also pin the second half of the fix, which is the part that cannot be
 * undone by a client: the body read from upstream is capped while streaming, so
 * an oversized response is never buffered in full here.
 */

function captureHandler(server: BazaarMcpServer) {
  let handler: any = null
  ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) handler = fn
  }
  ;(server as any).setupHandlers()
  return handler as (request: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<any>
}

const publicLookup = { lookup: async () => ['93.184.216.34'] }

function searchHandler(fetchImpl: (input: string | URL) => Promise<Response>, limits?: Record<string, number>) {
  const server = new BazaarMcpServer({
    fetchWithPayment: vi.fn(),
    bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl },
    ...(limits ? { limits } : {}),
  })
  return captureHandler(server)
}

/** A node that answers with JSON, as #480's content-type gate requires. */
const jsonFetch = (payload: unknown) => async () =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const textOf = (response: any) => response.content[0].text

describe('bazaar_search bounded results (#416)', () => {
  it('pages a collection that exceeds the item limit and says so', async () => {
    const resources = Array.from({ length: 500 }, (_, i) => ({ resource: { url: `https://r${i}.example` } }))
    const handler = searchHandler(jsonFetch({ resources, total: resources.length }))

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } })

    expect(response.isError).toBeFalsy()
    const text = textOf(response)
    const parsed = JSON.parse(text)
    expect(parsed.resources.length).toBeLessThanOrEqual(50)
    expect(parsed.truncated).toBe(true)
    expect(parsed.total).toBe(500)
    expect(parsed.offset).toBe(0)
    expect(parsed.notice).toMatch(/limit and offset/)
    // Indentation is for humans; it costs the agent context for no benefit.
    expect(text).not.toContain('\n  ')
  })

  it('asks the node for the page it was given, and echoes it back', async () => {
    const requested: string[] = []
    const resources = Array.from({ length: 30 }, (_, i) => ({ resource: { url: `https://r${i}.example` } }))
    const handler = searchHandler(async (input: string | URL) => {
      requested.push(String(input))
      return new Response(JSON.stringify({ resources }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const response = await handler({
      params: {
        name: 'bazaar_search',
        arguments: { url: 'https://ok.example', query: 'xlm', limit: 7, offset: 14 },
      },
    })

    expect(requested[0]).toContain('/discovery/search?')
    expect(requested[0]).toContain('q=xlm')
    expect(requested[0]).toContain('limit=7')
    expect(requested[0]).toContain('offset=14')

    const parsed = JSON.parse(textOf(response))
    expect(parsed.resources.length).toBe(7)
    expect(parsed.total).toBe(30)
    expect(parsed.offset).toBe(14)
    expect(parsed.truncated).toBe(true)
  })

  it('clamps a page an agent asks for beyond the operator ceiling', async () => {
    const requested: string[] = []
    const handler = searchHandler(async (input: string | URL) => {
      requested.push(String(input))
      return new Response(JSON.stringify({ resources: [{ resource: { url: 'https://a.example' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }, { maxPageLimit: 20 })

    await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example', limit: 5000 } } })

    expect(requested[0]).toContain('limit=20')
  })

  it('keeps a response within the configured byte limit', async () => {
    const resources = Array.from({ length: 1000 }, (_, i) => ({
      resource: { url: `https://example.com/${'y'.repeat(200)}${i}` },
    }))
    const handler = searchHandler(jsonFetch({ resources }), {
      maxResultBytes: 4096,
      maxUpstreamBytes: 1_048_576,
    })

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } })

    const text = textOf(response)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4096)
    const parsed = JSON.parse(text)
    expect(parsed.truncated).toBe(true)
    expect(parsed.total).toBe(1000)
    expect(parsed.resources.length).toBeGreaterThan(0)
    expect(parsed.resources.length).toBeLessThan(1000)
  })

  it('truncates a payload with no pageable collection', async () => {
    const handler = searchHandler(jsonFetch({ blob: 'z'.repeat(10_000) }), { maxResultBytes: 2048 })

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } })

    const text = textOf(response)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048)
    const parsed = JSON.parse(text)
    expect(parsed.truncated).toBe(true)
    expect(parsed.notice).toMatch(/limit and offset/)
    expect(typeof parsed.partial).toBe('string')
    expect(parsed.partial.length).toBeGreaterThan(0)
  })

  it('does not buffer an oversized upstream body in full', async () => {
    const totalChunks = 64
    const chunk = new TextEncoder().encode('x'.repeat(4096))
    let produced = 0
    let cancelled = false
    const stream = new ReadableStream({
      pull(controller) {
        if (produced >= totalChunks) {
          controller.close()
          return
        }
        produced++
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })

    const handler = searchHandler(
      async () =>
        new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
      { maxUpstreamBytes: 8192, maxResultBytes: 65_536 },
    )

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } })

    expect(response.isError).toBe(true)
    const payload = JSON.parse(textOf(response))
    expect(payload.code).toBe('ERR_RESPONSE_TOO_LARGE')
    expect(payload.reason).toMatch(/smaller limit/)
    expect(payload.details.maxUpstreamBytes).toBe(8192)
    expect(produced).toBeLessThan(totalChunks)
    expect(cancelled).toBe(true)
  })

  it('rejects a page size that is not a positive integer before fetching', async () => {
    const fetchImpl = vi.fn(jsonFetch({ resources: [{ resource: { url: 'https://a.example' } }] }))
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl },
    })
    const handler = captureHandler(server)

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example', limit: 0 } } })

    expect(response.isError).toBe(true)
    expect(JSON.parse(textOf(response)).code).toBe('ERR_BAD_REQUEST')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('leaves a small response untouched', async () => {
    const handler = searchHandler(jsonFetch({ resources: [{ resource: { url: 'https://a.example' } }] }))

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } })

    expect(response.isError).toBeFalsy()
    const parsed = JSON.parse(textOf(response))
    expect(parsed.truncated).toBeUndefined()
    expect(parsed.resources[0].resource.url).toBe('https://a.example')
  })
})

describe('lens_get_price bounded results (#416)', () => {
  const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

  function priceHandler(limits?: Record<string, number>, recommendation = 'AMM offers a better rate') {
    const priceQueries: any = {
      activeNetwork: 'testnet',
      watchedPairs: () => [
        {
          assetA: { code: 'USDC', issuer: TESTNET_USDC },
          assetB: { code: 'XLM', issuer: null },
          pairKey: `USDC:${TESTNET_USDC}/XLM`,
        },
      ],
      aggregatedPrice: async () => ({
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
      }),
      bestRoute: async () => ({
        route: 'AMM',
        sdexPrice: 0.184,
        ammPrice: 0.186,
        estimatedOutput: 184,
        slippagePct: 0,
        recommendation,
      }),
    }

    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      priceQueries,
      ...(limits ? { limits } : {}),
    })
    return captureHandler(server)
  }

  const args = {
    assetA: `USDC:${TESTNET_USDC}`,
    assetB: 'XLM',
  }

  it('keeps structuredContent while the result fits, and does not pad it', async () => {
    const handler = priceHandler()

    const response = await handler({ params: { name: 'lens_get_price', arguments: args } })

    expect(response.structuredContent).toBeTruthy()
    expect(textOf(response)).toBe(JSON.stringify(response.structuredContent))
    expect(textOf(response)).not.toContain('\n  ')
  })

  it('drops structuredContent when the payload cannot fit, and labels the text', async () => {
    const handler = priceHandler({ maxResultBytes: 1024 }, 'r'.repeat(4000))

    const response = await handler({ params: { name: 'lens_get_price', arguments: args } })

    const text = textOf(response)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1024)
    expect(response.structuredContent).toBeUndefined()
    expect(JSON.parse(text).truncated).toBe(true)
  })
})

describe('paid_call bounded results (#416)', () => {
  const allowlist = ['example.com']

  function paidHandler(response: Response, limits?: Record<string, number>) {
    const fetchWithPayment = vi.fn().mockResolvedValue(response)
    const server = new BazaarMcpServer({
      fetchWithPayment,
      paidCallAllowlist: allowlist,
      ...(limits ? { limits } : {}),
    })
    return { handler: captureHandler(server), fetchWithPayment }
  }

  it('bounds a collection result and reports the truncation', async () => {
    const { handler } = paidHandler(
      new Response(JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => i) }), { status: 200 }),
      { maxResultBytes: 1024 },
    )

    const response = await handler({ params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } } })

    expect(response.isError).toBeFalsy()
    const text = textOf(response)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1024)
    const parsed = JSON.parse(text)
    expect(parsed.truncated).toBe(true)
    // paid_call has no pagination contract, so items are cut by bytes only and
    // the result says what to do about it instead of pretending to be a page.
    expect(parsed.notice).toMatch(/paginated endpoint/)
  })

  it('flags a body that exceeds the read cap as incomplete', async () => {
    const big = 'a'.repeat(5000)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big))
        controller.enqueue(new TextEncoder().encode(big))
        controller.close()
      },
    })
    const { handler } = paidHandler(new Response(stream, { status: 200 }), {
      maxUpstreamBytes: 4096,
      maxResultBytes: 2048,
    })

    const response = await handler({ params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } } })

    const text = textOf(response)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048)
    const parsed = JSON.parse(text)
    expect(parsed.truncated).toBe(true)
    expect(parsed.notice).toMatch(/incomplete/)
    expect(parsed.partial).toContain('aaaa')
  })

  it('passes a plain-text answer through as plain text', async () => {
    const { handler } = paidHandler(new Response('the price is 0.185', { status: 200 }))

    const response = await handler({ params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } } })

    expect(textOf(response)).toBe('the price is 0.185')
  })

  it('bounds a result that stays under the cap without labelling it', async () => {
    const payload = { ok: true, value: 1 }
    const { handler } = paidHandler(new Response(JSON.stringify(payload), { status: 200 }))

    const response = await handler({ params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } } })

    expect(textOf(response)).toBe(JSON.stringify(payload))
  })
})
