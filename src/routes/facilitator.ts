import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { TransactionBuilder, scValToNative } from '@stellar/stellar-sdk'
import { extractBearer, lookupApiKey } from '../api/auth'
import { rpc } from '@stellar/stellar-sdk'
import { prisma } from '../db'
import { getNetworkConfig, type NetworkName } from '../config'
import { CAIP2_BY_NETWORK, getFacilitator, type SettleResponseShape } from '../x402/facilitator'
import { submitCatalogListing } from '../bazaar/catalog'
import type { RegisterBazaarResourceInput } from '../bazaar/types'
import { toExtensionResponses } from '../bazaar/validation'

/**
 * `POST /settle` — the facilitator endpoint that actually submits a payment.
 *
 * The settlement itself belongs to `@x402/stellar`; what lives here is the
 * surface around it: the wire contract, idempotency, replay and failure
 * mapping. The reasoning behind each decision is in
 * `docs/x402/settle-design.md`, which this implements.
 */

const NETWORK_BY_CAIP2: Record<string, NetworkName> = {
  'stellar:pubnet': 'mainnet',
  'stellar:testnet': 'testnet',
}

/**
 * Error reasons emitted by `ExactStellarScheme`, reused verbatim rather than
 * replaced with a vocabulary of our own — a canonical client must be able to
 * branch on the same strings the reference facilitator returns.
 */
export const SETTLE_ERROR_REASONS = {
  malformed: 'invalid_exact_stellar_payload_malformed',
  transactionFailed: 'settle_exact_stellar_transaction_failed',
  unexpected: 'unexpected_settle_error',
} as const

type AttemptState = 'submitting' | 'settled' | 'failed'

interface SettleRequestBody {
  x402Version?: number
  paymentPayload?: {
    payload?: { transaction?: unknown }
    [key: string]: unknown
  }
  paymentRequirements?: { network?: unknown; payTo?: unknown; asset?: unknown; amount?: unknown }
}

/**
 * Derives the idempotency key from the payload itself: the hash of the inner
 * transaction, which is also the hash the ledger will record.
 *
 * Derived, never generated — a resource server that retries after a timeout
 * sends the same payload and therefore lands on the same key without having to
 * carry an idempotency header. Returns null when the payload is not a
 * transaction we can parse, which is a malformed request rather than a
 * settlement failure.
 */

/**
 * Authoritatively decodes the payment amount directly from the signed transaction XDR
 * rather than trusting user-supplied paymentRequirements.amount.
 */
export function extractAuthoritativeAmount(transactionXdr: string, network: NetworkName): number | null {
  try {
    const passphrase = getNetworkConfig(network).network.passphrase
    const tx = TransactionBuilder.fromXDR(transactionXdr, passphrase)
    let total = 0
    let hasPayment = false
    for (const op of tx.operations) {
      if (op.type === 'payment' && 'amount' in op && typeof op.amount === 'string') {
        total += parseFloat(op.amount)
        hasPayment = true
      } else if (op.type === 'pathPaymentStrictReceive') {
        // What this op can cost the payer is `sendMax`, not `destAmount`.
        // destAmount is what the *destination* receives; the debit is whatever
        // the path costs, up to sendMax. A ceiling measured on destAmount would
        // wave through destAmount: 1 with sendMax: 10000. Bound the debit.
        const sendMax = 'sendMax' in op && typeof op.sendMax === 'string' ? parseFloat(op.sendMax) : NaN
        const destAmount =
          'destAmount' in op && typeof op.destAmount === 'string' ? parseFloat(op.destAmount) : NaN
        const bound = Number.isFinite(sendMax) ? sendMax : destAmount
        if (Number.isFinite(bound)) {
          total += bound
          hasPayment = true
        }
      } else if (op.type === 'pathPaymentStrictSend' && 'sendAmount' in op && typeof op.sendAmount === 'string') {
        total += parseFloat(op.sendAmount)
        hasPayment = true
      } else if (op.type === 'invokeHostFunction' && 'func' in op) {
        try {
          const func = (op as any).func
          if (func && typeof func.invokeContract === 'function') {
            const invokeArgs = func.invokeContract()
            const fnName = invokeArgs.functionName().toString()
            const args = invokeArgs.args()
            if ((fnName === 'transfer' || fnName === 'transfer_from') && Array.isArray(args) && args.length >= 3) {
              const nativeVal = scValToNative(args[2])
              if (typeof nativeVal === 'bigint' || typeof nativeVal === 'number') {
                total += Number(nativeVal) / 1e7
                hasPayment = true
              }
            }
          }
        } catch {
          // Soroban parsing error falls through to fail-closed check
        }
      }
    }
    return hasPayment ? total : null
  } catch {
    return null
  }
}

