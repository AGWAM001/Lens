import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket from 'ws'

const SENSITIVE_ERROR_MESSAGE = 'connection error: postgres://user:supersecretpassword@localhost:5432/db'

const { mockQuery, mockGetX402ResourceServer, mockPaymentAddressFor, mockGetCachedSnapshot } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetX402ResourceServer: vi.fn(),
  mockPaymentAddressFor: vi.fn(),
  mockGetCachedSnapshot: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('ioredis', () => {
  const mockRedis = {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  }
  return {
    default: vi.fn(() => mockRedis),
  }
})

vi.mock('../redis', () => ({
  redis: {
    publish: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  },
  getCachedSnapshot: mockGetCachedSnapshot,
  setCachedSnapshot: vi.fn(),
  getCachedPrice: vi.fn(),
}))

vi.mock('../pairsRegistry', () => ({
  getActivePairs: vi.fn(() => [
    {
      pairKey: 'USD/USDC',
      assetA: { code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ]),
}))

vi.mock('../x402/network', () => ({
  paymentAddressFor: mockPaymentAddressFor,
  getX402ResourceServer: mockGetX402ResourceServer,
  X402_NETWORK_LABEL: { testnet: 'stellar:testnet', mainnet: 'stellar:pubnet' },
}))

import { registerBenchmarkRoutes } from '../routes/benchmark'
import { registerSpreadsRoutes } from '../routes/spreads'
import { registerVolumeRoutes } from '../routes/volumes'
import { registerSnapshotRoutes } from '../routes/snapshot'
import { registerWebSocket } from '../api/websocket'
import { fanOutManager } from '../ws/fanout'

describe('Internal Error Leakage Prevention (Issue #260)', () => {
  let app: FastifyInstance
  const errorLogSpy = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    mockGetCachedSnapshot.mockResolvedValue(null)
    errorLogSpy.mockClear()

    app = Fastify({ logger: false })
    app.addHook('onRequest', async (req) => {
      req.log.error = errorLogSpy as any
    })

    await registerBenchmarkRoutes(app)
    await registerSpreadsRoutes(app)
    await registerVolumeRoutes(app)
    await registerSnapshotRoutes(app)
    await registerWebSocket(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('GET /benchmark/:asset', () => {
    it('returns 500 with sanitized response and logs real error with correlation ID', async () => {
      const dbError = new Error(SENSITIVE_ERROR_MESSAGE)
      mockQuery.mockRejectedValue(dbError)

      const res = await app.inject({
        method: 'GET',
        url: '/benchmark/USDC?target=USD',
      })

      expect(res.statusCode).toBe(500)
      const body = res.json()
      expect(body.code).toBe('internal_error')
      expect(body.message).toBe('An internal server error occurred.')
      expect(typeof body.correlationId).toBe('string')
      expect(body.correlationId.length).toBeGreaterThan(0)

      expect(res.body).not.toContain('supersecretpassword')
      expect(res.body).not.toContain('postgres://')
      expect(res.body).not.toContain(SENSITIVE_ERROR_MESSAGE)

      expect(errorLogSpy).toHaveBeenCalled()
      const logArgs = errorLogSpy.mock.calls[0]
      expect(logArgs[0]).toMatchObject({
        err: dbError,
        correlationId: body.correlationId,
      })
      expect(String(logArgs[0].err.message)).toContain('supersecretpassword')
    })
  })

  describe('GET /spreads/:asset', () => {
    it('returns 500 with sanitized response and logs real error with correlation ID', async () => {
      const dbError = new Error(SENSITIVE_ERROR_MESSAGE)
      mockQuery.mockRejectedValue(dbError)

      const res = await app.inject({
        method: 'GET',
        url: '/spreads/XLM',
      })

      expect(res.statusCode).toBe(500)
      const body = res.json()
      expect(body.code).toBe('internal_error')
      expect(body.message).toBe('An internal server error occurred.')
      expect(typeof body.correlationId).toBe('string')
      expect(body.correlationId.length).toBeGreaterThan(0)

      expect(res.body).not.toContain('supersecretpassword')
      expect(res.body).not.toContain('postgres://')
      expect(res.body).not.toContain(SENSITIVE_ERROR_MESSAGE)

      expect(errorLogSpy).toHaveBeenCalled()
      const logArgs = errorLogSpy.mock.calls[0]
      expect(logArgs[0]).toMatchObject({
        err: dbError,
        correlationId: body.correlationId,
      })
      expect(String(logArgs[0].err.message)).toContain('supersecretpassword')
    })
  })

  describe('GET /volumes/:asset', () => {
    it('returns 500 with sanitized response and logs real error with correlation ID', async () => {
      const dbError = new Error(SENSITIVE_ERROR_MESSAGE)
      mockQuery.mockRejectedValue(dbError)

      const res = await app.inject({
        method: 'GET',
        url: '/volumes/XLM',
      })

      expect(res.statusCode).toBe(500)
      const body = res.json()
      expect(body.code).toBe('internal_error')
      expect(body.message).toBe('An internal server error occurred.')
      expect(typeof body.correlationId).toBe('string')
      expect(body.correlationId.length).toBeGreaterThan(0)

      expect(res.body).not.toContain('supersecretpassword')
      expect(res.body).not.toContain('postgres://')
      expect(res.body).not.toContain(SENSITIVE_ERROR_MESSAGE)

      expect(errorLogSpy).toHaveBeenCalled()
      const logArgs = errorLogSpy.mock.calls[0]
      expect(logArgs[0]).toMatchObject({
        err: dbError,
        correlationId: body.correlationId,
      })
      expect(String(logArgs[0].err.message)).toContain('supersecretpassword')
    })
  })

  describe('GET /snapshot', () => {
    it('returns 500 with sanitized response and logs real error with correlation ID', async () => {
      const dbError = new Error(SENSITIVE_ERROR_MESSAGE)
      mockQuery.mockRejectedValue(dbError)

      const res = await app.inject({
        method: 'GET',
        url: '/snapshot',
      })

      expect(res.statusCode).toBe(500)
      const body = res.json()
      expect(body.code).toBe('internal_error')
      expect(body.message).toBe('An internal server error occurred.')
      expect(typeof body.correlationId).toBe('string')
      expect(body.correlationId.length).toBeGreaterThan(0)

      expect(res.body).not.toContain('supersecretpassword')
      expect(res.body).not.toContain('postgres://')
      expect(res.body).not.toContain(SENSITIVE_ERROR_MESSAGE)

      expect(errorLogSpy).toHaveBeenCalled()
      const logArgs = errorLogSpy.mock.calls[0]
      expect(logArgs[0]).toMatchObject({
        err: dbError,
        correlationId: body.correlationId,
      })
      expect(String(logArgs[0].err.message)).toContain('supersecretpassword')
    })
  })

  describe('WebSocket /ws error masking', () => {
    let wsServer: FastifyInstance
    let wsPort: number

    beforeEach(async () => {
      await fanOutManager.initialize()
      wsServer = Fastify({ logger: false })
      wsServer.addHook('onRequest', async (req) => {
        req.log.error = errorLogSpy as any
      })
      await registerWebSocket(wsServer)
      await wsServer.listen({ port: 0, host: '127.0.0.1' })
      wsPort = (wsServer.server.address() as any).port
    })

    afterEach(async () => {
      await fanOutManager.destroy()
      if (wsServer) await wsServer.close()
    })

    it('emits sanitized error payload and logs real internal error with correlation ID on verification failure', async () => {
      const wsError = new Error(SENSITIVE_ERROR_MESSAGE)
      mockPaymentAddressFor.mockReturnValue('G_TEST_PAYMENT_ADDRESS')
      mockGetX402ResourceServer.mockRejectedValue(wsError)

      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?payment=test_payment_header`)

      const receivedPayload = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()))
        ws.on('error', reject)
      })

      const parsed = JSON.parse(receivedPayload)
      expect(parsed.type).toBe('error')
      expect(parsed.code).toBe('internal_error')
      expect(parsed.message).toBe('An internal server error occurred.')
      expect(typeof parsed.correlationId).toBe('string')
      expect(parsed.correlationId.length).toBeGreaterThan(0)

      expect(receivedPayload).not.toContain('supersecretpassword')
      expect(receivedPayload).not.toContain('postgres://')
      expect(receivedPayload).not.toContain(SENSITIVE_ERROR_MESSAGE)

      expect(errorLogSpy).toHaveBeenCalled()
      const logArgs = errorLogSpy.mock.calls[0]
      expect(logArgs[0]).toMatchObject({
        err: wsError,
        correlationId: parsed.correlationId,
      })
      expect(String(logArgs[0].err.message)).toContain('supersecretpassword')

      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) resolve()
        else ws.on('close', () => resolve())
      })
    })
  })
})
