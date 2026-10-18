import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import Fastify from 'fastify'

// ── Mock Prisma ───────────────────────────────────────────────────────────────
vi.mock('../db', () => ({
  prisma: {
    webhook: {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import { registerWebhookRoutes } from '../routes/webhooks'
import { dispatchPriceUpdate } from '../webhookDispatcher'

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildApp() {
  const app = Fastify()
  return registerWebhookRoutes(app).then(() => app)
}

function verifySignature(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  return expected === signature
}

// ── Route Tests ───────────────────────────────────────────────────────────────
describe('POST /webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers a webhook and returns id + secret', async () => {
    const app = await buildApp()
    const fakeWebhook = { id: 'abc-123', secret: 'deadbeef'.repeat(8) }
    vi.mocked(prisma.webhook.create).mockResolvedValue(fakeWebhook as any)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'above',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBe('abc-123')
    expect(body.secret).toBeDefined()

    // Ensure prisma.create was called with correct shape
    const callArg = vi.mocked(prisma.webhook.create).mock.calls[0][0].data
    expect(callArg.url).toBe('https://example.com/hook')
    expect(callArg.assetA).toBe('XLM')
    expect(callArg.direction).toBe('above')
    expect(typeof callArg.secret).toBe('string')
    expect(callArg.secret.length).toBe(64) // 32 random bytes → 64 hex chars
  })

  it('rejects non-HTTPS URLs', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'http://example.com/hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'above',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/HTTPS/)
  })

  it('rejects invalid direction', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'sideways',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('registers a webhook with explicit network', async () => {
    const app = await buildApp()
    const fakeWebhook = { id: 'abc-mainnet', secret: 'beefdead'.repeat(8) }
    vi.mocked(prisma.webhook.create).mockResolvedValue(fakeWebhook as any)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/mainnet-hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.20,
        direction: 'above',
        network: 'mainnet',
      },
    })

    expect(res.statusCode).toBe(201)
    const callArg = vi.mocked(prisma.webhook.create).mock.calls[0][0].data
    expect(callArg.network).toBe('mainnet')
  })

  it('rejects invalid network', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: {
        url: 'https://example.com/hook',
        assetA: 'XLM',
        assetB: 'USD',
        threshold: 0.10,
        direction: 'above',
        network: 'invalidnet',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Invalid network/)
  })
})

describe('DELETE /webhooks/:id', () => {
  it('deletes a webhook and returns 204', async () => {
    const app = await buildApp()
    vi.mocked(prisma.webhook.delete).mockResolvedValue({} as any)

    const res = await app.inject({ method: 'DELETE', url: '/webhooks/abc-123' })
    expect(res.statusCode).toBe(204)
  })

  it('is idempotent — returns 204 even if webhook does not exist', async () => {
    const app = await buildApp()
    const notFoundErr = Object.assign(new Error('not found'), { code: 'P2025' })
    vi.mocked(prisma.webhook.delete).mockRejectedValue(notFoundErr)

    const res = await app.inject({ method: 'DELETE', url: '/webhooks/nonexistent' })
    expect(res.statusCode).toBe(204)
  })
})

// ── Dispatcher Tests ──────────────────────────────────────────────────────────
describe('dispatchPriceUpdate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    global.fetch = vi.fn()
  })

  it('fires webhook when price crosses above threshold and signature is valid', async () => {
    const secret = 'mysecret'
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-1', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret, createdAt: new Date() },
    ] as any)

    let capturedBody = ''
    let capturedSig = ''
    vi.mocked(global.fetch).mockImplementation(async (_url: any, opts: any) => {
      capturedBody = opts.body
      capturedSig = opts.headers['X-Lens-Signature']
      return { ok: true, status: 200 } as Response
    })

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.09, currentPrice: 0.11 })

    expect(global.fetch).toHaveBeenCalledOnce()

    // Validate HMAC signature
    expect(verifySignature(capturedBody, secret, capturedSig)).toBe(true)

    // Validate payload shape
    const payload = JSON.parse(capturedBody)
    expect(payload.assetA).toBe('XLM')
    expect(payload.assetB).toBe('USD')
    expect(payload.price).toBe(0.11)
    expect(payload.threshold).toBe(0.10)
    expect(payload.direction).toBe('above')
    expect(typeof payload.timestamp).toBe('string')
  })

  it('does not fire webhook when price does not cross threshold', async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-2', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret: 'x', createdAt: new Date() },
    ] as any)

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.11, currentPrice: 0.12 })

    // Price was already above threshold — no crossing, no delivery
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('fires webhook when price crosses below threshold', async () => {
    const secret = 'belowsecret'
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-3', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'below', secret, createdAt: new Date() },
    ] as any)

    vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200 } as Response)

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.12, currentPrice: 0.09 })

    expect(global.fetch).toHaveBeenCalledOnce()
  })

  it('retries on 5xx and stops retrying on 4xx', async () => {
    vi.useFakeTimers()

    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-4', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret: 'sec', createdAt: new Date() },
    ] as any)

    // First call → 500, second → 500, third → 500 (max retries)
    vi.mocked(global.fetch)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)

    const dispatchPromise = dispatchPriceUpdate({
      assetA: 'XLM', assetB: 'USD', previousPrice: 0.09, currentPrice: 0.11,
    })

    // Advance through exponential backoff delays: 1s + 2s
    await vi.runAllTimersAsync()
    await dispatchPromise

    expect(global.fetch).toHaveBeenCalledTimes(3)

    vi.useRealTimers()
  })

  it('does not retry on 4xx client errors', async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      { id: 'wh-5', url: 'https://hook.example.com', assetA: 'XLM', assetB: 'USD',
        threshold: 0.10, direction: 'above', secret: 'sec', createdAt: new Date() },
    ] as any)

    vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 400 } as Response)

    await dispatchPriceUpdate({ assetA: 'XLM', assetB: 'USD', previousPrice: 0.09, currentPrice: 0.11 })

    // Should NOT have retried — only 1 call
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('filters webhooks by the provided network and ignores other networks', async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([])

    await dispatchPriceUpdate({
      assetA: 'XLM',
      assetB: 'USD',
      previousPrice: 0.09,
      currentPrice: 0.11,
      network: 'mainnet',
    })

    expect(prisma.webhook.findMany).toHaveBeenCalledWith({
      where: {
        network: 'mainnet',
        assetA: 'XLM',
        assetB: 'USD',
      },
    })
  })

  it('falls back to activeNetwork when network is omitted', async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([])

    await dispatchPriceUpdate({
      assetA: 'XLM',
      assetB: 'USD',
      previousPrice: 0.09,
      currentPrice: 0.11,
    })

    expect(prisma.webhook.findMany).toHaveBeenCalledWith({
      where: {
        network: 'testnet',
        assetA: 'XLM',
        assetB: 'USD',
      },
    })
  })
})