import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createFailure, incrementFailureMetric } = vi.hoisted(() => ({
  createFailure: vi.fn(),
  incrementFailureMetric: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: { webhookDeliveryFailure: { create: createFailure, deleteMany: vi.fn() } },
}))
vi.mock('../metrics', () => ({
  webhook_delivery_failures_total: { inc: incrementFailureMetric },
}))

import { prisma } from '../db'
import { webhook_delivery_failures_total } from '../metrics'
import { deliverJsonWithRetries } from '../alerts/delivery'

describe('permanent webhook delivery failures', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    createFailure.mockReset().mockResolvedValue({})
    incrementFailureMetric.mockReset()
    global.fetch = vi.fn()
  })

  it('persists an exhausted response without storing the delivery secret', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 503 } as Response)
    const firstAttemptAt = new Date('2026-10-16T10:00:00.000Z')

    await deliverJsonWithRetries(
      'https://user:password@hooks.example.test/alerts?token=private',
      { assetA: 'XLM', price: 0.123 },
      'webhook-secret',
      3,
      firstAttemptAt,
    )

    expect(prisma.webhookDeliveryFailure.create).toHaveBeenCalledOnce()
    const data = vi.mocked(prisma.webhookDeliveryFailure.create).mock.calls[0][0].data
    expect(data).toMatchObject({
      endpoint: 'https://hooks.example.test',
      payload: { assetA: 'XLM', price: 0.123 },
      attemptCount: 3,
      lastStatus: 503,
      errorCategory: 'http_5xx',
      firstAttemptAt,
    })
    expect(data).not.toHaveProperty('secret')
    expect(data.lastAttemptAt).toBeInstanceOf(Date)
    expect(JSON.stringify(data)).not.toContain('webhook-secret')
    expect(JSON.stringify(data)).not.toContain('private')
    expect(webhook_delivery_failures_total.inc).toHaveBeenCalledWith({ category: 'http_5xx' })
  })

  it('records a non-retryable client response as a permanent failure', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 410 } as Response)

    await deliverJsonWithRetries('https://hooks.example.test/alerts', { event: 'threshold' }, 'secret')

    expect(prisma.webhookDeliveryFailure.create).toHaveBeenCalledOnce()
    expect(vi.mocked(prisma.webhookDeliveryFailure.create).mock.calls[0][0].data)
      .toMatchObject({ attemptCount: 1, lastStatus: 410, errorCategory: 'http_4xx' })
    expect(webhook_delivery_failures_total.inc).toHaveBeenCalledWith({ category: 'http_4xx' })
  })
})
