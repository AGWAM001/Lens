import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.mock('../db', () => ({
  pgPool: {
    query: vi.fn().mockResolvedValue({
      rows: [{ last_ledger: 1000, last_time: new Date() }],
    }),
  },
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { buildApp } from '../app'
import {
  classifyRoute,
  parseOrigins,
  isOriginAllowed,
} from '../cors'

describe('CORS route classification', () => {
  it('classifies admin paths as admin', () => {
    expect(classifyRoute('/admin/keys')).toBe('admin')
    expect(classifyRoute('/admin/keys/123')).toBe('admin')
    expect(classifyRoute('/admin/usage')).toBe('admin')
    expect(classifyRoute('/admin/usage/key-1')).toBe('admin')
    expect(classifyRoute('/admin/keys?foo=bar')).toBe('admin')
  })

  it('classifies /usage/me as credentialed', () => {
    expect(classifyRoute('/usage/me')).toBe('credentialed')
    expect(classifyRoute('/usage/me?network=testnet')).toBe('credentialed')
  })

  it('classifies requests carrying Authorization headers as credentialed', () => {
    expect(classifyRoute('/status', { authorization: 'Bearer lens_123' })).toBe('credentialed')
    expect(classifyRoute('/price/XLM/USDC', { authorization: 'Bearer lens_123' })).toBe('credentialed')
  })

  it('classifies preflight requesting Authorization header as credentialed', () => {
    expect(
      classifyRoute('/price/XLM/USDC', {
        'access-control-request-headers': 'Content-Type, Authorization',
      })
    ).toBe('credentialed')
  })

  it('classifies public read routes as public', () => {
    expect(classifyRoute('/status')).toBe('public')
    expect(classifyRoute('/metrics')).toBe('public')
    expect(classifyRoute('/price/XLM/USDC')).toBe('public')
    expect(classifyRoute('/candles/XLM/USDC')).toBe('public')
    expect(classifyRoute('/discovery/resources')).toBe('public')
    expect(classifyRoute('/supported')).toBe('public')
  })

  it('classifies a percent-encoded admin path as admin, not public', () => {
    // The router decodes before matching, so this reaches /admin/keys. A
    // raw-string prefix test would call it public and hand an admin route the
    // open policy.
    expect(classifyRoute('/%61dmin/keys')).toBe('admin')
    expect(classifyRoute('/%2561dmin/keys')).toBe('admin')
  })

  it('refuses a bare wildcard for credentialed and admin, but allows it for public', () => {
    // '*' echoed as Access-Control-Allow-Origin alongside credentials: true is
    // a policy nobody means to write — any site could drive an authenticated
    // cross-origin call with the browser's credentials attached.
    expect(isOriginAllowed('https://evil.example', ['*'], false)).toBe(false)
    expect(isOriginAllowed('https://evil.example', ['*'], true)).toBe(true)
  })

  it('requires a wildcard entry to match the scheme it names', () => {
    // 'https://*.example.com' must not admit a plaintext origin.
    expect(isOriginAllowed('http://app.example.com', ['https://*.example.com'])).toBe(false)
    expect(isOriginAllowed('https://app.example.com', ['https://*.example.com'])).toBe(true)
    // A scheme-less entry matches either scheme, as written.
    expect(isOriginAllowed('http://app.example.com', ['*.example.com'])).toBe(true)
  })

  it('rejects an unparseable origin rather than matching it', () => {
    expect(isOriginAllowed('not a url', ['*.example.com'])).toBe(false)
  })
})

describe('parseOrigins and isOriginAllowed', () => {
  it('parses comma-separated origins', () => {
    expect(parseOrigins('https://example.com, https://lens.org')).toEqual([
      'https://example.com',
      'https://lens.org',
    ])
    expect(parseOrigins('')).toEqual([])
    expect(parseOrigins(undefined)).toEqual([])
  })

  it('matches exact origins case-insensitively', () => {
    const allowed = ['https://App.Lens.Org', 'http://localhost:3000']
    expect(isOriginAllowed('https://app.lens.org', allowed)).toBe(true)
    expect(isOriginAllowed('http://localhost:3000', allowed)).toBe(true)
    expect(isOriginAllowed('https://evil.com', allowed)).toBe(false)
  })

  it('handles wildcard origins', () => {
    expect(isOriginAllowed('https://any.com', ['*'])).toBe(true)
    expect(isOriginAllowed('https://sub.lens.org', ['*.lens.org'])).toBe(true)
    expect(isOriginAllowed('https://other.com', ['*.lens.org'])).toBe(false)
  })
})

describe('Split CORS policy integration', () => {
  let app: FastifyInstance
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env.ADMIN_TOKEN = 'test-admin-secret'
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.lens.org,https://portal.lens.org'
  })

  afterEach(async () => {
    await app?.close()
    process.env = { ...ORIGINAL_ENV }
  })

  describe('Public reads class', () => {
    it('allows any origin on public reads with credentials: false', async () => {
      app = await buildApp()
      await app.ready()

      const res = await app.inject({
        method: 'GET',
        url: '/status',
        headers: {
          origin: 'https://random-third-party-dapp.xyz',
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.headers['access-control-allow-origin']).toBe('https://random-third-party-dapp.xyz')
      // Must NOT include credentials header on public reads
      expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    })

    it('handles preflight OPTIONS on public reads', async () => {
      app = await buildApp()
      await app.ready()

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/price/XLM/USDC',
        headers: {
          origin: 'https://analytics-dashboard.com',
          'access-control-request-method': 'GET',
        },
      })

      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('https://analytics-dashboard.com')
      expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    })

    it('refuses blocked origins on public reads when configured', async () => {
      app = await buildApp({
        corsConfig: {
          publicBlockedOrigins: ['https://malicious-scam.com'],
        },
      })
      await app.ready()

      const res = await app.inject({
        method: 'GET',
        url: '/status',
        headers: {
          origin: 'https://malicious-scam.com',
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  describe('Credentialed routes class', () => {
    it('allows permitted origin on /usage/me with credentials: true', async () => {
      app = await buildApp()
      await app.ready()

      const res = await app.inject({
        method: 'GET',
        url: '/usage/me',
        headers: {
          origin: 'https://app.lens.org',
        },
      })

      // Status is 401 (missing API key), but CORS headers are evaluated
      expect(res.headers['access-control-allow-origin']).toBe('https://app.lens.org')
      expect(res.headers['access-control-allow-credentials']).toBe('true')
    })

    it('refuses unpermitted origin on /usage/me', async () => {
      app = await buildApp()
      await app.ready()

      const res = await app.inject({
        method: 'GET',
        url: '/usage/me',
        headers: {
          origin: 'https://untrusted-origin.org',
        },
      })

      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    })

    it('allows preflight OPTIONS on credentialed route for permitted origin', async () => {
      app = await buildApp()
      await app.ready()

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/usage/me',
        headers: {
          origin: 'https://portal.lens.org',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      })

      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('https://portal.lens.org')
      expect(res.headers['access-control-allow-credentials']).toBe('true')
    })

    it('refuses preflight OPTIONS on credentialed route for unpermitted origin', async () => {
      app = await buildApp()
      await app.ready()

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/usage/me',
        headers: {
          origin: 'https://attacker.com',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      })

      // Unpermitted origin preflight is rejected without CORS allow headers
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    })

    it('narrows policy when credentials are supplied to public routes', async () => {
      app = await buildApp()
      await app.ready()

      // Request carrying Authorization header from an untrusted origin
      const res = await app.inject({
        method: 'GET',
        url: '/status',
        headers: {
          origin: 'https://untrusted-origin.org',
          authorization: 'Bearer lens_key',
        },
      })

      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  describe('Admin routes class', () => {
    it('refuses cross-origin requests to /admin/keys by default (closed policy)', async () => {
      app = await buildApp()
      await app.ready()

      const res = await app.inject({
        method: 'POST',
        url: '/admin/keys',
        headers: {
          origin: 'https://attacker.com',
          'content-type': 'application/json',
        },
        payload: { label: 'malicious key' },
      })

      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('refuses preflight OPTIONS to /admin/usage by default', async () => {
      app = await buildApp()
      await app.ready()

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/admin/usage',
        headers: {
          origin: 'https://any-site.com',
          'access-control-request-method': 'GET',
        },
      })

      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('allows origin when CORS_ADMIN_ALLOWED_ORIGINS is explicitly configured', async () => {
      app = await buildApp({
        corsConfig: {
          adminAllowedOrigins: ['https://internal-admin.lens.org'],
        },
      })
      await app.ready()

      const allowedRes = await app.inject({
        method: 'GET',
        url: '/admin/usage',
        headers: {
          origin: 'https://internal-admin.lens.org',
        },
      })

      expect(allowedRes.headers['access-control-allow-origin']).toBe('https://internal-admin.lens.org')
      expect(allowedRes.headers['access-control-allow-credentials']).toBeUndefined()

      const refusedRes = await app.inject({
        method: 'GET',
        url: '/admin/usage',
        headers: {
          origin: 'https://other-internal.org',
        },
      })

      expect(refusedRes.headers['access-control-allow-origin']).toBeUndefined()
    })
  })
})
