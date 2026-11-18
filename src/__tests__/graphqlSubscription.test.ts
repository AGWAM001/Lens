import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import type { AddressInfo } from 'net'

// graphql.ts pulls in redis / db / aggregator / config at import time — stub the
// ones the Query resolvers touch so importing the module is side-effect free.
// The subscription path under test does not use any of them.
vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../db', () => ({ pgPool: { query: vi.fn() } }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({ config: { pairs: [] } }))

import { registerGraphQL } from '../api/graphql'
import { publishPriceUpdate, priceEmitter } from '../events'

const SUBPROTOCOL = 'graphql-transport-ws'

async function buildServer(): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify({ logger: false })
  await registerGraphQL(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { app, url: `ws://127.0.0.1:${port}/graphql` }
}

/** Open a graphql-transport-ws connection and complete the connection_init handshake. */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, SUBPROTOCOL)
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })))
    ws.on('message', function onAck(raw) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'connection_ack') {
        ws.off('message', onAck)
        resolve(ws)
      }
    })
  })
}

/** Wait for the next message of a given type, with a timeout. */
function waitFor(ws: WebSocket, type: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error(`timed out waiting for "${type}"`))
    }, timeoutMs)
    function onMsg(raw: WebSocket.RawData) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === type) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
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

describe('GraphQL priceUpdated subscription', () => {
  let app: FastifyInstance
  let url: string

  beforeEach(async () => {
    ;({ app, url } = await buildServer())
  })

  afterEach(async () => {
    await app.close()
    // app.close() fires the onClose hook that detaches the bridge listener.
    expect(priceEmitter.listenerCount('price:published')).toBe(0)
  })

  it('streams updates for the subscribed pair', async () => {
    const ws = await connect(url)
    ws.send(JSON.stringify(SUBSCRIBE('XLM/USDC')))

    // Give the server a tick to register the subscription before publishing.
    await new Promise(r => setTimeout(r, 100))
    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.1234, ts: '2026-06-02T00:00:00.000Z', network: 'testnet' })

    const next = await waitFor(ws, 'next')
    expect(next.id).toBe('1')
    expect(next.payload.data.priceUpdated).toEqual({
      pair: 'XLM/USDC',
      price: 0.1234,
      ts: '2026-06-02T00:00:00.000Z',
      network: 'testnet',
    })

    ws.close()
  })

  it('does not deliver updates for other pairs', async () => {
    const ws = await connect(url)
    ws.send(JSON.stringify(SUBSCRIBE('XLM/USDC')))
    await new Promise(r => setTimeout(r, 100))

    // A different pair must be filtered out…
    publishPriceUpdate({ pair: 'BTC/USDC', price: 99, ts: '2026-06-02T00:00:00.000Z', network: 'testnet' })
    // …while the subscribed pair still comes through.
    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.5, ts: '2026-06-02T00:00:01.000Z', network: 'testnet' })

    const next = await waitFor(ws, 'next')
    expect(next.payload.data.priceUpdated.pair).toBe('XLM/USDC')
    expect(next.payload.data.priceUpdated.price).toBe(0.5)

    ws.close()
  })

  it('does not deliver another network\'s price for the same pair', async () => {
    // Since #117 every enabled network runs its own ingester loop and all of
    // them publish to this one emitter. Without the network filter a mainnet
    // print and a testnet print for XLM/USDC arrive on the same stream,
    // indistinguishable — a chart that looks noisy rather than wrong, which
    // is the harder kind of bug to notice.
    const ws = await connect(url)
    ws.send(JSON.stringify(SUBSCRIBE('XLM/USDC', 'mainnet')))
    await new Promise(r => setTimeout(r, 100))

    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.11, ts: '2026-06-02T00:00:00.000Z', network: 'testnet' })
    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.22, ts: '2026-06-02T00:00:01.000Z', network: 'mainnet' })

    const next = await waitFor(ws, 'next')
    expect(next.payload.data.priceUpdated.network).toBe('mainnet')
    expect(next.payload.data.priceUpdated.price).toBe(0.22)

    ws.close()
  })

  it('delivers every network when none is requested, each tagged with its own', async () => {
    // Omitting the argument is allowed, but only because the message carries
    // its own network — a subscriber can still tell the two chains apart.
    const ws = await connect(url)
    ws.send(JSON.stringify(SUBSCRIBE('XLM/USDC')))
    await new Promise(r => setTimeout(r, 100))

    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.11, ts: '2026-06-02T00:00:00.000Z', network: 'testnet' })
    const first = await waitFor(ws, 'next')
    expect(first.payload.data.priceUpdated.network).toBe('testnet')

    publishPriceUpdate({ pair: 'XLM/USDC', price: 0.22, ts: '2026-06-02T00:00:01.000Z', network: 'mainnet' })
    const second = await waitFor(ws, 'next')
    expect(second.payload.data.priceUpdated.network).toBe('mainnet')

    ws.close()
  })

  it('closes the channel cleanly on complete', async () => {
    const ws = await connect(url)
    ws.send(JSON.stringify(SUBSCRIBE('XLM/USDC')))
    await new Promise(r => setTimeout(r, 100))

    // Client-initiated unsubscribe.
    ws.send(JSON.stringify({ id: '1', type: 'complete' }))
    await new Promise(r => setTimeout(r, 100))

    // After completing, further publishes for that pair must not arrive.
    let received = false
    ws.on('message', raw => {
      if (JSON.parse(raw.toString()).type === 'next') received = true
    })
    publishPriceUpdate({ pair: 'XLM/USDC', price: 1, ts: '2026-06-02T00:00:02.000Z', network: 'testnet' })
    await new Promise(r => setTimeout(r, 200))

    expect(received).toBe(false)
    ws.close()
  })
})
