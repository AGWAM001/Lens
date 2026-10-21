import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import * as catalogModule from '../bazaar/catalog'

const { mockCreate, mockFindUnique, mockUpdate, mockGetFacilitator, mockSettle, mockGetTransaction } = vi.hoisted(
  () => ({
    mockCreate: vi.fn(),
    mockFindUnique: vi.fn(),
    mockUpdate: vi.fn(),
    mockGetFacilitator: vi.fn(),
    mockSettle: vi.fn(),
    mockGetTransaction: vi.fn(),
  }),
)

vi.mock('../db', () => ({
  prisma: {
    settlementAttempt: {
      create: mockCreate,
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
  },
}))

vi.mock('../x402/facilitator', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, getFacilitator: mockGetFacilitator }
})

vi.mock('@stellar/stellar-sdk', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    rpc: { Server: class { getTransaction = mockGetTransaction } },
  }
})

import { registerSettleRoute, deriveIdempotencyKey, SETTLE_ERROR_REASONS } from '../routes/facilitator'

/** A real, signed envelope — the route hashes it, so it cannot be a stub. */
function buildEnvelope(passphrase: string): string {
  const keypair = Keypair.random()
  const account = new Account(keypair.publicKey(), '1')
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: passphrase })
    .addOperation(Operation.payment({ destination: keypair.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(60)
    .build()
  tx.sign(keypair)
  return tx.toXDR()
}

const TESTNET_ENVELOPE = buildEnvelope(Networks.TESTNET)
const PUBNET_ENVELOPE = buildEnvelope(Networks.PUBLIC)

/** A contract account payer — settlement must not be a G-address-only path. */
const CONTRACT_PAYER = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

function settleBody(
  overrides: {
    transaction?: string
    network?: string
    payer?: string
    extensions?: Record<string, unknown>
  } = {},
) {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: 'exact',
      network: overrides.network ?? 'stellar:testnet',
      ...(overrides.payer ? { payer: overrides.payer } : {}),
      ...(overrides.extensions ? { extensions: overrides.extensions } : {}),
      payload: { transaction: overrides.transaction ?? TESTNET_ENVELOPE },
    },
    paymentRequirements: {
      scheme: 'exact',
      network: overrides.network ?? 'stellar:testnet',
      amount: '1000000',
      asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payTo: 'G' + 'A'.repeat(55),
      maxTimeoutSeconds: 60,
    },
  }
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerSettleRoute(app)
  await app.ready()
  return app
}

function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
}

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue({ id: 'attempt-1' })
  mockFindUnique.mockReset().mockResolvedValue(null)
  mockUpdate.mockReset().mockResolvedValue({})
  mockSettle.mockReset().mockResolvedValue({
    success: true,
    transaction: 'onchain-hash',
    network: 'stellar:testnet',
    payer: 'GPAYER',
  })
  mockGetFacilitator.mockReset().mockReturnValue({ settle: mockSettle })
  mockGetTransaction.mockReset()
})

