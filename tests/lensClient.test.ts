import { describe, it, expect, vi } from 'vitest'
import { createLensClient, DEFAULT_BASE_URL } from '../clients/typescript/src/client'

// Unit tests for the Lens TypeScript client options (issue #703).
// A fake fetch records the Request it receives; nothing ever hits the network
// and no real key or payment value is used.

interface Captured {
  url: string
  headers: Record<string, string>
}

function makeCaptureFetch() {
  const calls: Captured[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    calls.push({ url: request.url, headers })
    return new Response(JSON.stringify({ ok: true, watchedPairs: [], lastIndexedLedger: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { calls, fetchImpl }
}

describe('createLensClient (issue #703)', () => {
  it('builds the URL for a path with parameters against the default baseUrl', async () => {
    const { calls, fetchImpl } = makeCaptureFetch()
    const client = createLensClient({ fetch: fetchImpl })
    const res = await client.GET('/v1/price/{assetA}/{assetB}', {
      params: { path: { assetA: 'XLM', assetB: 'USDC' } },
    })
    expect(res.error).toBeUndefined()
    expect(calls[0].url).toBe(`${DEFAULT_BASE_URL}/v1/price/XLM/USDC`)
  })

  it('sends the apiKey as a bearer token', async () => {
    const { calls, fetchImpl } = makeCaptureFetch()
    const client = createLensClient({ fetch: fetchImpl, apiKey: 'test-key-value' })
    await client.GET('/v1/status')
    expect(calls[0].headers['authorization']).toBe('Bearer test-key-value')
  })

  it('sends the payment value in the X-PAYMENT header', async () => {
    const { calls, fetchImpl } = makeCaptureFetch()
    const client = createLensClient({ fetch: fetchImpl, payment: 'test-payment-token' })
    await client.GET('/v1/status')
    expect(calls[0].headers['x-payment']).toBe('test-payment-token')
  })

  it('sends both auth headers together when both options are set', async () => {
    const { calls, fetchImpl } = makeCaptureFetch()
    const client = createLensClient({
      fetch: fetchImpl,
      apiKey: 'test-key-value',
      payment: 'test-payment-token',
    })
    await client.GET('/v1/status')
    expect(calls[0].headers['authorization']).toBe('Bearer test-key-value')
    expect(calls[0].headers['x-payment']).toBe('test-payment-token')
  })

  it('lets explicit caller headers win over the option defaults', async () => {
    const { calls, fetchImpl } = makeCaptureFetch()
    const client = createLensClient({
      fetch: fetchImpl,
      apiKey: 'test-key-value',
      payment: 'test-payment-token',
    })
    await client.GET('/v1/status', {
      headers: { Authorization: 'Bearer caller-set-key', 'X-PAYMENT': 'caller-set-token' },
    })
    expect(calls[0].headers['authorization']).toBe('Bearer caller-set-key')
    expect(calls[0].headers['x-payment']).toBe('caller-set-token')
  })

  it('adds the network query parameter to calls that do not set one', async () => {
    const { calls, fetchImpl } = makeCaptureFetch()
    const client = createLensClient({ fetch: fetchImpl, network: 'testnet' })
    await client.GET('/v1/price/{assetA}/{assetB}', {
      params: { path: { assetA: 'XLM', assetB: 'USDC' } },
    })
    const url = new URL(calls[0].url)
    expect(url.searchParams.get('network')).toBe('testnet')
    expect(url.pathname).toBe('/v1/price/XLM/USDC')
  })

  it('does not override a network set per-call', async () => {
    const { calls, fetchImpl } = makeCaptureFetch()
    const client = createLensClient({ fetch: fetchImpl, network: 'testnet' })
    await client.GET('/v1/price/{assetA}/{assetB}', {
      params: {
        path: { assetA: 'XLM', assetB: 'USDC' },
        query: { network: 'mainnet' },
      },
    })
    const url = new URL(calls[0].url)
    expect(url.searchParams.get('network')).toBe('mainnet')
  })

  it('returns an error response as error instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = createLensClient({ fetch: fetchImpl })
    const res = await client.GET('/v1/status')
    expect(res.error).toBeDefined()
    expect(res.data).toBeUndefined()
  })
})
