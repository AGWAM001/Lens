import { describe, it, expect } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BazaarMcpServer } from '../src/mcp/server';
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeInvocation,
  nativeToScVal,
  scValToNative,
  xdr,
  hash,
} from '@stellar/stellar-sdk';

// @ts-ignore - @x402 packages ship ESM-only types incompatible with the repo's
// commonjs moduleResolution (same @ts-ignore the production code uses).
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

/**
 * End-to-end coverage for the *successful* x402 payment loop (#423).
 *
 * The pre-existing 402 tests in tests/mcp.test.ts mock `fetchWithPayment`, so
 * they only ever exercise a rejected payment mapping to ERR_PAYMENT_REJECTED.
 * Nothing drove the branch that actually moves money: 402 -> construct a
 * payment -> sign it -> submit it -> resource returned. That branch is the one
 * that would break silently on an x402 or Stellar SDK upgrade.
 *
 * Here the whole loop runs for real:
 *   - the x402 client + transport (`wrapFetchWithPaymentFromConfig`) is the
 *     production one, so header encoding / requirement parsing / payment
 *     selection / spend-control enforcement are all exercised.
 *   - the payment is signed with the real `@stellar/stellar-sdk` primitives
 *     (`authorizeInvocation`, Soroban `transfer` invocation, network
 *     passphrase), so an SDK change to any of those surfaces fails the test.
 *
 * Only two things are stubbed, and both are stubs on purpose:
 *   - the *resource + facilitator*, replaced by an in-process fake that demands
 *     payment, decodes the submitted `PAYMENT-SIGNATURE`, verifies it against
 *     the Stellar testnet network passphrase, and only then releases the
 *     resource; and
 *   - the Soroban RPC / Horizon that `ExactStellarScheme.createPaymentPayload`
 *     would otherwise call for `getLatestLedger` + `simulateTransaction`.
 *     Driving the real scheme needs those network round-trips, which would
 *     break "deterministic and needs no network access", so the scheme client
 *     builds the transfer invocation directly. The cryptography it runs is the
 *     SDK's own, which is exactly what the upgrade risk is about.
 *
 * All keys are generated per-test and are throwaway testnet accounts: never a
 * real secret, never a mainnet account, never committed.
 */

// A Stellar testnet Stellar Asset Contract id. The bytes are irrelevant to an
// offline signing test; it only needs to be a well-formed C-address.
const SAC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const RESOURCE_URL = 'http://stub.test/paid';

interface SignedPayment {
  functionName: string;
  from: string;
  to: string;
  amount: string;
  expirationLedger: number;
  credentialAddress: string;
  sigValidOnTestnet: boolean;
  sigValidOnMainnet: boolean;
}

/** Read the payment back out of the signed XDR exactly as a facilitator would. */
function decodeSignedPayment(transactionXdr: string): SignedPayment {
  const parsed = TransactionBuilder.fromXDR(transactionXdr, Networks.TESTNET) as any;
  const op = parsed.operations[0];
  const contractFn = op.func.invokeContract();

  const args: any[] = contractFn.args();
  const entry = op.auth[0];
  const credentials = entry.credentials().address();

  // Recompute the auth preimage for each candidate network and check which one
  // the payer's signature actually covers. A payment signed for testnet must
  // NOT verify under the mainnet passphrase - that is the "network" assertion.
  const signatureBytes = signatureBytesFrom(credentials);
  const payerKey = Keypair.fromPublicKey(Address.fromScAddress(credentials.address()).toString());
  const verify = (passphrase: string) => {
    const networkId = hash(Buffer.from(passphrase));
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: credentials.nonce(),
        invocation: entry.rootInvocation(),
        signatureExpirationLedger: credentials.signatureExpirationLedger(),
      }),
    );
    return payerKey.verify(Buffer.from(hash(preimage.toXDR())), signatureBytes);
  };

  return {
    functionName: contractFn.functionName().toString(),
    from: scValToNative(args[0]) as string,
    to: scValToNative(args[1]) as string,
    amount: (scValToNative(args[2]) as bigint).toString(),
    expirationLedger: credentials.signatureExpirationLedger(),
    credentialAddress: Address.fromScAddress(credentials.address()).toString(),
    sigValidOnTestnet: verify(Networks.TESTNET),
    sigValidOnMainnet: verify(Networks.PUBLIC),
  };
}