describe('POST /settle', () => {
  it('settles a payment and returns a SettleResponse', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, transaction: 'onchain-hash', network: 'stellar:testnet' })
    expect(mockSettle).toHaveBeenCalledTimes(1)
  })

  it('passes the payload to @x402/stellar untouched — no settlement logic of our own', async () => {
    const app = await buildApp()
    const body = settleBody()

    await app.inject({ method: 'POST', url: '/settle', payload: body })

    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { transaction: TESTNET_ENVELOPE } }),
      expect.objectContaining({ scheme: 'exact' }),
    )
  })

  it('writes the idempotency record BEFORE submitting, not after', async () => {
    let createdBeforeSettle = false
    mockSettle.mockImplementation(async () => {
      createdBeforeSettle = mockCreate.mock.calls.length === 1
      return { success: true, transaction: 'onchain-hash', network: 'stellar:testnet' }
    })
    const app = await buildApp()

    await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })

    expect(createdBeforeSettle).toBe(true)
  })

  it('keys the record on the inner transaction hash, derived from the payload', async () => {
    const app = await buildApp()

    await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          txHash: deriveIdempotencyKey(TESTNET_ENVELOPE, 'testnet'),
          // Stored as the NetworkName, not the CAIP-2 wire id — every other
          // model in the schema uses this vocabulary, and a row tagged
          // 'stellar:testnet' would be invisible to a network filter.
          network: 'testnet',
          state: 'submitting',
        }),
      }),
    )
  })

  it('settling the same payload twice submits once and replays the first answer', async () => {
    const app = await buildApp()
    const body = settleBody()

    const first = await app.inject({ method: 'POST', url: '/settle', payload: body })

    const stored = { success: true, transaction: 'onchain-hash', network: 'stellar:testnet', payer: 'GPAYER' }
    mockCreate.mockRejectedValueOnce(uniqueViolation())
    mockFindUnique.mockResolvedValue({ id: 'attempt-1', state: 'settled', response: stored })

    const second = await app.inject({ method: 'POST', url: '/settle', payload: body })

    expect(mockSettle).toHaveBeenCalledTimes(1)
    expect(second.json()).toEqual(first.json())
  })

  it('replays a stored failure instead of retrying it', async () => {
    const stored = {
      success: false,
      errorReason: SETTLE_ERROR_REASONS.transactionFailed,
      transaction: 'onchain-hash',
      network: 'stellar:testnet',
    }
    mockCreate.mockRejectedValueOnce(uniqueViolation())
    mockFindUnique.mockResolvedValue({ id: 'attempt-1', state: 'failed', response: stored })
    const app = await buildApp()

    const res = await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })

    expect(res.json()).toEqual(stored)
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('resolves an in-flight record from the ledger rather than resubmitting', async () => {
    mockCreate.mockRejectedValueOnce(uniqueViolation())
    mockFindUnique.mockResolvedValue({ id: 'attempt-1', state: 'submitting', response: null })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })
    const app = await buildApp()

    const res = await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })

    expect(res.json()).toMatchObject({ success: true })
    expect(mockSettle).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'settled' }) }))
  })

  it('reports an in-flight settlement the ledger has not seen yet, with a reason', async () => {
    mockCreate.mockRejectedValueOnce(uniqueViolation())
    mockFindUnique.mockResolvedValue({ id: 'attempt-1', state: 'submitting', response: null })
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' })
    const app = await buildApp()

    const body = (await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })).json()

    expect(body.success).toBe(false)
    expect(body.errorReason).toBe(SETTLE_ERROR_REASONS.transactionFailed)
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('marks an in-flight record failed when the ledger says it failed', async () => {
    mockCreate.mockRejectedValueOnce(uniqueViolation())
    mockFindUnique.mockResolvedValue({ id: 'attempt-1', state: 'submitting', response: null })
    mockGetTransaction.mockResolvedValue({ status: 'FAILED' })
    const app = await buildApp()

    const res = await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })

    expect(res.json().success).toBe(false)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }))
  })

  it('settles a payload authorised by a contract account, not only a G address', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      payload: settleBody({ payer: CONTRACT_PAYER }),
    })

    expect(res.statusCode).toBe(200)
    expect(mockSettle).toHaveBeenCalledWith(expect.objectContaining({ payer: CONTRACT_PAYER }), expect.anything())
  })

  it('works on pubnet as well as testnet', async () => {
    mockSettle.mockResolvedValue({ success: true, transaction: 'onchain-hash', network: 'stellar:pubnet' })
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      payload: settleBody({ transaction: PUBNET_ENVELOPE, network: 'stellar:pubnet' }),
    })

    expect(res.json()).toMatchObject({ success: true, network: 'stellar:pubnet' })
    expect(mockGetFacilitator).toHaveBeenCalledWith('mainnet')
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ txHash: deriveIdempotencyKey(PUBNET_ENVELOPE, 'mainnet') }),
      }),
    )
  })
})

