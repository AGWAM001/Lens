import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BazaarMcpServer, type McpServerConfig } from '../src/mcp/server';
import { PaymentLedger, metricHostsFromPaidCallAllowlist } from '../src/mcp/ledger';
import { MCP_ERROR_CODES } from '../src/mcp/codes';
import { register } from '../src/metrics';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('BazaarMcpServer', () => {
  it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    // The SDK server doesn't expose the router directly without a client, but we can test the handlePaidCallError method directly,
    // or by overriding setRequestHandler to capture our handler.
    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    
    // Re-setup handlers to capture the handler
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION');
  });

  it('should map missing trustline error to ERR_MISSING_TRUSTLINE', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('op_no_trust: The account does not have a trustline for this asset'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
  });

  it('should map 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'Payment Required'
    });
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_PAYMENT_REJECTED');
  });
  
  it('should return successfully on a successful call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: "hello" })
    });
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.success).toBe(true);
  });
});

describe('BazaarMcpServer bazaar_search SSRF guard (#407)', () => {
  function captureHandler(server: any) {
    let handler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    server.setupHandlers();
    return handler;
  }

  const publicLookup = { lookup: async () => ['93.184.216.34'] };
  const okFetchImpl = async () =>
    new Response(JSON.stringify({ resources: [{ name: 'x' }] }), { status: 200 });

  it('rejects a non-http(s) scheme', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'file:///etc' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a private / metadata literal', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'http://169.254.169.254' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], lookup: async () => ['127.0.0.1'], fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://innocent.example' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a redirect to a forbidden host', async () => {
    const calls: string[] = [];
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: {
        allowedHosts: [],
        ...publicLookup,
        fetchImpl: async (input: string | URL) => {
          calls.push(String(input));
          return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
        },
      },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
    expect(calls).toEqual(['https://ok.example/discovery/resources']);
  });

  it('returns results from a permitted public host', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example', query: 'xlm' } } });
    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content[0].text).resources[0].name).toBe('x');
  });
});

/**
 * x402 v2 payment header as the client's transport sends it: the seller's own
 * requirements echoed under `accepted`, plus `payload`, the signed envelope.
 * `payload` is the only thing here the ledger must never read, so it carries a
 * marker no record may contain.
 */
const PAYMENT_OFFER = {
  x402Version: 2,
  resource: 'https://ledger-offer.test/api/v1/price',
  accepted: {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: 'native',
    amount: '$0.10',
  },
  payload: { txEnvelopeXdr: 'DECOY-SIGNED-ENVELOPE-MUST-NOT-BE-RECORDED' },
};

/** Settlement header a resource server returns for a payment it accepted. */
const SETTLEMENT = {
  success: true,
  network: 'stellar:testnet',
  // A fixture, not a ledger entry: 64 hex characters written in full, never shortened.
  transaction: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
};

const ENVELOPE_MARKER = 'DECOY-SIGNED-ENVELOPE-MUST-NOT-BE-RECORDED';

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function settledResponse(body: unknown, settle: unknown = SETTLEMENT) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'payment-response': base64Json(settle),
    },
  });
}