function signatureBytesFrom(addressCredentials: any): Buffer {
  const vec = addressCredentials.signature(); // scvVec of Ed25519 signature entries
  const mapEntries = vec.value()[0].value(); // [{key: ScSymbol, val: ScVal}, ...]
  const signatureEntry = mapEntries.find(
    (entry: any) => entry.key().sym().toString() === 'signature',
  );
  return Buffer.from(signatureEntry.val().bytes());
}

/**
 * Minimal `SchemeNetworkClient` that signs a real Soroban `transfer` offline.
 * It mirrors what `ExactStellarScheme.createPaymentPayload` produces
 * (`{ x402Version, payload: { transaction } }`) minus the RPC round-trips.
 */
function createSigningClient(deps: {
  payer: Keypair;
  source: Keypair;
  expirationLedger: number | ((req: any) => number);
  networkPassphrase: string;
  paymentCalls: { count: number };
}) {
  return {
    scheme: 'exact' as const,
    async createPaymentPayload(x402Version: number, req: any) {
      deps.paymentCalls.count += 1;
      const validUntil =
        typeof deps.expirationLedger === 'function' ? deps.expirationLedger(req) : deps.expirationLedger;

      const invokeArgs = new xdr.InvokeContractArgs({
        contractAddress: new Address(SAC_CONTRACT).toScAddress(),
        functionName: 'transfer',
        args: [
          nativeToScVal(deps.payer.publicKey(), { type: 'address' }),
          nativeToScVal(req.payTo, { type: 'address' }),
          nativeToScVal(req.amount, { type: 'i128' }),
        ],
      });
      const authorizedFn = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs);
      const invocation = new xdr.SorobanAuthorizedInvocation({ function: authorizedFn, subInvocations: [] });

      const entry = await authorizeInvocation(
        deps.payer,
        validUntil,
        invocation,
        deps.payer.publicKey(),
        deps.networkPassphrase,
      );

      const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
      const op = Operation.invokeHostFunction({ func: hostFn, auth: [entry] });
      const account = new Account(deps.source.publicKey(), '1');
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: deps.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(300)
        .build();
      tx.sign(deps.source);

      return { x402Version, payload: { transaction: tx.toXDR() } };
    },
  };
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function paymentRequiredHeader(network: string, amount: string, payTo: string) {
  return base64Json({
    x402Version: 2,
    resource: { url: RESOURCE_URL, description: 'paid resource', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network,
        amount,
        asset: SAC_CONTRACT,
        payTo,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
  });
}

interface FakeResourceOptions {
  /** Ledger the fake facilitator treats as "now" when checking expiry. */
  currentLedger: number;
  /** Called with the decoded payment when the facilitator inspects it. */
  onPayment?: (payment: SignedPayment) => void;
}

/**
 * The stubbed resource + facilitator: it answers an unpaid request with 402 +
 * PAYMENT-REQUIRED, and answers a paid request only after decoding and
 * verifying the submitted payment. It returns 200 + PAYMENT-RESPONSE on a valid
 * payment and 402 (never the resource) when verification fails.
 */
function createFakeResource(opts: FakeResourceOptions & {
  network?: string;
  amount?: string;
  payTo: string;
}) {
  const network = opts.network ?? 'stellar:testnet';
  const amount = opts.amount ?? '1000000';
  const calls: { submitted: boolean }[] = [];
  let paid: SignedPayment | null = null;

  const fetch: typeof globalThis.fetch = async (input: any) => {
    const request = input as Request;
    const signatureHeader = request.headers.get('PAYMENT-SIGNATURE');

    if (!signatureHeader) {
      calls.push({ submitted: false });
      return new Response(JSON.stringify({ error: 'payment required' }), {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader(network, amount, opts.payTo) },
      });
    }

    calls.push({ submitted: true });
    const payload = JSON.parse(Buffer.from(signatureHeader, 'base64').toString('utf-8'));
    const payment = decodeSignedPayment(payload.payload.transaction);
    paid = payment;
    opts.onPayment?.(payment);

    const expired = payment.expirationLedger <= opts.currentLedger;
    if (expired || !payment.sigValidOnTestnet || payment.sigValidOnMainnet) {
      // A real facilitator refuses without releasing the resource.
      return new Response(JSON.stringify({ error: 'payment verification failed' }), {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader(network, amount, opts.payTo) },
      });
    }

    return new Response(JSON.stringify({ secret: 'the-paywalled-value' }), {
      status: 200,
      headers: {
        'PAYMENT-RESPONSE': base64Json({ success: true, transaction: 'fake-tx-hash', network }),
      },
    });
  };

  return { fetch, get calls() { return calls; }, get paid() { return paid; } };
}

