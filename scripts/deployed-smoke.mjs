#!/usr/bin/env node
import WebSocket from 'ws'

const base = process.argv[2]
const maxAge = Number(process.env.SMOKE_MAX_AGE_SECONDS ?? 120)
const timeout = Number(process.env.SMOKE_TIMEOUT_MS ?? 8000)
if (!base || !/^https?:\/\//.test(base) || !Number.isFinite(maxAge) || maxAge <= 0 || !Number.isFinite(timeout) || timeout <= 0) {
  console.error('Usage: npm run smoke -- http://localhost:3002 [SMOKE_MAX_AGE_SECONDS=120 SMOKE_TIMEOUT_MS=8000]')
  process.exit(2)
}
const url = new URL(base.endsWith('/') ? base : base + '/')
const check = async (name, fn) => {
  try {
    await fn()
    console.log('PASS ' + name)
  } catch (error) {
    console.error('FAIL ' + name + ': ' + error.message)
    throw error
  }
}
async function getJson(path) {
  const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return response.json()
}
function fresh(age) {
  if (typeof age !== 'number' || !Number.isFinite(age) || age < 0 || age > maxAge) throw new Error('stale or missing age: ' + age)
}
async function websocketRoundTrip(pairKey, network) {
  const target = new URL('graphql', url)
  target.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(target, 'graphql-transport-ws', { handshakeTimeout: timeout })
  let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('subscription timed out')), timeout)
      let acknowledged = false
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })))
      ws.on('error', reject)
      ws.on('close', () => reject(new Error('socket closed before price update')))
      ws.on('message', data => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'connection_ack' && !acknowledged) {
            acknowledged = true
            ws.send(JSON.stringify({ id: 'smoke', type: 'subscribe', payload: {
              query: 'subscription ($pair: String!, $network: String) { priceUpdated(pair: $pair, network: $network) { pair price ts network } }',
              variables: { pair: pairKey, network }
            } }))
          } else if (msg.type === 'next' && msg.id === 'smoke') {
            const value = msg.payload?.data?.priceUpdated
            if (value?.pair !== pairKey || value?.network !== network || !Number.isFinite(Number(value.price)) || Number(value.price) <= 0) throw new Error('invalid subscription payload')
            const age = (Date.now() - new Date(value.ts).getTime()) / 1000
            fresh(age)
            resolve()
          } else if (msg.type === 'error') {
            reject(new Error(JSON.stringify(msg.payload)))
          }
        } catch (error) { reject(error) }
      })
    })
  } finally {
    clearTimeout(timer)
    ws.terminate()
  }
}
let pairKey
let network
try {
  await check('/status + live ingester', async () => {
    const data = await getJson('status')
    if (data.ok !== true) throw new Error('not healthy')
    fresh(data.ingestLagSeconds)
  })
  await check('/ready + /live', async () => {
    const response = await fetch(new URL('ready', url), { signal: AbortSignal.timeout(timeout) })
    if (response.status === 404) {
      throw new Error('GET /ready returned 404 — the readiness probe is missing (#334)')
    }
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const data = await response.json()
    if (data.ok !== true) throw new Error('not ready: ' + JSON.stringify(data.checks))
    // Liveness must stay independent of the dependencies. If it ever starts
    // failing alongside them, a database blip would take every instance's
    // restart button at once.
    const live = await fetch(new URL('live', url), { signal: AbortSignal.timeout(timeout) })
    if (!live.ok) throw new Error('GET /live returned HTTP ' + live.status)
  })
  await check('/price/XLM/USDC + freshness', async () => {
    const data = await getJson('price/XLM/USDC')
    if (data.assetA !== 'XLM' || data.assetB !== 'USDC' || typeof data.price !== 'number' || !Number.isFinite(data.price) || data.price <= 0) throw new Error('invalid price response')
    if (data.stale !== false) throw new Error('price flagged stale')
    if (typeof data.pairKey !== 'string' || !data.pairKey) throw new Error('missing pairKey')
    pairKey = data.pairKey
    if (!['mainnet', 'testnet'].includes(data.network)) throw new Error('invalid network')
    network = data.network
    fresh(data.lastTradeAgeSeconds)
  })
  await check('GraphQL websocket subscription + live update', () => websocketRoundTrip(pairKey, network))
} catch {
  process.exitCode = 1
}
