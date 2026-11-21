import Fastify from 'fastify'
import WebSocket from 'ws'

async function run() {
  // Disable x402 payment gating for smoke test runs. Must set before importing server module.
  process.env.ORACLE_PAYMENT_ADDRESS = ''

  const { registerWebSocket } = await import('../src/api/websocket')
  const { priceEmitter, PRICE_PUBLISHED, publishPriceUpdate } = await import('../src/events')
  const { fanOutManager } = await import('../src/ws/fanout')
  const { activeNetwork } = await import('../src/config')

  const app = Fastify({ logger: { level: 'info' } })
  await registerWebSocket(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  // @ts-ignore
  const addr = app.server.address() as any
  const port = addr.port

  console.log(`[ws-smoke] Server listening on port ${port}`)

  const before = priceEmitter.listenerCount(PRICE_PUBLISHED)
  await fanOutManager.initialize()

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

  const open = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 5000)
    ws.on('open', () => { clearTimeout(t); resolve() })
    ws.on('error', (err) => { clearTimeout(t); reject(err) })
  })
  await open
  console.log('[ws-smoke] WebSocket connected')

  const firstMsg = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no initial message')), 5000)
    ws.once('message', (data) => { clearTimeout(t); resolve(data.toString()) })
  })
  console.log('[ws-smoke] initial message:', firstMsg)
  const first = JSON.parse(firstMsg)
  if (first.type !== 'status' && first.type !== 'error') throw new Error('expected status or error message')

  if (priceEmitter.listenerCount(PRICE_PUBLISHED) !== before + 1) {
    throw new Error('server did not register price listener')
  }

  const event = {
    pair: 'USDC/XLM',
    price: 1.2345,
    ts: new Date().toISOString(),
    network: activeNetwork,
  }

  const nextMsg = new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no price update received')), 5000)
    ws.once('message', (data) => { clearTimeout(t); resolve(data.toString()) })
  })

  publishPriceUpdate(event)
  const nextRaw = await nextMsg
  console.log('[ws-smoke] price message:', nextRaw)
  const next = JSON.parse(nextRaw)
  if (next.type !== 'price_update') throw new Error('expected price_update')
  if (next.price !== event.price) throw new Error('price mismatch')
  if (next.network !== event.network) throw new Error('network mismatch')

  ws.close()
  await new Promise<void>((resolve) => ws.on('close', () => resolve()))

  await fanOutManager.destroy()
  if (priceEmitter.listenerCount(PRICE_PUBLISHED) !== before) {
    throw new Error('listener was not cleaned up after shutdown')
  }

  await app.close()
  console.log('[ws-smoke] Success')
}

run().catch(err => {
  console.error('[ws-smoke] Failed:', err)
  process.exitCode = 1
})
