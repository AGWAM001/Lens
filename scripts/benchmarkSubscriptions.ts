/**
 * Subscription fan-out benchmark for the GraphQL `priceUpdated` surface.
 *
 * Drives a real mercurius server over real `graphql-transport-ws` sockets —
 * the same shape src/__tests__/graphqlSubscription.test.ts uses — with
 * SUBSCRIBERS_PER_PAIR subscribers per (pair, network), then publishes
 * EVENTS_PER_PAIR updates for every (pair, network) and measures how long the
 * whole fan-out takes until every subscriber has received exactly the events
 * it asked for.
 *
 * What the numbers isolate: with the single broadcast topic every subscriber
 * is woken by every event and a JS filter decides (subscribers x events
 * wake-ups); with pair+network-keyed topics the pubsub layer routes first and
 * only the subscribers of that pair+network wake. Both designs deliver
 * identical data, so the wall-clock per publish batch is a direct comparison
 * of the routing work each design does per event.
 *
 * Usage: npx tsx scripts/benchmarkSubscriptions.ts
 */
import { AddressInfo } from 'net'
import WebSocket from 'ws'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGraphQL } from '../src/api/graphql'
import { publishPriceUpdate } from '../src/events'

// The sandbox caps open file descriptors at 1024, and every WS connection
// holds one client fd plus one server fd — so past roughly 500 concurrent
// sockets the server cannot accept new connections and the numbers become
// garbage. 20 subscribers per pair across 10 pairs x 2 networks = 400
// subscriptions, which runs fully and cleanly; that is a representative
// fan-out shape (every subscriber watches exactly one pair of one network).
const MODE = process.env.BENCH_MODE ?? 'unlabelled'
const SUBSCRIBERS_PER_PAIR = Number(process.env.BENCH_SUBSCRIBERS_PER_PAIR ?? 20)
const EVENTS_PER_PAIR = Number(process.env.BENCH_EVENTS_PER_PAIR ?? 200)

// Ten pairs with real Stellar asset-code shapes; the counts are synthetic.
const PAIRS = [
  'XLM/USDC', 'BTC/USDC', 'ETH/USDC', 'XRP/USDC', 'SOL/USDC',
  'DOT/USDC', 'AAVE/USDC', 'AVAX/USDC', 'LINK/USDC', 'TRX/USDC',
]
// Subscriptions are network-scoped here — the production shape, where a
// listener watches one chain. The dual-network event feed is what makes the
// old single-topic fan-out pay twice for every pair's subscribers.
const NETWORKS = ['mainnet', 'testnet']
const SUBPROTOCOL = 'graphql-transport-ws'

const SUBSCRIBE_QUERY = `
  subscription($pair: String!, $network: String) {
    priceUpdated(pair: $pair, network: $network) { pair price ts network }
  }
`

interface SocketState {
  ws: WebSocket
  pair: string
  network: string
  received: number
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
        // Swallow resets during teardown — the benchmark's job is fan-out
        // cost, and a socket dying during close() must not crash the runner.
        ws.on('error', () => {})
        resolve(ws)
      }
    })
    setTimeout(() => reject(new Error('connect timeout: no ack in 10s')), 10_000)
  })
}

async function runBenchmark() {
  const app: FastifyInstance = Fastify({ logger: false })
  await registerGraphQL(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  // A benchmark pushing 200k WS messages through 2k sockets makes the kernel
  // reset some connections part-way; those resets are transport noise, and
  // must not crash the runner. Production wiring (app.ts) installs its own
  // socket handling; this script runs the subscription surface standalone.
  process.on('unhandledRejection', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'ECONNRESET') return
    console.error('unhandledRejection:', err)
    process.exit(1)
  })
  app.server.on('connection', socket => socket.on('error', () => {}))
  const { port } = app.server.address() as AddressInfo
  const url = `ws://127.0.0.1:${port}/graphql`

  const subscribers = SUBSCRIBERS_PER_PAIR * PAIRS.length * NETWORKS.length
  const states: SocketState[] = []

  const connectStart = Date.now()
  console.error(`[bench] connecting ${subscribers} sockets ...`)
  await Promise.all(
    Array.from({ length: SUBSCRIBERS_PER_PAIR }, async (_, withinPair) => {
      await Promise.all(
        PAIRS.flatMap(async pair =>
          NETWORKS.map(async network => {
            const ws = await connect(url)
            const state: SocketState = { ws, pair, network, received: 0 }
            ws.on('message', raw => {
              const msg = JSON.parse(raw.toString())
              if (msg.type === 'next' && msg.id === '1') {
                const update = msg.payload?.data?.priceUpdated
                if (!update) return
                if (update.pair !== state.pair || update.network !== state.network) {
                  throw new Error(
                    `routing bug: ${state.pair}@${state.network} subscriber got ${update.pair}@${update.network}`
                  )
                }
                state.received++
              }
            })
            ws.send(JSON.stringify({
              id: '1',
              type: 'subscribe',
              payload: { query: SUBSCRIBE_QUERY, variables: { pair, network } },
            }))
            states.push(state)
          })
        )
      )
    })
  )
  const connectMs = Date.now() - connectStart
  console.error(`[bench] connected in ${connectMs}ms; subscribing ...`)

  // Give the server time to register every subscription before publishing —
  // the benchmark measures fan-out cost, not race slop.
  await new Promise(r => setTimeout(r, 1000))
  console.error('[bench] subscribing done; publishing ...')

  const expectedPerState = EVENTS_PER_PAIR
  const start = process.hrtime.bigint()
  for (let i = 0; i < EVENTS_PER_PAIR; i++) {
    for (const pair of PAIRS) {
      for (const network of NETWORKS) {
        publishPriceUpdate({ pair, price: 1 + i, ts: new Date().toISOString(), network })
      }
    }
    // Yield so every 20 events the socket buffers can drain: a macrotimer
    // (not a microtask) is what lets node pause under kernel backpressure.
    // An unbroken burst would measure the transport, not the routing, and the
    // same pacing applies to both designs, so the comparison stays fair.
    if ((i + 1) % 20 === 0) await new Promise(resolve => setTimeout(resolve, 5))
  }
  await new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (states.every(s => s.received >= expectedPerState)) {
        clearInterval(poll)
        resolve()
      }
    }, 5)
    setTimeout(() => {
      clearInterval(poll)
      const incomplete = states.filter(s => s.received < expectedPerState).length
      const counts = states.map(s => s.received)
      const histogram: Record<string, number> = {}
      for (const c of counts) histogram[String(c)] = (histogram[String(c)] ?? 0) + 1
      console.error(`[bench] TIMEOUT: ${incomplete}/${states.length} sockets short`)
      console.error('[bench] distribution of received-per-socket:', JSON.stringify(histogram))
      reject(new Error('timeout waiting for every delivery'))
    }, 60_000)
  })
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000

  let delivered = 0
  for (const state of states) delivered += state.received
  for (const state of states) state.ws.close(1000)
  await app.close()

  console.log(JSON.stringify({
    mode: MODE,
    subscribers,
    pairs: PAIRS.length,
    eventsPublished: PAIRS.length * NETWORKS.length * EVENTS_PER_PAIR,
    expectedDeliveries: subscribers * expectedPerState,
    delivered,
    publishAndDeliverMs: Math.round(elapsedMs * 100) / 100,
    deliveriesPerSecond: Math.round((delivered / elapsedMs) * 1000),
    connectMs,
  }, null, 2))
}

runBenchmark().catch(err => {
  console.error('benchmark failed:', err)
  process.exitCode = 1
})
