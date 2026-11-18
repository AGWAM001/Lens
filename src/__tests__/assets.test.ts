import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// Hoist mock functions before vi.mock calls
const {
  mockLoadAccount,
  mockAssetsCall,
  mockSsrfSafeFetch,
  mockAssertUrlSafe,
  mockGetCachedAsset,
  mockSetCachedAsset,
  mockDbFindMany,
} = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockAssetsCall: vi.fn(),
  mockSsrfSafeFetch: vi.fn(),
  mockAssertUrlSafe: vi.fn(),
  mockGetCachedAsset: vi.fn(),
  mockSetCachedAsset: vi.fn(),
  mockDbFindMany: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {
    pairConfig: {
      findMany: mockDbFindMany,
    },
  },
  pgPool: { query: vi.fn() },
}))

vi.mock('../redis', () => ({
  getCachedAsset: mockGetCachedAsset,
  setCachedAsset: mockSetCachedAsset,
  getCachedPrice: vi.fn().mockResolvedValue(null),
  setCachedPrice: vi.fn().mockResolvedValue(undefined),
  redis: { get: vi.fn(), set: vi.fn(), on: vi.fn() },
}))

vi.mock('../network/clients', () => ({
  getHorizonServer: vi.fn(() => ({
    loadAccount: mockLoadAccount,
    assets: () => ({
      forCode: () => ({
        forIssuer: () => ({
          call: mockAssetsCall,
        }),
      }),
    }),
  })),
  getRpcServer: vi.fn(),
  resetNetworkClients: vi.fn(),
}))

vi.mock('../net/ssrf', () => ({
  assertUrlSafe: mockAssertUrlSafe,
  ssrfSafeFetch: mockSsrfSafeFetch,
  SsrfError: class SsrfError extends Error {
    reason: string
    constructor(reason: string, message: string) {
      super(message)
      this.reason = reason
    }
  },
}))

import { registerNetworkSelector } from '../middleware/network'
import { registerCachePolicy } from '../middleware/cachePolicy'
import { registerAssetRoutes } from '../routes/assets'
import {
  clearAssetCache,
  resolveAssetMetadata,
  getTrackedAssets,
  STELLAR_TOML_MAX_SIZE,
} from '../services/assetMetadata'

const VALID_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const VALID_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const ANOTHER_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const SAMPLE_TOML = `
# stellar.toml sample
[DOCUMENTATION]
ORG_NAME = "Circle Internet Financial"

[[CURRENCIES]]
code = "USDC"
issuer = "${VALID_ISSUER}"
name = "USD Coin"
display_decimals = 7
contract_id = "${VALID_CONTRACT}"

[[CURRENCIES]]
code = "EURC"
issuer = "${VALID_ISSUER}"
name = "Euro Coin"
display_decimals = 7
`

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await app.register(registerCachePolicy)
  await registerAssetRoutes(app)
  await app.ready()
  return app
}

beforeEach(() => {
  clearAssetCache()
  mockLoadAccount.mockReset()
  mockAssetsCall.mockReset()
  mockSsrfSafeFetch.mockReset()
  mockAssertUrlSafe.mockReset().mockResolvedValue(undefined)
  mockGetCachedAsset.mockReset().mockResolvedValue(null)
  mockSetCachedAsset.mockReset().mockResolvedValue(undefined)
  mockDbFindMany.mockReset().mockResolvedValue([
    {
      network: 'testnet',
      assetACode: 'USDC',
      assetAIssuer: VALID_ISSUER,
      assetBCode: 'XLM',
      assetBIssuer: null,
    },
  ])
})

