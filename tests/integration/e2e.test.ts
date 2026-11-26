import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'

const COMPOSE_FILE = 'docker-compose.yml'
const API_URL = 'http://127.0.0.1:3002'
const PAIR_KEY = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM'

function run(command: string) {
  execSync(command, { stdio: 'inherit' })
}

function runCapture(command: string) {
  return execSync(command, { encoding: 'utf8' }).trim()
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForDbRows(pairKey: string, poolId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const priceCount = parseInt(runCapture(`docker compose -f ${COMPOSE_FILE} exec -T postgres psql -U lens -d lens -t -A -c "SELECT count(*) FROM price_points WHERE pair_key = '${pairKey}' AND source = 'AMM' AND pool_id = '${poolId}'"`), 10)
      const poolCount = parseInt(runCapture(`docker compose -f ${COMPOSE_FILE} exec -T postgres psql -U lens -d lens -t -A -c "SELECT count(*) FROM pool_snapshots WHERE pool_id = '${poolId}' AND id = 'test-snapshot-1'"`), 10)
      if (priceCount >= 1 && poolCount >= 1) return
    } catch {
      // retry until timeout
    }
    await sleep(1000)
  }
  throw new Error('Test rows were not visible in the database before querying Lens')
}

function clearPriceCache(pairKey: string) {
  run(`docker compose -f ${COMPOSE_FILE} exec -T redis redis-cli DEL "lens:price:${pairKey}"`)
}

async function waitForService(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/ready`)
      if (response.ok) return
    } catch {
      // retry
    }
    await sleep(2000)
  }
  throw new Error('Lens service did not become healthy in time')
}

// This suite spins up the full docker-compose stack (postgres + redis + Lens)
// and is far too heavy for the default `npm test` / CI build job, where no
// stack is running — `docker compose up --build` there just times out the hook.
// It is opt-in: set LENS_E2E=1 in an environment that has the stack available
// (e.g. a dedicated integration CI job). Otherwise the suite is skipped.
const runE2E = process.env.LENS_E2E === '1'

describe.skipIf(!runE2E)('Docker Compose end-to-end ingest → query', () => {
  beforeAll(async () => {
    run(`docker compose -f ${COMPOSE_FILE} down --volumes --remove-orphans`)
    run(`docker compose -f ${COMPOSE_FILE} up -d --build`)
    await waitForService()

    run(`docker compose -f ${COMPOSE_FILE} exec -T postgres psql -U lens -d lens -c "INSERT INTO price_points (id, asset_a, asset_b, pair_key, source, pool_id, price, base_volume, counter_volume, ledger, timestamp) VALUES ('test-price-point-1', 'XLM', 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', '${PAIR_KEY}', 'AMM', 'test-pool-1', '1.2345', '1000', '1234.5', 12345, now())"`)
    run(`docker compose -f ${COMPOSE_FILE} exec -T postgres psql -U lens -d lens -c "INSERT INTO pool_snapshots (id, pool_id, asset_a, asset_b, reserve_a, reserve_b, spot_price, total_shares, fee_bp, ledger, timestamp) VALUES ('test-snapshot-1', 'test-pool-1', 'XLM', 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', '10000', '12345', '1.2345', '100000', 30, 12345, now())"`)
    await waitForDbRows(PAIR_KEY, 'test-pool-1')
    clearPriceCache(PAIR_KEY)
    await sleep(2000)
  }, 180000)

  afterAll(() => {
    run(`docker compose -f ${COMPOSE_FILE} down --volumes --remove-orphans`)
  })

  it('starts Lens, ingests test market data, and returns query results', async () => {
    const response = await fetch(`${API_URL}/price/XLM/USDC`)
    const body = await response.json()
    console.log('E2E RESPONSE', { status: response.status, body })

    expect(response.ok).toBe(true)
    expect(body).toHaveProperty('assetA', 'XLM')
    expect(body).toHaveProperty('assetB', 'USDC')
    expect(body).toHaveProperty('pairKey', expect.stringContaining('USDC'))
    expect(body).toHaveProperty('price')
    expect(body.price).toBeGreaterThan(0)
    expect(body).toHaveProperty('ammPrice')
    expect(body.ammPrice).toBeGreaterThan(0)
    expect(['SDEX', 'AMM', 'SPLIT', 'UNKNOWN']).toContain(body.bestRoute)
  })
})
