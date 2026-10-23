import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  loadOpenApiSpec,
  buildSpecAjv,
  resolveTestRequest,
  getResponseSchema,
  validateResponseAgainstSchema,
  checkResponseAgainstSpec,
  formatMarkdownReport,
  postOrUpdateGitHubReport,
  type ValidationSummary,
} from '../openapi/liveValidator'

describe('Live Spec Validator', () => {
  const spec = loadOpenApiSpec()
  const ajv = buildSpecAjv(spec)

  describe('Route and Request Resolution', () => {
    it('loads openapi.yaml and finds paths', () => {
      expect(spec).toBeDefined()
      expect(spec.paths).toBeDefined()
      expect(Object.keys(spec.paths).length).toBeGreaterThan(20)
    })

    it('resolves parameterized path templates into valid test URLs', () => {
      const priceReq = resolveTestRequest('/price/{assetA}/{assetB}', 'get')
      expect(priceReq.urlPath).toBe('/price/XLM/USDC')
      expect(priceReq.method).toBe('GET')

      const routeReq = resolveTestRequest('/price/{assetA}/{assetB}/route', 'get')
      expect(routeReq.urlPath).toBe('/price/XLM/USDC/route?amount=100')

      const benchmarkReq = resolveTestRequest('/benchmark/{asset}', 'get')
      expect(benchmarkReq.urlPath).toBe('/benchmark/XLM?target=USD')

      const basketReq = resolveTestRequest('/basket', 'get')
      expect(basketReq.urlPath).toBe('/basket?asset=XLM&weight=1')
    })

    it('supplies appropriate request bodies for POST operations', () => {
      const gqlReq = resolveTestRequest('/graphql', 'post')
      expect(gqlReq.method).toBe('POST')
      expect(gqlReq.body).toContain('__typename')

      const webhookReq = resolveTestRequest('/webhooks', 'post')
      expect(webhookReq.method).toBe('POST')
      expect(JSON.parse(webhookReq.body!)).toMatchObject({
        url: 'https://example.com/webhook',
        assetA: 'XLM',
        assetB: 'USDC',
      })
    })

    it('resolves response schemas from operations', () => {
      const statusOp = spec.paths['/status'].get
      const statusSchema = getResponseSchema(statusOp, 200)
      expect(statusSchema).toBeDefined()
      expect(statusSchema.properties?.ok).toBeDefined()
    })
  })

  describe('Schema Conformance & Deliberate Mismatch Detection', () => {
    it('validates a schema-conforming response payload as valid', () => {
      const validStatus = {
        ok: true,
        network: 'testnet',
        watchedPairs: ['XLM:native/USDC:GBBD'],
        lastIndexedLedger: 1000,
        lastProcessedAt: '2026-10-16T10:00:00Z',
        ingestLagSeconds: 2,
      }

      const result = checkResponseAgainstSpec(ajv, spec, '/status', 'get', 200, validStatus)
      expect(result.valid).toBe(true)
      expect(result.errors).toBeUndefined()
    })

    it('detects a deliberate schema mismatch: invalid field type', () => {
      // In AggregatedPrice, 'price' allows number or string, so we deliberately pass a boolean
      const mismatchedPrice = {
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'XLM/USDC',
        price: true,
        sdexPrice: 0.12,
        ammPrice: 0.12,
        bestRoute: 'SDEX',
        volume24h: 1000,
        sdexVolume24h: 500,
        ammVolume24h: 500,
        vwap1m: 0.12,
        vwap5m: 0.12,
        vwap1h: 0.12,
        vwap24h: 0.12,
        priceChange24h: 0.01,
        lastUpdated: '2026-10-16T12:00:00Z',
        sources: 2,
        confidence: 'high',
      }

      const result = checkResponseAgainstSpec(
        ajv,
        spec,
        '/price/{assetA}/{assetB}',
        'get',
        200,
        mismatchedPrice
      )

      expect(result.valid).toBe(false)
      expect(result.errors).toBeDefined()
      expect(result.errors!.length).toBeGreaterThan(0)

      const priceError = result.errors!.find(e => e.path === '/price')
      expect(priceError).toBeDefined()
      expect(priceError!.keyword).toBe('type')
      expect(priceError!.message).toContain('must be number')
    })

    it('detects a deliberate schema mismatch: invalid enum value', () => {
      const invalidEnumPrice = {
        assetA: 'XLM',
        assetB: 'USDC',
        pairKey: 'XLM/USDC',
        price: 0.15,
        sdexPrice: 0.15,
        ammPrice: 0.15,
        bestRoute: 'SOME_NONEXISTENT_ROUTE', // Invalid enum
        volume24h: 1000,
        sdexVolume24h: 500,
        ammVolume24h: 500,
        vwap1m: 0.15,
        vwap5m: 0.15,
        vwap1h: 0.15,
        vwap24h: 0.15,
        priceChange24h: 0,
        lastUpdated: '2026-10-16T12:00:00Z',
        sources: 2,
        confidence: 'high',
      }

      const result = checkResponseAgainstSpec(
        ajv,
        spec,
        '/price/{assetA}/{assetB}',
        'get',
        200,
        invalidEnumPrice
      )

      expect(result.valid).toBe(false)
      const enumError = result.errors!.find(e => e.path === '/bestRoute')
      expect(enumError).toBeDefined()
      expect(enumError!.keyword).toBe('enum')
    })

    it('detects a deliberate schema mismatch: missing required property', () => {
      // SpreadResponse requires: asset, network, window, startTime, endTime, venues, tightest
      const missingRequired = {
        asset: 'XLM',
        network: 'testnet',
        window: '5m',
        // missing startTime, endTime, venues, tightest
      }

      const result = checkResponseAgainstSpec(
        ajv,
        spec,
        '/spreads/{asset}',
        'get',
        200,
        missingRequired
      )

      expect(result.valid).toBe(false)
      const reqErrors = result.errors!.filter(e => e.keyword === 'required')
      expect(reqErrors.length).toBeGreaterThan(0)
    })
  })

  describe('Report Formatting', () => {
    it('formats a clean Markdown report with metrics and mismatch details', () => {
      const summary: ValidationSummary = {
        timestamp: '2026-10-16T12:00:00Z',
        baseUrl: 'https://lens.stellar.org',
        totalDocumented: 25,
        checked: 24,
        valid: 23,
        mismatched: 1,
        unreachable: 0,
        results: [
          {
            path: '/status',
            method: 'get',
            resolvedUrl: '/status',
            status: 200,
            valid: true,
            skipped: false,
            durationMs: 45,
          },
          {
            path: '/price/{assetA}/{assetB}',
            method: 'get',
            resolvedUrl: '/price/XLM/USDC',
            status: 200,
            valid: false,
            skipped: false,
            errors: [
              {
                path: '/price',
                keyword: 'type',
                message: 'must be number',
              },
            ],
            durationMs: 120,
          },
        ],
      }

      const md = formatMarkdownReport(summary)
      expect(md).toContain('Live Service Spec Drift Report')
      expect(md).toContain('https://lens.stellar.org')
      expect(md).toContain('Schema Mismatches Detected (1)')
      expect(md).toContain('/price')
      expect(md).toContain('must be number')
      expect(md).toContain('/status')
      expect(md).toContain('VALID')
    })
  })

  describe('Single-Issue Update Logic', () => {
    it('appends to existing tracking issue rather than creating duplicates', async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock

      // Mock finding an existing issue
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ number: 99, title: 'Live Service Spec Drift Report' }],
        }) // Search call
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 101 }) }) // Post comment
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 99 }) }) // Update body

      const res = await postOrUpdateGitHubReport('# Test Report', {
        token: 'fake-token',
        repo: 'Divinity-Labs/Lens',
      })

      expect(res.action).toBe('appended')
      expect(res.issueNumber).toBe(99)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('creates a new tracking issue only when no existing report issue exists', async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock

      // Mock empty search results
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        }) // Search call returns empty
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ number: 150 }),
        }) // Create issue call

      const res = await postOrUpdateGitHubReport('# Test Report', {
        token: 'fake-token',
        repo: 'Divinity-Labs/Lens',
      })

      expect(res.action).toBe('created')
      expect(res.issueNumber).toBe(150)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })
})