export function deriveIdempotencyKey(transactionXdr: string, network: NetworkName): string | null {
  try {
    const passphrase = getNetworkConfig(network).network.passphrase
    return TransactionBuilder.fromXDR(transactionXdr, passphrase).hash().toString('hex')
  } catch {
    return null
  }
}

function settleFailure(
  transaction: string,
  network: string,
  errorReason: string,
  errorMessage: string,
): SettleResponseShape {
  // Every rejection carries a non-null reason: an agent has to be able to
  // branch on failure instead of parsing prose.
  return { success: false, errorReason, errorMessage, transaction, network }
}

/**
 * Finalises an attempt left in `submitting` by reading the ledger, never by
 * resubmitting.
 *
 * A row in that state means the process died between writing the record and
 * recording the outcome, so we genuinely do not know whether the network took
 * the transaction. Asking the ledger is the only answer that cannot double-pay.
 */
async function resolveFromLedger(
  id: string,
  txHash: string,
  network: NetworkName,
  caip2: string,
): Promise<SettleResponseShape> {
  try {
    const server = new rpc.Server(getNetworkConfig(network).rpc.url)
    const tx = await server.getTransaction(txHash)

    if (tx.status === 'SUCCESS') {
      const response: SettleResponseShape = { success: true, transaction: txHash, network: caip2 }
      await finalise(id, 'settled', response)
      return response
    }
    if (tx.status === 'FAILED') {
      const response = settleFailure(
        txHash,
        caip2,
        SETTLE_ERROR_REASONS.transactionFailed,
        'The transaction was submitted and failed on-chain.',
      )
      await finalise(id, 'failed', response)
      return response
    }
  } catch (err) {
    return settleFailure(
      txHash,
      caip2,
      SETTLE_ERROR_REASONS.unexpected,
      `Could not reach the network to resolve an in-flight settlement: ${(err as Error).message}`,
    )
  }

  // NOT_FOUND: still in flight. The row stays `submitting`, and a later retry
  // of the same payload asks the ledger again.
  return settleFailure(
    txHash,
    caip2,
    SETTLE_ERROR_REASONS.transactionFailed,
    'This payment is still in flight; retry with the same payload.',
  )
}

async function finalise(id: string, state: AttemptState, response: SettleResponseShape): Promise<void> {
  await prisma.settlementAttempt.update({
    where: { id },
    data: {
      state,
      errorReason: response.errorReason ?? null,
      errorMessage: response.errorMessage ?? null,
      response: response as unknown as object,
    },
  })
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002'
}

/**
 * Registers the facilitator routes. Public: a facilitator cannot demand
 * payment to accept one.
 */