describe('Asset Metadata Service', () => {
  it('resolves native XLM synchronously as verified with stellar.org homeDomain', async () => {
    const meta = await resolveAssetMetadata({ code: 'XLM', issuer: null }, 'testnet')
    expect(meta.code).toBe('XLM')
    expect(meta.issuer).toBeNull()
    expect(meta.name).toBe('Stellar Lumens')
    expect(meta.homeDomain).toBe('stellar.org')
    expect(meta.domain).toBe('stellar.org')
    expect(meta.decimals).toBe(7)
    expect(meta.displayDecimals).toBe(7)
    expect(meta.status).toBe('verified')
    expect(meta.verified).toBe(true)
    expect(meta.contractId).toBeNull()
    expect(meta.tomlUrl).toBe('https://stellar.org/.well-known/stellar.toml')
    expect(meta.verification).toEqual({
      status: 'verified',
      verified: true,
      checkedAt: expect.any(String),
      tomlUrl: 'https://stellar.org/.well-known/stellar.toml',
    })
    expect(meta.provenance).toEqual({
      source: 'stellar-protocol',
      checkedAt: expect.any(String),
      tomlUrl: 'https://stellar.org/.well-known/stellar.toml',
      verified: true,
    })
    // Neither Horizon nor TOML fetch should have been touched
    expect(mockLoadAccount).not.toHaveBeenCalled()
    expect(mockSsrfSafeFetch).not.toHaveBeenCalled()
  })

  it('resolves an issued asset as verified when stellar.toml matches', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValueOnce({
      records: [
        {
          asset_code: 'USDC',
          asset_issuer: VALID_ISSUER,
          contract_id: VALID_CONTRACT,
        },
      ],
    })
    mockSsrfSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => SAMPLE_TOML,
    })

    const meta = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta.code).toBe('USDC')
    expect(meta.issuer).toBe(VALID_ISSUER)
    expect(meta.issuer?.length).toBe(56) // Not elided!
    expect(meta.name).toBe('USD Coin')
    expect(meta.homeDomain).toBe('circle.com')
    expect(meta.decimals).toBe(7)
    expect(meta.status).toBe('verified')
    expect(meta.verified).toBe(true)
    expect(meta.contractId).toBe(VALID_CONTRACT)
    expect(meta.contractId?.length).toBe(56) // Not elided!
    expect(meta.tomlUrl).toBe('https://circle.com/.well-known/stellar.toml')
    expect(meta.verification.status).toBe('verified')
    expect(meta.verification.verified).toBe(true)
    expect(meta.provenance.source).toBe('stellar-toml')
    expect(meta.dateChecked).toBeTruthy()
  })

  it('reports unverified (not an error) when issuer has no home_domain', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      // no home_domain set
    })
    mockAssetsCall.mockResolvedValueOnce({ records: [] })

    const meta = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta.status).toBe('unverified')
    expect(meta.verified).toBe(false)
    expect(meta.homeDomain).toBeNull()
    expect(meta.name).toBeNull()
    expect(meta.dateChecked).toBeTruthy()
    expect(meta.provenance.source).toBe('horizon')
    expect(mockSsrfSafeFetch).not.toHaveBeenCalled()
  })

  it('reports unverified (not an error) when stellar.toml returns 404', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValueOnce({ records: [] })
    mockSsrfSafeFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    })

    const meta = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta.status).toBe('unverified')
    expect(meta.verified).toBe(false)
    expect(meta.homeDomain).toBe('circle.com')
    expect(meta.dateChecked).toBeTruthy()
    expect(meta.verification.status).toBe('unverified')
  })

  it('reports unverified (not an error) when TOML fetch encounters network error or timeout', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValueOnce({ records: [] })
    mockSsrfSafeFetch.mockRejectedValueOnce(new Error('Network timeout'))

    const meta = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta.status).toBe('unverified')
    expect(meta.verified).toBe(false)
    expect(meta.homeDomain).toBe('circle.com')
    expect(meta.dateChecked).toBeTruthy()
  })

  it('reports unverified when stellar.toml does not list the requested currency', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValueOnce({ records: [] })
    mockSsrfSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => `
[[CURRENCIES]]
code = "OTHER"
issuer = "${VALID_ISSUER}"
`,
    })

    const meta = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta.status).toBe('unverified')
    expect(meta.verified).toBe(false)
  })

  it('reports unverified when stellar.toml lists the asset but under a different issuer', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValueOnce({ records: [] })
    mockSsrfSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => `
[[CURRENCIES]]
code = "USDC"
issuer = "${ANOTHER_ISSUER}"
`,
    })

    const meta = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta.status).toBe('unverified')
    expect(meta.verified).toBe(false)
  })

  it('reports unverified when stellar.toml exceeds maximum file size', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValueOnce({ records: [] })
    // Oversized response
    const largeBody = 'a'.repeat(STELLAR_TOML_MAX_SIZE + 100)
    mockSsrfSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => largeBody,
    })

    const meta = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta.status).toBe('unverified')
    expect(meta.verified).toBe(false)
  })

  it('caches metadata in-memory and in Redis with TTL', async () => {
    mockLoadAccount.mockResolvedValue({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValue({ records: [] })
    mockSsrfSafeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => SAMPLE_TOML,
    })

    // First resolution
    const meta1 = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta1.verified).toBe(true)
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1)
    expect(mockSetCachedAsset).toHaveBeenCalledWith(
      'testnet',
      `USDC:${VALID_ISSUER}`,
      expect.objectContaining({ code: 'USDC' }),
      3600,
    )

    // Second resolution: should hit in-memory cache without calling ssrfSafeFetch
    const meta2 = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta2).toEqual(meta1)
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1)

    // Clear in-memory cache but simulate Redis hit
    clearAssetCache()
    mockGetCachedAsset.mockResolvedValueOnce(JSON.stringify(meta1))
    const meta3 = await resolveAssetMetadata({ code: 'USDC', issuer: VALID_ISSUER }, 'testnet')
    expect(meta3.code).toBe('USDC')
    expect(meta3.verified).toBe(true)
    // ssrfSafeFetch still not called again
    expect(mockSsrfSafeFetch).toHaveBeenCalledTimes(1)
  })
})

