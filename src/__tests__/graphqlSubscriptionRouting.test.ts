import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import type { AddressInfo } from 'net'

// graphql.ts pulls in redis / db / aggregator / config at import time — stub
// the ones the Query resolvers touch so importing the module is side-effect
// free. The subscription path under test does not use any of them.
vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../db', () => ({ pgPool: { query: vi.fn() } }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({ config: { pairs: [] }, activeNetwork: 'testnet' }))

import { registerGraphQL } from '../api/graphql'
import { publishPriceUpdate, priceEmitter } from '../events'
import { active_subscriptions } from '../metrics'

const SUBPROTOCOL = 'graphql-transport-ws'

async function buildServer(): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify({ logger: false })
  await registerGraphQL(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { app, url: `ws://127.0.0.1:${port}/graphql` }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, SUBPROTOCOL)
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })))
    ws.on('message', function onAck(raw) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'connection_ack') {
        ws.off('message', onAck)
        ws.on('error', () => {})
        resolve(ws)
      }
    })
  })
}

const SUBSCRIBE = (pair: string, network?: string) => ({
  id: '1',
  type: 'subscribe',
  payload: {
    query: `subscription($pair: String!, $network: String) {
      priceUpdated(pair: $pair, network: $network) { pair price ts network }
    }`,
    variables: { pair, network: network ?? null },
  },
})

/** Read the gauge value for one pair label right now. */
async function gaugeFor(pair: string): Promise<number> {
  const { values } = await active_subscriptions.get()
  const match = (values ?? []).find(v => v.labels.pair === pair)
  return match ? match.value : 0
}

/** Wait until an async predicate holds, polling as the server releases. */
function waitUntil(fn: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const poll = setInterval(async () => {
      if (await fn()) {
        clearInterval(poll)
        resolve(true)
      }
    }, 10)
    setTimeout(() => {
      clearInterval(poll)
      resolve(false)
    }, timeoutMs)
  })
}

describe('active subscriptions metric (#373)', () => {
  let app: FastifyInstance
  let url: string

  beforeEach(async () => {
    ;({ app, url } = await buildServer())
  })

  afterEach(async () => {
    await app.close()
    expect(priceEmitter.listenerCount('price:published')).toBe(0)
  })

  it('is exported by pair and follows the subscription lifetime', async () => {
    expect(await gaugeFor('XLM/USDC')).toBe(0)

    const ws = await connect(url)
    ws.send(JSON.stringify(SUBSCRIBE('XLM/USDC', 'mainnet')))
    expect(await waitUntil(async () => await gaugeFor('XLM/USDC') === 1)).toBe(true)

    // Publish on the subscribed pair only; the metric must not move and the
    // subscription must receive it — one wake for one matching pair.
    await new Promise(r => setTimeout(r, 100))
    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.25, ts: '2026-06-02T00:00:00.000Z', network: 'mainnet' })
    publishPriceUpdate({ pair: 'BTC/USDC', price: 99, ts: '2026-06-02T00:00:00.000Z', network: 'mainnet' })

    const next = await new Promise<any>((resolve, reject) => {
      ws.on('message', function onMsg(raw) {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'next') {
          expect(msg.payload.data.priceUpdated.pair).toBe('XLM/USDC')
          ws.off('message', onMsg)
          resolve(msg)
        }
      })
      setTimeout(() => reject(new Error('timed out waiting for the matched event')), 2000)
    })
    expect(next.id).toBe('1')

    ws.close(1000)
    // Gauge releases when the subscription ends — this is the whole point of
    // the metric: it reflects live counts, not resolver-call counts.
    expect(await waitUntil(async () => await gaugeFor('XLM/USDC') === 0)).toBe(true)
  })

  it('keeps pairs separate in the gauge', async () => {
    const a = await connect(url)
    a.send(JSON.stringify(SUBSCRIBE('XLM/USDC', 'mainnet')))
    const b = await connect(url)
    b.send(JSON.stringify(SUBSCRIBE('BTC/USDC', 'testnet')))

    expect(await waitUntil(async () => await gaugeFor('XLM/USDC') === 1 && await gaugeFor('BTC/USDC') === 1)).toBe(true)
    expect(await gaugeFor('ETH/USDC')).toBe(0)

    a.close(1000)
    b.close(1000)
    expect(await waitUntil(async () => await gaugeFor('XLM/USDC') === 0 && await gaugeFor('BTC/USDC') === 0)).toBe(true)
  })

  it('a network-less subscription still counts on the pair and receives both networks', async () => {
    const ws = await connect(url)
    // Collect every next it can send, before publishing, so both chains are
    // genuinely observable rather than lucky-timed.
    const seen = new Set<string>()
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'next') seen.add(msg.payload.data.priceUpdated.network)
    })
    ws.send(JSON.stringify(SUBSCRIBE('XLM/USDC')))
    expect(await waitUntil(async () => await gaugeFor('XLM/USDC') === 1)).toBe(true)
    await new Promise(r => setTimeout(r, 100))

    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.11, ts: '2026-06-02T00:00:00.000Z', network: 'testnet' })
    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.22, ts: '2026-06-02T00:00:01.000Z', network: 'mainnet' })

    expect(
      await waitUntil(() => seen.has('testnet') && seen.has('mainnet'))
    ).toBe(true)

    ws.close(1000)
    expect(await waitUntil(async () => await gaugeFor('XLM/USDC') === 0)).toBe(true)
  })
})