describe('POST /settle — failure semantics', () => {
  it('rejects a body with no transaction, in the SettleResponse shape', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      payload: { x402Version: 2, paymentPayload: { payload: {} }, paymentRequirements: { network: 'stellar:testnet' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ success: false, errorReason: SETTLE_ERROR_REASONS.malformed })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects an unknown network', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      payload: settleBody({ network: 'ethereum:1' }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().errorReason).toBe(SETTLE_ERROR_REASONS.malformed)
  })

  it('rejects a payload that is not a transaction envelope', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      payload: settleBody({ transaction: 'not-xdr' }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().errorReason).toBe(SETTLE_ERROR_REASONS.malformed)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('fails explicitly when no settlement key is configured', async () => {
    mockGetFacilitator.mockReturnValue(null)
    const app = await buildApp()

    const body = (await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })).json()

    expect(body).toMatchObject({ success: false, errorReason: SETTLE_ERROR_REASONS.unexpected })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('turns an unreachable network into a non-null reason and records the failure', async () => {
    mockSettle.mockRejectedValue(new Error('fetch failed'))
    const app = await buildApp()

    const body = (await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })).json()

    expect(body).toMatchObject({ success: false, errorReason: SETTLE_ERROR_REASONS.unexpected })
    expect(body.errorMessage).toContain('fetch failed')
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }))
  })

  it('never returns a failure without an errorReason, even if the SDK omits one', async () => {
    mockSettle.mockResolvedValue({ success: false, transaction: 'onchain-hash', network: 'stellar:testnet' })
    const app = await buildApp()

    const body = (await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })).json()

    expect(body.success).toBe(false)
    expect(body.errorReason).not.toBeNull()
    expect(body.errorReason).toBe(SETTLE_ERROR_REASONS.unexpected)
  })

  it('preserves the SDK\'s own errorReason rather than replacing it', async () => {
    mockSettle.mockResolvedValue({
      success: false,
      errorReason: 'settle_exact_stellar_transaction_submission_failed',
      transaction: 'onchain-hash',
      network: 'stellar:testnet',
    })
    const app = await buildApp()

    const body = (await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })).json()

    expect(body.errorReason).toBe('settle_exact_stellar_transaction_submission_failed')
  })

  it('catalogs the resource automatically on successful settle and sets EXTENSION-RESPONSES header (#130)', async () => {
    const submitSpy = vi.spyOn(catalogModule, 'submitCatalogListing').mockResolvedValue({
      accepted: true,
      drops: [],
    })
    mockSettle.mockResolvedValue({ success: true, transaction: 'onchain-hash', network: 'stellar:testnet' })
    const app = await buildApp()

    const payload = settleBody({
      extensions: {
        bazaar: {
          resource: { url: 'https://api.seller.com/price', serviceName: 'Seller Price API' },
          bazaar: { schema: { type: 'object' }, info: { input: {} } },
        },
      },
    })

    const res = await app.inject({ method: 'POST', url: '/settle', payload })
    expect(res.statusCode).toBe(200)
    expect(submitSpy).toHaveBeenCalled()
    expect(res.headers['extension-responses']).toBeDefined()
    const extHeader = JSON.parse(res.headers['extension-responses'] as string)
    expect(extHeader.bazaar.catalog.accepted).toBe(true)
  })

  it('does not delay or fail settlement if cataloging throws (#130)', async () => {
    vi.spyOn(catalogModule, 'submitCatalogListing').mockRejectedValue(new Error('Catalog storage down'))
    mockSettle.mockResolvedValue({ success: true, transaction: 'onchain-hash', network: 'stellar:testnet' })
    const app = await buildApp()

    const payload = settleBody({
      extensions: {
        bazaar: {
          resource: { url: 'https://api.seller.com/price' },
        },
      },
    })

    const res = await app.inject({ method: 'POST', url: '/settle', payload })
    expect(res.statusCode).toBe(200)
    expect(res.json().success).toBe(true)
  })
})

describe('deriveIdempotencyKey', () => {
  it('is deterministic for the same payload and network', () => {
    expect(deriveIdempotencyKey(TESTNET_ENVELOPE, 'testnet')).toBe(deriveIdempotencyKey(TESTNET_ENVELOPE, 'testnet'))
  })

  it('is the transaction hash the ledger will record', () => {
    const expected = TransactionBuilder.fromXDR(TESTNET_ENVELOPE, Networks.TESTNET).hash().toString('hex')

    expect(deriveIdempotencyKey(TESTNET_ENVELOPE, 'testnet')).toBe(expected)
  })

  it('scopes the key by network, so the same envelope cannot collide across them', () => {
    expect(deriveIdempotencyKey(TESTNET_ENVELOPE, 'testnet')).not.toBe(deriveIdempotencyKey(TESTNET_ENVELOPE, 'mainnet'))
  })

  it('returns null for something that is not an envelope', () => {
    expect(deriveIdempotencyKey('not-xdr', 'testnet')).toBeNull()
  })
})
