import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'

async function scenario({ stale = false, invalidPrice = false, noUpdate = false, readiness = true, missingReady = false, liveness = true } = {}) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/status') res.end(JSON.stringify({ ok: true, ingestLagSeconds: stale ? 900 : 1 }))
    else if (req.url === '/ready') { res.statusCode = missingReady ? 404 : readiness ? 200 : 503; res.end(JSON.stringify({ ok: readiness, booted: readiness, checks: { postgres: { status: readiness ? 'up' : 'down' }, redis: { status: 'up' } } })) }
    else if (req.url === '/live') { res.statusCode = liveness ? 200 : 503; res.end(JSON.stringify({ ok: liveness, uptimeSeconds: 42 })) }
    else if (req.url === '/price/XLM/USDC') res.end(JSON.stringify({
      assetA: 'XLM', assetB: 'USDC', pairKey: 'test-fixture-pair', network: 'testnet', price: invalidPrice ? '1.0' : 1,
      stale: false, lastTradeAgeSeconds: 1
    }))
    else { res.statusCode = 404; res.end('{}') }
  })
  const wss = new WebSocketServer({ server, path: '/graphql', handleProtocols: protocols => protocols.has('graphql-transport-ws') ? 'graphql-transport-ws' : false })
  wss.on('connection', ws => ws.on('message', msg => {
    const data = JSON.parse(msg.toString())
    if (data.type === 'connection_init') ws.send(JSON.stringify({ type: 'connection_ack' }))
    else if (data.type === 'subscribe' && !noUpdate) ws.send(JSON.stringify({
      id: data.id, type: 'next', payload: { data: { priceUpdated: {
        pair: 'test-fixture-pair', network: 'testnet', price: 1, ts: new Date().toISOString()
      } } }
    }))
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const child = spawn(process.execPath, ['scripts/deployed-smoke.mjs', 'http://127.0.0.1:' + port], {
      env: { ...process.env, SMOKE_TIMEOUT_MS: '3000' }
    })
    let output = ''
    for await (const chunk of child.stdout) output += chunk
    for await (const chunk of child.stderr) output += chunk
    const code = await new Promise(resolve => child.on('close', resolve))
    return { code, output }
  } finally {
    for (const client of wss.clients) client.terminate()
    await new Promise(resolve => wss.close(resolve))
    await new Promise(resolve => server.close(resolve))
  }
}

test('passes when all deployed checks pass', async () => {
  const result = await scenario()
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /PASS GraphQL websocket/)
})
test('rejects stale ingester', async () => {
  const result = await scenario({ stale: true })
  assert.equal(result.code, 1)
  assert.match(result.output, /FAIL \/status/)
})
test('rejects malformed price', async () => {
  const result = await scenario({ invalidPrice: true })
  assert.equal(result.code, 1)
  assert.match(result.output, /FAIL \/price/)
})
test('fails when /ready is missing', async () => {
  // The probe skipping itself when absent is exactly how a deployment ends up
  // silently unmonitored: the smoke run stays green and nothing checks whether
  // instances are receiving traffic they can serve.
  const result = await scenario({ missingReady: true })
  assert.equal(result.code, 1)
  assert.match(result.output, /FAIL \/ready \+ \/live/)
  assert.match(result.output, /missing/i)
})
test('rejects readiness outage', async () => {
  const result = await scenario({ readiness: false })
  assert.equal(result.code, 1)
  assert.match(result.output, /FAIL \/ready \+ \/live/)
})
test('rejects a failing liveness probe', async () => {
  // Liveness is the restart signal. If it can fail, the platform restarts
  // instances that were merely degraded.
  const result = await scenario({ liveness: false })
  assert.equal(result.code, 1)
  assert.match(result.output, /FAIL \/ready \+ \/live/)
})
test('rejects websocket silence', async () => {
  const result = await scenario({ noUpdate: true })
  assert.equal(result.code, 1)
  assert.match(result.output, /subscription timed out/)
})