// authorizeInvocation / TransactionBuilder take the network passphrase
// explicitly, so no global network configuration is required.

describe('x402 successful payment loop (end to end, stubbed facilitator)', () => {
  it('drives 402 -> sign -> submit -> resource, verifying what was actually signed', async () => {
    const payer = Keypair.random();
    const source = Keypair.random();
    const payTo = Keypair.random().publicKey(); // fake facilitator's receiving account
    const currentLedger = 1_000_000;
    const expirationLedger = currentLedger + 12;
    const amount = '1000000'; // 0.1 USDC at 7 decimals

    const paymentCalls = { count: 0 };
    const resource = createFakeResource({ currentLedger, payTo, amount });
    const client = createSigningClient({ payer, source, expirationLedger, networkPassphrase: Networks.TESTNET, paymentCalls });

    const fetchWithPayment = wrapFetchWithPaymentFromConfig(resource.fetch as unknown as typeof fetch, {
      schemes: [{ network: 'stellar:testnet', client: client as any }],
      spendControls: {
        allowedAssets: [{ network: 'stellar:testnet', asset: SAC_CONTRACT, maxAmountPerPayment: '5000000' }],
      },
    });

    const response = await fetchWithPayment(RESOURCE_URL);
    const body = await response.json();

    // 1. The loop reached the resource only after paying.
    expect(response.status).toBe(200);
    expect(body).toEqual({ secret: 'the-paywalled-value' });
    expect(resource.calls.map(c => c.submitted)).toEqual([false, true]);
    expect(paymentCalls.count).toBe(1);

    // 2. The submitted payment was signed with the exact terms - not merely a
    //    200 body. Asserting here would fail if the client paid a different
    //    amount or a different destination while still returning a body.
    const paid = resource.paid!;
    expect(paid.functionName).toBe('transfer');
    expect(paid.amount).toBe(amount);                       // amount
    expect(paid.to).toBe(payTo);                            // destination
    expect(paid.from).toBe(payer.publicKey());             // payer
    expect(paid.credentialAddress).toBe(payer.publicKey()); // signer address
    // 3. Bound to the Stellar testnet network passphrase, and provably NOT mainnet.
    expect(paid.sigValidOnTestnet).toBe(true);
    expect(paid.sigValidOnMainnet).toBe(false);
    expect(paid.expirationLedger).toBe(expirationLedger);
  });

  it('refuses to pay when the demanded amount is above maxPrice, without submitting', async () => {
    const payer = Keypair.random();
    const source = Keypair.random();
    const payTo = Keypair.random().publicKey();
    const paymentCalls = { count: 0 };

    // The resource demands 9.0000000 USDC but the cap is 5.0000000 atomic max.
    const resource = createFakeResource({ currentLedger: 1_000_000, payTo, amount: '9000000' });
    const client = createSigningClient({ payer, source, expirationLedger: 1_000_012, networkPassphrase: Networks.TESTNET, paymentCalls });

    const fetchWithPayment = wrapFetchWithPaymentFromConfig(resource.fetch as unknown as typeof fetch, {
      schemes: [{ network: 'stellar:testnet', client: client as any }],
      spendControls: {
        allowedAssets: [{ network: 'stellar:testnet', asset: SAC_CONTRACT, maxAmountPerPayment: '5000000' }],
      },
    });

    await expect(fetchWithPayment(RESOURCE_URL)).rejects.toThrow(/spendControls\.allowedAssets maxAmountPerPayment/);

    // Only the unpaid 402 was requested; nothing was signed and no payment moved.
    expect(resource.calls.map(c => c.submitted)).toEqual([false]);
    expect(paymentCalls.count).toBe(0);
    expect(resource.paid).toBeNull();
  });

  it('refuses to pay for a network the client is not configured for', async () => {
    const payer = Keypair.random();
    const source = Keypair.random();
    const payTo = Keypair.random().publicKey();
    const paymentCalls = { count: 0 };

    // The resource asks for mainnet while only testnet is registered.
    const resource = createFakeResource({ currentLedger: 1_000_000, payTo, network: 'stellar:pubnet' });
    const client = createSigningClient({ payer, source, expirationLedger: 1_000_012, networkPassphrase: Networks.TESTNET, paymentCalls });

    const fetchWithPayment = wrapFetchWithPaymentFromConfig(resource.fetch as unknown as typeof fetch, {
      schemes: [{ network: 'stellar:testnet', client: client as any }],
      spendControls: { allowedAssets: true },
    });

    await expect(fetchWithPayment(RESOURCE_URL)).rejects.toThrow(/No network\/scheme registered/);
    expect(resource.calls.map(c => c.submitted)).toEqual([false]);
    expect(paymentCalls.count).toBe(0);
  });

  it('does not release the resource when the signature is already expired', async () => {
    const payer = Keypair.random();
    const source = Keypair.random();
    const payTo = Keypair.random().publicKey();
    const currentLedger = 1_000_000;
    const paymentCalls = { count: 0 };

    // Signed for a ledger already in the past: the payment is constructed and
    // submitted, but a verifying facilitator must reject it.
    const resource = createFakeResource({ currentLedger, payTo });
    const client = createSigningClient({ payer, source, expirationLedger: currentLedger - 1, networkPassphrase: Networks.TESTNET, paymentCalls });

    const fetchWithPayment = wrapFetchWithPaymentFromConfig(resource.fetch as unknown as typeof fetch, {
      schemes: [{ network: 'stellar:testnet', client: client as any }],
      spendControls: { allowedAssets: true },
    });

    const response = await fetchWithPayment(RESOURCE_URL);

    // A payment was submitted (so this genuinely tested the verification path),
    // the signature was expired, and the paywalled value was NOT returned.
    expect(resource.calls.map(c => c.submitted)).toEqual([false, true]);
    expect(paymentCalls.count).toBe(1);
    expect(resource.paid!.expirationLedger).toBeLessThanOrEqual(currentLedger);
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body).not.toHaveProperty('secret');
  });

  it('serves the resource through BazaarMcpServer.paid_call once the loop settles', async () => {
    const payer = Keypair.random();
    const source = Keypair.random();
    const payTo = Keypair.random().publicKey();
    const currentLedger = 1_000_000;
    const paymentCalls = { count: 0 };

    const resource = createFakeResource({ currentLedger, payTo });
    const client = createSigningClient({ payer, source, expirationLedger: currentLedger + 12, networkPassphrase: Networks.TESTNET, paymentCalls });
    const fetchWithPayment = wrapFetchWithPaymentFromConfig(resource.fetch as unknown as typeof fetch, {
      schemes: [{ network: 'stellar:testnet', client: client as any }],
      spendControls: { allowedAssets: true },
    });

    // Drive the real tool handler, wired to the real payment-enabled fetch.
    const server = new BazaarMcpServer({ fetchWithPayment, paidCallAllowlist: ['stub.test'] });
    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    (server as any).setupHandlers();

    const result = await handler({
      params: { name: 'paid_call', arguments: { url: RESOURCE_URL } },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ secret: 'the-paywalled-value' });
    // The money path ran for real: the payment was signed and submitted.
    expect(paymentCalls.count).toBe(1);
    expect(resource.paid!.to).toBe(payTo);
  });
});
