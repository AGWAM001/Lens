import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import WebSocket from 'ws'

import { registerWebSocket } from '../../src/api/websocket'
import { priceEmitter, PRICE_UPDATE } from '../../src/events'
import { fanOutManager } from '../../src/ws/fanout'
import { config } from '../../src/config'

describe('WebSocket subscription full cycle', () => {
  let app: ReturnType<typeof Fastify>
  let port: number

  beforeAll(async () => {
    // Configure fast ping intervals for integration test
    ;(config.ws as any).pingIntervalMs = 50
    ;(config.ws as any).maxMissedPings = 2

    // Initialize the fan-out manager so it listens for price updates
    // and broadcasts to registered WebSocket clients
    await fanOutManager.initialize()

    app = Fastify({ logger: false })
    await registerWebSocket(app)
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as any).port
  })

  afterAll(async () => {
    await fanOutManager.destroy()
    if (app) await app.close()
  })

  it('connects → subscribes → receives updates → disconnects', async () => {
    const before = priceEmitter.listenerCount(PRICE_UPDATE)

    const messages: string[] = []
    const waiters: Array<(msg: string) => void> = []

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    // Attach message listener before awaiting open to avoid the race where the
    // server sends the status message synchronously on connect.
    ws.on('message', (data) => {
      const msg = data.toString()
      const waiter = waiters.shift()
      if (waiter) waiter(msg)
      else messages.push(msg)
    })

    const nextMessage = () =>
      new Promise<string>((resolve) => {
        const buffered = messages.shift()
        if (buffered !== undefined) resolve(buffered)
        else waiters.push(resolve)
      })

    // 1. Connect
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // 2. Receive initial status (may already be buffered)
    const first = JSON.parse(await nextMessage())
    expect(first.type).toBe('status')
    expect(first.message).toBe('Streaming active')

    // 3. Fan-out manager should have registered a listener on the price emitter.
    //    The listener count should be >= 1 (the fan-out listener registered during initialize).
    expect(priceEmitter.listenerCount(PRICE_UPDATE)).toBeGreaterThanOrEqual(1)

    // 4. Emit a price update and verify it's received
    const event = {
      assetA: 'XLM',
      assetB: 'USDC',
      previousPrice: 1.0,
      currentPrice: 1.2345,
      timestamp: new Date(),
    }
    priceEmitter.emit(PRICE_UPDATE, event)

    const next = JSON.parse(await nextMessage())
    expect(next.type).toBe('price_update')
    expect(next.assetA).toBe(event.assetA)
    expect(next.assetB).toBe(event.assetB)
    expect(next.currentPrice).toBe(event.currentPrice)
    expect(new Date(next.timestamp).toISOString()).toBe(event.timestamp.toISOString())

    // 5. Verify client was registered in internal maps
    expect(fanOutManager.getClientCount()).toBe(1)
    expect(fanOutManager.getPairClientCount('*')).toBe(1)

    // 6. Disconnect and verify both internal maps are cleaned up
    ws.close()
    await new Promise<void>((resolve) => ws.on('close', () => resolve()))

    // Allow the server-side socket close event and unsubscribe to complete
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(fanOutManager.getClientCount()).toBe(0)
    expect(fanOutManager.getPairClientCount('*')).toBe(0)
  })

  it('keeps normal client with slow but live connection connected', async () => {
    // Normal client responds to pings (standard ws client behavior)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // Expect client to stay connected across multiple ping intervals
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(fanOutManager.getClientCount()).toBe(1)

    ws.close()
    await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fanOutManager.getClientCount()).toBe(0)
  })

  it('closes and unregisters a client that stops responding to pings', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // Prevent client from answering pings by suppressing pong replies
        ws.pong = () => {}
        if ((ws as any)._receiver) {
          ;(ws as any)._receiver.onPing = () => {}
        }
        resolve()
      })
      ws.on('error', reject)
    })

    // Wait for client to miss consecutive pings and get closed
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve())
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Assert that the unresponsive client was closed and both internal maps cleaned up
    expect(fanOutManager.getClientCount()).toBe(0)
    expect(fanOutManager.getPairClientCount('*')).toBe(0)
  })
})