describe('GET /assets', () => {
  it('returns list of tracked assets with network echoed and cache headers', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=3600')
    expect(res.headers['vary']).toBe('x-network')

    const body = res.json()
    expect(body.network).toBe('testnet')
    expect(Array.isArray(body.assets)).toBe(true)
    expect(body.assets.length).toBeGreaterThanOrEqual(1)

    // XLM must be present
    const xlm = body.assets.find((a: any) => a.code === 'XLM')
    expect(xlm).toBeDefined()
    expect(xlm.verified).toBe(true)
    expect(xlm.decimals).toBe(7)
  })

  it('echoes ?network=mainnet parameter and returns mainnet assets', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets?network=mainnet' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('mainnet')
  })

  it('rejects an invalid ?network= with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets?network=invalidnet' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('error')
  })

  it('filters tracked assets by ?code=', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets?code=xlm' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.assets.every((a: any) => a.code === 'XLM')).toBe(true)
  })

  it('filters tracked assets by ?verified=true', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets?verified=true' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.assets.every((a: any) => a.verified === true)).toBe(true)
  })

  it('never elides any issuer address in the response', async () => {
    mockLoadAccount.mockResolvedValue({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValue({ records: [] })
    mockSsrfSafeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => SAMPLE_TOML,
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets' })
    const body = res.json()
    for (const asset of body.assets) {
      if (asset.issuer !== null) {
        expect(asset.issuer).toMatch(/^G[A-Z2-7]{55}$/)
        expect(asset.issuer).not.toContain('…')
        expect(asset.issuer).not.toContain('...')
      }
    }
  })
})

describe('GET /assets/:code', () => {
  it('returns 200 for native XLM with verification and date checked', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets/XLM' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=3600')
    const body = res.json()
    expect(body.network).toBe('testnet')
    expect(body.code).toBe('XLM')
    expect(body.issuer).toBeNull()
    expect(body.homeDomain).toBe('stellar.org')
    expect(body.decimals).toBe(7)
    expect(body.status).toBe('verified')
    expect(body.verified).toBe(true)
    expect(body.dateChecked).toBeTruthy()
    expect(body.provenance.source).toBe('stellar-protocol')
  })

  it('supports alias /assets/native for native XLM', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets/native' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.code).toBe('XLM')
    expect(body.issuer).toBeNull()
  })

  it('returns 200 for verified issued asset with full metadata and unelided addresses', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValueOnce({
      records: [
        {
          asset_code: 'USDC',
          asset_issuer: VALID_ISSUER,
          contract_id: VALID_CONTRACT,
        },
      ],
    })
    mockSsrfSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => SAMPLE_TOML,
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/assets/USDC` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.code).toBe('USDC')
    expect(body.issuer).toBe(VALID_ISSUER)
    expect(body.issuer.length).toBe(56)
    expect(body.name).toBe('USD Coin')
    expect(body.homeDomain).toBe('circle.com')
    expect(body.decimals).toBe(7)
    expect(body.status).toBe('verified')
    expect(body.verified).toBe(true)
    expect(body.contractId).toBe(VALID_CONTRACT)
    expect(body.contractId.length).toBe(56)
    expect(body.dateChecked).toBeTruthy()
    expect(body.provenance).toMatchObject({
      source: 'stellar-toml',
      verified: true,
    })
  })

  it('returns 200 with unverified status (not 500) when issuer serves no toml', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      home_domain: 'broken-domain.org',
    })
    mockAssetsCall.mockResolvedValueOnce({ records: [] })
    mockSsrfSafeFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/assets/USDC` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.code).toBe('USDC')
    expect(body.status).toBe('unverified')
    expect(body.verified).toBe(false)
    expect(body.dateChecked).toBeTruthy()
    expect(body.provenance.verified).toBe(false)
  })

  it('returns 404 when asset cannot be found (saying when we cannot answer)', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/assets/NONEXISTENT' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toHaveProperty('error')
    expect(res.json().error).toContain('not found on testnet')
  })

  it('supports canonical CODE:ISSUER path format', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: VALID_ISSUER,
      home_domain: 'circle.com',
    })
    mockAssetsCall.mockResolvedValueOnce({ records: [] })
    mockSsrfSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => SAMPLE_TOML,
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/assets/USDC:${VALID_ISSUER}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.code).toBe('USDC')
    expect(body.issuer).toBe(VALID_ISSUER)
    expect(body.verified).toBe(true)
  })

  it('supports ?issuer= query parameter for ad-hoc valid issuer', async () => {
    mockLoadAccount.mockResolvedValueOnce({
      id: ANOTHER_ISSUER,
      home_domain: 'another.org',
    })
    mockAssetsCall.mockResolvedValueOnce({ records: [] })
    mockSsrfSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => `
[[CURRENCIES]]
code = "CUSTOM"
issuer = "${ANOTHER_ISSUER}"
name = "Custom Token"
display_decimals = 4
`,
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/assets/CUSTOM?issuer=${ANOTHER_ISSUER}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.code).toBe('CUSTOM')
    expect(body.issuer).toBe(ANOTHER_ISSUER)
    expect(body.name).toBe('Custom Token')
    expect(body.decimals).toBe(4)
    expect(body.verified).toBe(true)
  })
})