describe('payment audit ledger (#406)', () => {
  const PAID_URL = 'https://ledger-audit.test/api/v1/price';
  // Every host this block pays, so the paid_call gate lets all of them through.
  const ALLOW_HOSTS = ['ledger-audit.test', 'ledger-offer.test', 'ledger-sum.test', 'ledger-metrics.test', 'other-metrics.test'];

  let ledgerDir: string | undefined;

  afterEach(() => {
    if (ledgerDir) {
      rmSync(ledgerDir, { recursive: true, force: true });
      ledgerDir = undefined;
    }
  });

  function tempLedgerFile(name: string): string {
    ledgerDir = mkdtempSync(join(tmpdir(), 'lens-mcp-ledger-'));
    return join(ledgerDir, name);
  }

  /**
   * Same capture-the-handler seam the rest of this file uses, with a ledger handed
   * to the server the way run.ts hands it.
   */
  function createHarness(
    fetchWithPayment: any,
    ledger = new PaymentLedger(),
    extra: Partial<McpServerConfig> = {}
  ) {
    const server = new BazaarMcpServer({
      fetchWithPayment,
      paidCallAllowlist: ALLOW_HOSTS,
      paymentLedger: ledger,
      ...extra,
    });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const callTool = (name: string, args: Record<string, unknown> = {}) => handler({ params: { name, arguments: args } });
    return { server, ledger, callTool };
  }

  /**
   * Wires the ledger the way run.ts does: the ledger wraps the transport's fetch,
   * and a stand-in for wrapFetchWithPayment adds the payment header that the real
   * scheme builds. The price is only observable there — the wrapped fetch hands
   * back a plain Response with no amount on it.
   */
  function createPaidTransport(ledger: PaymentLedger, respond: () => Response, offer = PAYMENT_OFFER) {
    const instrumented = ledger.instrumentFetch(
      vi.fn().mockImplementation(async () => respond()) as unknown as typeof fetch
    );
    const transport = vi.fn(async (url: string, init?: RequestInit) =>
      instrumented(url, { ...init, headers: { 'payment-signature': base64Json(offer) } })
    );
    return createHarness(transport as unknown as any, ledger);
  }

  it('records a failed payment as an attempt', async () => {
    const fetchWithPayment = vi.fn().mockResolvedValue(new Response('Payment Required', { status: 402 }));
    const { ledger, callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: PAID_URL });

    expect(response.isError).toBe(true);
    expect(ledger.records()).toHaveLength(1);
    const [record] = ledger.records();
    expect(record).toMatchObject({
      url: PAID_URL,
      host: 'ledger-audit.test',
      method: 'GET',
      outcome: 'failure',
      spend: 'none',
      errorCode: MCP_ERROR_CODES.ERR_PAYMENT_REJECTED,
      transactionHash: null,
    });
    expect(Date.parse(record.timestamp)).not.toBeNaN();
  });

  it('records every paid call, whatever the transport did with it', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(settledResponse({ price: '1.00' }))
      .mockResolvedValueOnce(new Response('Payment Required', { status: 402 }))
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
      .mockRejectedValueOnce(new Error('fetch failed'));
    const { ledger, callTool } = createHarness(transport);

    await callTool('paid_call', { url: PAID_URL, method: 'POST' });
    await callTool('paid_call', { url: PAID_URL });
    await callTool('paid_call', { url: 'https://ledger-audit.test/api/v1/other' });
    await callTool('paid_call', { url: 'https://ledger-audit.test/api/v1/throws' });

    expect(ledger.records().map((record) => [record.outcome, record.errorCode])).toEqual([
      ['success', null],
      ['failure', MCP_ERROR_CODES.ERR_PAYMENT_REJECTED],
      ['failure', MCP_ERROR_CODES.ERR_BAD_REQUEST],
      ['failure', MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE],
    ]);
    expect(ledger.records()[0].method).toBe('POST');
    // A 500 after the payment loop ran, and a transport that threw mid-flight,
    // are both failures that cannot be proved unspent. Only the refused 402 —
    // where the seller said no before taking anything — is recorded as none.
    expect(ledger.records().map((record) => record.spend)).toEqual(['settled', 'none', 'possible', 'possible']);
    expect(ledger.totalSpend().attempts).toBe(4);
  });

  it('records the transaction hash the seller echoes on settlement', async () => {
    const { ledger, callTool } = createHarness(vi.fn().mockResolvedValue(settledResponse({ price: '1.00' })));

    await callTool('paid_call', { url: PAID_URL });

    expect(ledger.records()[0]).toMatchObject({
      outcome: 'success',
      spend: 'settled',
      transactionHash: SETTLEMENT.transaction,
      network: 'stellar:testnet',
    });
  });

  it('reads the price off the payment header the transport sends', async () => {
    const ledger = new PaymentLedger();
    const { callTool } = createPaidTransport(ledger, () => settledResponse({ price: '1.00' }));

    const response = await callTool('paid_call', { url: 'https://ledger-offer.test/api/v1/price' });

    expect(response.isError).toBeFalsy();
    expect(ledger.records()[0]).toMatchObject({
      amount: '$0.10',
      asset: 'native',
      network: 'stellar:testnet',
      outcome: 'success',
      // The envelope settled, so the offer price is what was spent.
      spend: 'settled',
    });
  });

  it('records no secret material from the payment header', async () => {
    const filePath = tempLedgerFile('payments.jsonl');
    const ledger = new PaymentLedger({ filePath });
    const { callTool } = createPaidTransport(ledger, () => settledResponse({ price: '1.00' }));

    await callTool('paid_call', { url: 'https://ledger-offer.test/api/v1/price' });

    const record = JSON.stringify(ledger.records()[0]);
    const file = readFileSync(filePath, 'utf8');
    for (const stored of [record, file]) {
      expect(stored).not.toContain(ENVELOPE_MARKER);
      expect(stored).not.toContain('txEnvelopeXdr');
      expect(stored).not.toContain('payload');
    }
    // The offer is recorded; the signature that carried it is not.
    expect(record).toContain('$0.10');
  });

  it('appends one line per attempt to the audit file, oldest first', async () => {
    const filePath = tempLedgerFile('payments.jsonl');
    const ledger = new PaymentLedger({ filePath });
    const fetchWithPayment = vi
      .fn()
      .mockResolvedValueOnce(settledResponse({ price: '1.00' }))
      .mockResolvedValueOnce(new Response('Payment Required', { status: 402 }));
    const { callTool } = createHarness(fetchWithPayment, ledger);

    await callTool('paid_call', { url: PAID_URL });
    await callTool('paid_call', { url: PAID_URL });

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.outcome)).toEqual(['success', 'failure']);
    expect(lines[0]).toMatchObject({ transactionHash: SETTLEMENT.transaction, spend: 'settled' });
  });

  it('refuses every paid call when the audit file cannot be created', async () => {
    // A regular file where the ledger's parent directory should be: mkdirSync
    // fails for real rather than a flag we set to make the test pass.
    const insideTrackedDir = tempLedgerFile('ignored.jsonl');
    const blocker = join(dirname(insideTrackedDir), 'not-a-directory');
    writeFileSync(blocker, '');
    const ledger = new PaymentLedger({ filePath: join(blocker, 'payments.jsonl') });
    const fetchWithPayment = vi.fn().mockResolvedValue(settledResponse({ price: '1.00' }));
    const { callTool } = createHarness(fetchWithPayment, ledger);

    expect(ledger.durable).toBe(false);

    const refusal = await callTool('paid_call', { url: PAID_URL });

    expect(refusal.isError).toBe(true);
    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_INTERNAL_FAILURE);
    // Refused before the request: this server will not spend money it cannot record.
    expect(fetchWithPayment).not.toHaveBeenCalled();
    expect(ledger.records()).toEqual([]);
  });

  it('stops spending once a record fails to reach the audit file', async () => {
    const filePath = tempLedgerFile('payments.jsonl');
    const ledger = new PaymentLedger({ filePath });
    const fetchWithPayment = vi.fn().mockResolvedValue(settledResponse({ price: '1.00' }));
    const { callTool } = createHarness(fetchWithPayment, ledger);

    await callTool('paid_call', { url: PAID_URL });
    expect(readFileSync(filePath, 'utf8')).toContain(PAID_URL);

    // The trail disappears between calls, so the next append cannot land.
    rmSync(dirname(filePath), { recursive: true, force: true });
    ledgerDir = undefined;

    await callTool('paid_call', { url: PAID_URL });
    // That second call is the gap itself: it spent, then found nowhere to record
    // it. Nothing can be written about a write that failed, which is why every
    // call after it is refused rather than spent.
    expect(ledger.durable).toBe(false);
    expect(fetchWithPayment).toHaveBeenCalledTimes(2);

    const refusal = await callTool('paid_call', { url: PAID_URL });
    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_INTERNAL_FAILURE);
    expect(fetchWithPayment).toHaveBeenCalledTimes(2);
  });

  it('sums settled spend and flags spend it cannot price', async () => {
    const ledger = new PaymentLedger();
    const instrumented = ledger.instrumentFetch(
      vi
        .fn()
        .mockResolvedValueOnce(settledResponse({ price: '1.00' }))
        .mockResolvedValueOnce(settledResponse({ price: '1.00' })) as unknown as typeof fetch
    );
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      const amount = url.includes('unpriced') ? 'usdc:1000000' : '$0.10';
      const offer = { ...PAYMENT_OFFER, accepted: { ...PAYMENT_OFFER.accepted, amount } };
      return instrumented(url, { ...init, headers: { 'payment-signature': base64Json(offer) } });
    });
    const { callTool } = createHarness(transport as unknown as any, ledger);

    await callTool('paid_call', { url: 'https://ledger-sum.test/api/v1/price' });
    await callTool('paid_call', { url: 'https://ledger-sum.test/api/v1/unpriced' });

    // $0.10 settled as nanodollars; the asset-prefixed offer is recorded verbatim
    // but cannot join a USD total, and the ledger says so instead of quietly
    // undercounting what the agent spent.
    expect(ledger.totalSpend()).toEqual({
      attempts: 2,
      settledNanodollars: '100000000',
      possibleNanodollars: '0',
      unquantifiedPayments: 1,
    });
    expect(ledger.records()[1].amount).toBe('usdc:1000000');
  });

  it('exports spend as metrics with a bounded label set', async () => {
    const ledger = new PaymentLedger({
      metricHosts: ['ledger-metrics.test'],
      metricNetworks: ['stellar:testnet'],
    });
    const { callTool } = createPaidTransport(ledger, () => settledResponse({ price: '1.00' }));

    await callTool('paid_call', { url: 'https://ledger-metrics.test/api/v1/price' });
    await callTool('paid_call', { url: 'https://other-metrics.test/api/v1/price' });

    const attempts = await register.getSingleMetricAsString('mcp_payment_attempts_total');
    expect(attempts).toMatch(/mcp_payment_attempts_total\{[^}]*host="ledger-metrics\.test"[^}]*network="stellar:testnet"[^}]*outcome="success"[^}]*\} 1/);
    expect(attempts).toMatch(/host="unknown"/);
    // A host outside the allow-list never becomes a series of its own: an agent
    // that loops over URLs must not be able to mint unbounded time series.
    expect(attempts).not.toContain('other-metrics.test');

    const settled = await register.getSingleMetricAsString('mcp_payment_amount_usd_total');
    expect(settled).toMatch(/mcp_payment_amount_usd_total\{[^}]*host="ledger-metrics\.test"[^}]*network="stellar:testnet"[^}]*\} 0\.1/);
    expect(settled).not.toContain('other-metrics.test');
  });

  it('records nothing for a host the allow-list refused, or for discovery', async () => {
    const fetchWithPayment = vi.fn().mockResolvedValue(settledResponse({ price: '1.00' }));
    // Discovery is stubbed all the way down: the SSRF guard would otherwise do a
    // real DNS lookup for this host, and a spend test has no business reaching
    // for the network.
    const discovery = vi.fn(async () => new Response(JSON.stringify({ resources: [{ name: 'x' }] }), { status: 200 }));
    const { ledger, callTool } = createHarness(fetchWithPayment, new PaymentLedger(), {
      bazaarFetch: { lookup: async () => ['93.184.216.34'], fetchImpl: discovery },
    });

    const refusal = await callTool('paid_call', { url: 'https://never-allow-listed.test/api/v1/price' });

    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_HOST_NOT_ALLOWED);
    expect(fetchWithPayment).not.toHaveBeenCalled();

    // Discovery reads a catalog and never pays, so it has no place in a spend trail.
    const search = await callTool('bazaar_search', { url: 'https://ledger-audit.test' });
    expect(search.isError).toBeFalsy();

    expect(ledger.records()).toEqual([]);
    expect(ledger.totalSpend().attempts).toBe(0);
  });

  it('takes its host label domain from the paid_call allow-list', () => {
    // Same set that gates spending, deduplicated, with entries the gate itself
    // rejects left out rather than allowed to label a series.
    expect(
      metricHostsFromPaidCallAllowlist([
        'https://api.lens.example',
        'api.lens.example',
        'localhost:3000',
        'https://api.lens.example/v1/price',
        'not a url',
      ])
    ).toEqual(['api.lens.example', 'localhost:3000']);
  });
});
