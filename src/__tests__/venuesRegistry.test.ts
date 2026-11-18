import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getEnabledAdapters,
  registeredVenues,
  sdexAdapter,
  ammAdapter,
  soroswapAdapter,
  aquariusAdapter,
  defindexAdapter,
  phoenixAdapter,
  kucoinAdapter,
  gateioAdapter,
} from '../ingest/venues'

describe('Venue Adapter Registry (Configuration-driven)', () => {
  const origKuCoinKey = process.env.KUCOIN_API_KEY
  const origGateioKey = process.env.GATEIO_API_KEY

  beforeEach(() => {
    delete process.env.KUCOIN_API_KEY
    delete process.env.GATEIO_API_KEY
  })

  afterEach(() => {
    if (origKuCoinKey !== undefined) process.env.KUCOIN_API_KEY = origKuCoinKey
    else delete process.env.KUCOIN_API_KEY
    if (origGateioKey !== undefined) process.env.GATEIO_API_KEY = origGateioKey
    else delete process.env.GATEIO_API_KEY
  })

  it('contains all candidate adapters in registeredVenues', () => {
    const adapters = registeredVenues.map(r => r.adapter)
    expect(adapters).toContain(sdexAdapter)
    expect(adapters).toContain(ammAdapter)
    expect(adapters).toContain(soroswapAdapter)
    expect(adapters).toContain(aquariusAdapter)
    expect(adapters).toContain(defindexAdapter)
    expect(adapters).toContain(phoenixAdapter)
    expect(adapters).toContain(kucoinAdapter)
    expect(adapters).toContain(gateioAdapter)
  })

  it('returns only adapters whose credentials are present (skips unconfigured CEX venues)', () => {
    const enabled = getEnabledAdapters()
    expect(enabled).toContain(sdexAdapter)
    expect(enabled).toContain(ammAdapter)
    expect(enabled).toContain(soroswapAdapter)
    expect(enabled).toContain(aquariusAdapter)
    expect(enabled).toContain(defindexAdapter)
    expect(enabled).toContain(phoenixAdapter)
    expect(enabled).not.toContain(kucoinAdapter)
    expect(enabled).not.toContain(gateioAdapter)
    expect(enabled.length).toBe(6)
  })

  it('enables KuCoin adapter when KUCOIN_API_KEY is present', () => {
    process.env.KUCOIN_API_KEY = 'test-kucoin-key'
    const enabled = getEnabledAdapters()
    expect(enabled).toContain(kucoinAdapter)
    expect(enabled).not.toContain(gateioAdapter)
    expect(enabled.length).toBe(7)
  })

  it('enables Gate.io adapter when GATEIO_API_KEY is present', () => {
    process.env.GATEIO_API_KEY = 'test-gateio-key'
    const enabled = getEnabledAdapters()
    expect(enabled).toContain(gateioAdapter)
    expect(enabled).not.toContain(kucoinAdapter)
    expect(enabled.length).toBe(7)
  })

  it('fault isolation: missing credentials for KuCoin does not prevent Gate.io from running', () => {
    delete process.env.KUCOIN_API_KEY
    process.env.GATEIO_API_KEY = 'test-gateio-key'

    const enabled = getEnabledAdapters()
    expect(enabled).toContain(gateioAdapter)
    expect(enabled).not.toContain(kucoinAdapter)
    expect(enabled.length).toBe(7)
  })

  it('enables all adapters when credentials for all venues are present', () => {
    process.env.KUCOIN_API_KEY = 'test-kucoin-key'
    process.env.GATEIO_API_KEY = 'test-gateio-key'

    const enabled = getEnabledAdapters()
    expect(enabled).toContain(kucoinAdapter)
    expect(enabled).toContain(gateioAdapter)
    expect(enabled.length).toBe(8)
  })
})