export async function registerSettleRoute(app: FastifyInstance) {
  app.post(
    '/settle',
    {
      config: {
        public: true,
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as SettleRequestBody

      const caip2 = typeof body.paymentRequirements?.network === 'string' ? body.paymentRequirements.network : ''
      const network = NETWORK_BY_CAIP2[caip2]
      const transactionXdr = body.paymentPayload?.payload?.transaction

      if (!network || typeof transactionXdr !== 'string' || transactionXdr.length === 0) {
        // The body keeps the SettleResponse shape even at 400, so an unmodified
        // canonical client can still read it instead of seeing a transport error.
        return reply
          .code(400)
          .send(
            settleFailure(
              '',
              caip2,
              SETTLE_ERROR_REASONS.malformed,
              'Request must carry paymentRequirements.network and paymentPayload.payload.transaction.',
            ),
          )
      }

      const txHash = deriveIdempotencyKey(transactionXdr, network)
      if (!txHash) {
        return reply
          .code(400)
          .send(
            settleFailure('', caip2, SETTLE_ERROR_REASONS.malformed, 'paymentPayload.payload.transaction is not a transaction envelope.'),
          )
      }

      // ── Spend ceiling checks (#147) ──────────────────────────────────────────
      const spendCeiling = parseFloat(process.env.FACILITATOR_SPEND_CEILING ?? '0')
      const dailyCeilingVar = network === 'mainnet' ? 'FACILITATOR_DAILY_CEILING_MAINNET' : 'FACILITATOR_DAILY_CEILING_TESTNET'
      const dailyCeiling = parseFloat(process.env[dailyCeilingVar] ?? '0')
      const ceilingConfigured = spendCeiling > 0 || dailyCeiling > 0

      const authAmount = extractAuthoritativeAmount(transactionXdr, network)

      // Fail-closed when a ceiling is configured but the authoritative amount
      // cannot be extracted from the transaction envelope. Refusing to settle an
      // unverified amount is safe; falling back to payer-supplied numbers is not.
      if (ceilingConfigured && authAmount === null) {
        req.log.warn({ txHash, network }, '[facilitator] Cannot verify authoritative settlement amount from XDR with ceiling configured')
        return reply.code(400).send(
          settleFailure(
            txHash,
            caip2,
            'unverifiable_settlement_amount',
            'Cannot verify authoritative settlement amount from transaction envelope while spend ceiling is configured.',
          ),
        )
      }

      const requestedAmount =
        authAmount !== null
          ? authAmount
          : (typeof body.paymentRequirements?.amount === 'string' ? parseFloat(body.paymentRequirements.amount) : 0)

      if (spendCeiling > 0 && requestedAmount > spendCeiling) {
        req.log.warn({ requestedAmount, spendCeiling, network }, '[facilitator] Settlement amount exceeds spend ceiling')
        return reply.code(400).send(
          settleFailure(
            txHash,
            caip2,
            'spend_ceiling_exceeded',
            `Payment amount ${requestedAmount} exceeds facilitator spend ceiling of ${spendCeiling}.`,
          ),
        )
      }

      // ── Daily ceiling per network (#147) ───────────────────────────────────
      if (dailyCeiling > 0) {
        const startOfDay = new Date()
        startOfDay.setUTCHours(0, 0, 0, 0)
        let totalSpentToday = 0
        if (typeof (prisma.settlementAttempt as any).findMany === 'function') {
          try {
            const settledToday = await prisma.settlementAttempt.findMany({
              where: {
                network,
                state: 'settled',
                createdAt: { gte: startOfDay },
              },
              select: { amount: true },
            })
            if (Array.isArray(settledToday)) {
              totalSpentToday = settledToday.reduce((sum, row) => sum + parseFloat(row.amount ?? '0'), 0)
            }
          } catch {}
        }
        const dailyCount = await prisma.settlementAttempt.count({
          where: {
            network,
            state: 'settled',
            createdAt: { gte: startOfDay },
          },
        })
        if (dailyCount >= dailyCeiling || (totalSpentToday > 0 && totalSpentToday + requestedAmount > dailyCeiling)) {
          req.log.error({ dailyCount, dailyCeiling, network }, '[facilitator] Daily settlement limit reached for network')
          return reply.code(429).send(
            settleFailure(
              txHash,
              caip2,
              'daily_spend_ceiling_exceeded',
              `Daily settlement limit of ${dailyCeiling} reached for network ${network}.`,
            ),
          )
        }
      }

      // ── Caller allow-list check (#147) ──────────────────────────────────────
      // Identity comes strictly from authenticated API key ID (req.apiKey.id or bearer token lookup).
      // We deliberately refuse caller-supplied headers (origin, x-caller-id) and body fields (payTo)
      // to ensure the allow-list cannot be bypassed by forging headers.
      const allowlist = process.env.FACILITATOR_CALLER_ALLOWLIST
      if (allowlist && allowlist.trim() !== '') {
        const allowed = allowlist.split(',').map((s) => s.trim().toLowerCase())
        let callerKeyId = (req.apiKey?.id ?? '').toLowerCase()
        if (!callerKeyId && req.headers['authorization']) {
          const token = extractBearer(req.headers['authorization'])
          if (token) {
            try {
              const lookedUp = await lookupApiKey(token)
              if (lookedUp) {
                callerKeyId = lookedUp.id.toLowerCase()
              }
            } catch {}
          }
        }

        const isAllowed = Boolean(callerKeyId && allowed.includes(callerKeyId))
        if (!isAllowed) {
          req.log.warn({ callerKeyId, allowed }, '[facilitator] Caller API key ID not on allow-list')
          return reply.code(403).send(
            settleFailure(
              txHash,
              caip2,
              'caller_not_allowed',
              'Caller API key is not on the facilitator allow-list.',
            ),
          )
        }
      }

    const facilitator = getFacilitator(network)
    if (!facilitator) {
      return settleFailure(
        txHash,
        caip2,
        SETTLE_ERROR_REASONS.unexpected,
        'This facilitator has no settlement key configured.',
      )
    }

    // The record is written BEFORE submission, not after: a timeout must leave
    // behind something a retry can recognise. The unique constraint on
    // (network, txHash) is the lock, so two concurrent settles for the same
    // payload race to insert and exactly one of them proceeds.
    let attemptId: string
    try {
      const attempt = await prisma.settlementAttempt.create({
        data: {
          // The DB stores the NetworkName; caip2 is the wire form and stays on the wire.
          network,
          txHash,
          state: 'submitting',
          payTo: typeof body.paymentRequirements?.payTo === 'string' ? body.paymentRequirements.payTo : null,
          asset: typeof body.paymentRequirements?.asset === 'string' ? body.paymentRequirements.asset : null,
          amount: authAmount !== null ? String(authAmount) : (typeof body.paymentRequirements?.amount === 'string' ? body.paymentRequirements.amount : null),
        },
      })
      attemptId = attempt.id
    } catch (err) {
      if (!isUniqueViolation(err)) {
        return settleFailure(txHash, caip2, SETTLE_ERROR_REASONS.unexpected, (err as Error).message)
      }

      const existing = await prisma.settlementAttempt.findUnique({
        where: { network_txHash: { network, txHash } },
      })

      // A payload is consumed the moment its record exists. A second settle
      // replays the stored answer rather than paying twice.
      if (existing?.state === 'settled' || existing?.state === 'failed') {
        return (existing.response as unknown as SettleResponseShape) ?? settleFailure(
          txHash,
          caip2,
          SETTLE_ERROR_REASONS.transactionFailed,
          'This payment was already settled.',
        )
      }

      return resolveFromLedger(existing!.id, txHash, network, caip2)
    }

    try {
      const response = (await facilitator.settle(body.paymentPayload, body.paymentRequirements)) as SettleResponseShape
      const normalised: SettleResponseShape = {
        ...response,
        transaction: response.transaction || txHash,
        network: response.network || caip2,
        ...(response.success ? {} : { errorReason: response.errorReason ?? SETTLE_ERROR_REASONS.unexpected }),
      }

      // A settled payment that carried a discovery extension also catalogues
      // what it paid for, so a resource server does not need a second call to
      // list itself.
      //
      // This runs after the payment has been submitted, so nothing here can
      // affect whether money moved — at worst it delays the response. It is
      // still awaited rather than fired and forgotten, because the result goes
      // back in the EXTENSION-RESPONSES header and a caller cannot be told
      // which fields were dropped after the response has gone.
      if (normalised.success && body.paymentPayload) {
        try {
          const rawPayload = body.paymentPayload as Record<string, unknown>
          const extensions = (rawPayload.extensions as Record<string, unknown>) ?? {}
          // Both shapes are accepted: `extensions.bazaar` is where the x402
          // extension envelope puts it, and `discovery` is the flattened form
          // older callers send.
          const bazaarExtension = extensions.bazaar ?? rawPayload.discovery
          if (bazaarExtension && body.paymentRequirements?.payTo) {
            const authority = {
              payTo: String(body.paymentRequirements.payTo),
              network,
            }
            // Unvalidated on purpose at this boundary: `submitCatalogListing`
            // runs `validateListing` against exactly this input and returns
            // per-field drops, so re-checking the shape here would duplicate
            // the one place that owns it.
            const writeResult = await submitCatalogListing(
              bazaarExtension as RegisterBazaarResourceInput,
              authority,
            )
            const extHeader = toExtensionResponses(writeResult.drops)
            reply.header('EXTENSION-RESPONSES', JSON.stringify(extHeader))
          }
        } catch (err) {
          // Cataloguing must never turn a successful settlement into a failed
          // response, so this is swallowed — but not silently. A catalog that
          // has been broken for a week should be visible in the logs rather
          // than inferred from listings that never appear.
          req.log.warn({ err, network }, '[facilitator] cataloguing a settled payment failed')
        }
      }

      await finalise(attemptId, normalised.success ? 'settled' : 'failed', normalised)
      return normalised
    } catch (err) {
      const response = settleFailure(txHash, caip2, SETTLE_ERROR_REASONS.unexpected, (err as Error).message)
      await finalise(attemptId, 'failed', response)
      return response
    }
  })
}
