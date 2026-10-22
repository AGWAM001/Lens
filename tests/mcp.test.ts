import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from '../src/metrics';
import { BazaarMcpServer } from '../src/mcp/server';
import { SpendBudget, parseUsdToNanodollars } from '../src/mcp/budget';
import { PaymentLedger } from '../src/mcp/ledger';
import { MCP_ERROR_CODES } from '../src/mcp/codes';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';

const { mockFetchWithTimeout } = vi.hoisted(() => ({
  mockFetchWithTimeout: vi.fn(),
}));

// bazaar_search fetches through src/fetch's timeout wrapper rather than the
// injected payment fetch, so the module has to be mocked to keep discovery off
// the network. Mocking it also keeps src/config (and with it @stellar/stellar-sdk
// and the env-dependent network resolution) out of this file's import graph.
vi.mock('../src/fetch', () => ({
  fetchWithTimeout: mockFetchWithTimeout,
}));

type CapturedHandler = (request: any) => Promise<any>;

/**
 * The SDK Server only routes a request once a transport is connected, so the
 * handlers are captured by swapping setRequestHandler for a recorder and
 * re-running setupHandlers() — the same approach the tests below already use.
 */
function createHarness(
  fetchWithPayment: Mock = vi.fn(),
  budget?: SpendBudget,
  paymentLedger?: PaymentLedger
) {
  const server = new BazaarMcpServer({
    fetchWithPayment: fetchWithPayment as unknown as typeof fetch,
    ...(budget ? { budget } : {}),
    ...(paymentLedger ? { paymentLedger } : {}),
  });

  const handlers = new Map<unknown, CapturedHandler>();
  (server as any).server.setRequestHandler = (schema: unknown, fn: CapturedHandler) => {
    handlers.set(schema, fn);
  };
  (server as any).setupHandlers();

  const callTool = handlers.get(CallToolRequestSchema);
  const listTools = handlers.get(ListToolsRequestSchema);
  if (!callTool || !listTools) {
    throw new Error('BazaarMcpServer did not register both a ListTools and a CallTool handler');
  }

  return {
    fetchWithPayment,
    ledger: server.paymentLedger,
    listTools: () => listTools({}),
    callTool: (name: string, args?: Record<string, unknown>) =>
      callTool({ params: { name, arguments: args } }),
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** undici's real shape for a connection-level failure. */
function transportFailure() {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 203.0.113.10:443'), {
      code: 'ECONNREFUSED',
    }),
  });
}

function parseFailure(result: { success: boolean; error?: unknown }) {
  return result.success ? '' : String(result.error);
}

describe('BazaarMcpServer', () => {
  it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

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
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

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
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

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
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

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

describe('bazaar_search', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('lists resources from /discovery/resources when no query is given', async () => {
    const body = {
      resources: [
        {
          name: 'Mock Price Feed',
          description: 'Price data for XLM',
          url: 'https://bazaar.example/api/v1/price',
        },
      ],
    };
    mockFetchWithTimeout.mockResolvedValue(jsonResponse(body));
    const { callTool, fetchWithPayment } = createHarness();

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example/' });

    // A trailing slash on the base URL must not produce a double slash.
    expect(mockFetchWithTimeout).toHaveBeenCalledWith('https://bazaar.example/discovery/resources');
    // Discovery must never spend: only paid_call may reach the payment signer.
    expect(fetchWithPayment).not.toHaveBeenCalled();
    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content[0].text)).toEqual(body);
  });

  it('routes a query to /discovery/search with the query URL-encoded', async () => {
    const body = {
      resources: [{ name: 'Mock Price Feed', url: 'https://bazaar.example/api/v1/price' }],
    };
    mockFetchWithTimeout.mockResolvedValue(jsonResponse(body));
    const { callTool } = createHarness();

    const response = await callTool('bazaar_search', {
      url: 'https://bazaar.example',
      query: 'XLM/USD spot',
    });

    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      'https://bazaar.example/discovery/search?q=XLM%2FUSD%20spot'
    );
    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content[0].text)).toEqual(body);
  });

  it('maps an empty resources array to ERR_NO_RESULTS', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ resources: [] }));
    const { callTool } = createHarness();

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example' });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_NO_RESULTS,
      reason: 'No resources found',
    });
  });

  it('maps an empty top-level array to ERR_NO_RESULTS', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse([]));
    const { callTool } = createHarness();

    const response = await callTool('bazaar_search', {
      url: 'https://bazaar.example',
      query: 'nothing indexed yet',
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_NO_RESULTS,
      reason: 'No resources found',
    });
  });

  it('maps a non-2xx response to ERR_SERVICE_UNREACHABLE with the status in the reason', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('Service Unavailable', { status: 503 }));
    const { callTool } = createHarness();

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example' });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE,
      reason: 'Service returned 503',
    });
  });

  it('maps a 200 carrying an unparseable body to ERR_SERVICE_UNREACHABLE', async () => {
    // A gateway can answer 200 with HTML. The catch-all cannot tell a transport
    // failure from a bad payload, so both surface as unreachable.
    mockFetchWithTimeout.mockResolvedValue(
      new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    const { callTool } = createHarness();

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example' });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.code).toBe(MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE);
    // undici's JSON parse message is version-dependent; only assert it is carried through.
    expect(typeof payload.reason).toBe('string');
    expect(payload.reason.length).toBeGreaterThan(0);
  });

  it('maps a transport failure to ERR_SERVICE_UNREACHABLE', async () => {
    mockFetchWithTimeout.mockRejectedValue(transportFailure());
    const { callTool } = createHarness();

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example' });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE,
      reason: 'fetch failed',
    });
  });
});

describe('paid_call upstream failures', () => {
  it('maps a transport failure to ERR_SERVICE_UNREACHABLE', async () => {
    const fetchWithPayment = vi.fn().mockRejectedValue(transportFailure());
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: 'https://bazaar.example/api/v1/price' });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE,
      reason: 'Failed to reach the service: fetch failed',
    });
  });

  it('maps an unmatched non-402 status to ERR_BAD_REQUEST', async () => {
    const fetchWithPayment = vi
      .fn()
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: 'https://bazaar.example/api/v1/price' });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_BAD_REQUEST,
      reason: 'Request failed with status 500',
    });
  });

  it('falls through to ERR_INTERNAL_FAILURE and keeps the upstream reason verbatim', async () => {
    // @x402/fetch wraps whatever ExactStellarScheme threw while building the
    // payment; this one is its asset-address validation.
    const reason =
      'Failed to create payment payload: Invalid Stellar asset address: not-a-stellar-asset';
    const fetchWithPayment = vi.fn().mockRejectedValue(new Error(reason));
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: 'https://bazaar.example/api/v1/price' });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_INTERNAL_FAILURE,
      reason,
    });
  });

  it('reports an unregistered scheme client as ERR_SERVICE_UNREACHABLE because the matcher keys on "network"', async () => {
    // @x402/core throws this when no client matches the payment requirements. It
    // is local misconfiguration, yet the substring "network" in the message routes
    // it to the unreachable-service branch, so the agent is pointed at the remote
    // service instead of its own x402 config.
    const message = 'No client registered for scheme: exact and network: stellar:pubnet';
    const fetchWithPayment = vi.fn().mockRejectedValue(new Error(message));
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: 'https://bazaar.example/api/v1/price' });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE,
      reason: `Failed to reach the service: ${message}`,
    });
  });

  it('cannot see a trustline failure that lives in the structured result codes', async () => {
    // Horizon reports why a transaction failed in extras.result_codes, not in the
    // message, and handlePaidCallError only reads e.message — so op_no_trust is
    // lost. Plain-string fixtures hide this; the real error object does not.
    const failure: any = new Error('Transaction submission failed');
    failure.response = {
      status: 400,
      data: {
        title: 'Transaction Failed',
        status: 400,
        detail: 'The transaction failed when submitted to the ledger.',
        extras: {
          result_codes: { transaction: 'tx_failed', operations: ['op_no_trust'] },
        },
      },
    };
    const fetchWithPayment = vi.fn().mockRejectedValue(failure);
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: 'https://bazaar.example/api/v1/price' });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.code).not.toBe(MCP_ERROR_CODES.ERR_MISSING_TRUSTLINE);
    expect(payload).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_INTERNAL_FAILURE,
      reason: 'Transaction submission failed',
    });
  });
});

describe('ListTools', () => {
  it('advertises exactly bazaar_search and paid_call', async () => {
    const { listTools } = createHarness();

    const result = await listTools();

    expect(result.tools.map((tool: any) => tool.name)).toEqual(['bazaar_search', 'paid_call']);
  });

  it('returns a result a client can parse with the SDK ListTools schema', async () => {
    const { listTools } = createHarness();

    const result = await listTools();
    const parsed = ListToolsResultSchema.safeParse(result);

    expect(parsed.success, parseFailure(parsed)).toBe(true);
  });

  it('declares a valid inputSchema for every advertised tool', async () => {
    const { listTools } = createHarness();

    const { tools } = await listTools();
    expect(tools).toHaveLength(2);

    for (const tool of tools) {
      const parsed = ToolSchema.safeParse(tool);
      expect(parsed.success, `${tool.name}: ${parseFailure(parsed)}`).toBe(true);
      expect(tool.inputSchema.type, `${tool.name}: MCP requires an object inputSchema`).toBe(
        'object'
      );

      const declared = Object.keys(tool.inputSchema.properties ?? {});
      // Both tools read arguments.url unconditionally; an agent that omits it
      // would otherwise get a request to the literal string "undefined".
      expect(tool.inputSchema.required, `${tool.name}: url must be required`).toContain('url');
      for (const required of tool.inputSchema.required ?? []) {
        expect(declared, `${tool.name}: "${required}" is required but undeclared`).toContain(
          required
        );
      }
    }
  });
});

describe('unknown tool', () => {
  it('rejects instead of returning a best-effort result', async () => {
    const { callTool } = createHarness();

    // The handler throws, so the SDK surfaces this as a JSON-RPC error rather
    // than a structured McpErrorResponse — the agent gets no error code.
    await expect(callTool('bazaar_refund')).rejects.toThrow('Unknown tool: bazaar_refund');
  });
});

describe('cumulative spend budget', () => {
  const PAID_URL = 'https://bazaar.example/api/v1/price';

  let tempDir: string | undefined;

  beforeEach(() => {
    tempDir = undefined;
  });

  /**
   * Each call must hand back a fresh Response: a Response body can only be read
   * once, and reusing one instance would fail the second call for a reason that
   * has nothing to do with the budget.
   */
  function cheapPaidCall(): Mock {
    return vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ price: '1.00' })));
  }

  function spendStateFile(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'lens-mcp-budget-'));
    return join(tempDir, 'spend-state.json');
  }

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses the call that would take the day total past the ceiling, without paying for it', async () => {
    // Three calls at the $1.00 per-call maximum fill the $3.00 ceiling; each one is
    // individually inside the per-call limit, which is the whole point of the issue.
    const fetchWithPayment = cheapPaidCall();
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$3.00' });
    const { callTool } = createHarness(fetchWithPayment, budget);

    for (let call = 1; call <= 3; call++) {
      const response = await callTool('paid_call', { url: PAID_URL });
      expect(response.isError, `call ${call} should still fit the ceiling`).toBeFalsy();
    }
    expect(budget.snapshot().spentToday).toBe('$3.00');
    expect(budget.snapshot().remainingToday).toBe('$0.00');

    const refusal = await callTool('paid_call', { url: PAID_URL });

    expect(refusal.isError).toBe(true);
    const payload = JSON.parse(refusal.content[0].text);
    expect(payload.code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);
    expect(payload.reason).toContain('Daily spend ceiling reached');
    // The agent has to be able to tell "out of budget" from "broken", and to see
    // what is left, from the refusal alone.
    expect(payload.details.budget).toMatchObject({
      currency: 'USD',
      perCallMax: '$1.00',
      dailyCeiling: '$3.00',
      spentToday: '$3.00',
      remainingToday: '$0.00',
      state: 'ok',
    });
    // Refusing must not spend: the ceiling gate runs before the payment fetch.
    expect(fetchWithPayment).toHaveBeenCalledTimes(3);
  });

  it('refuses a call whose worst case no longer fits, instead of overspending the remainder', async () => {
    const fetchWithPayment = cheapPaidCall();
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$2.50' });
    const { callTool } = createHarness(fetchWithPayment, budget);

    expect((await callTool('paid_call', { url: PAID_URL })).isError).toBeFalsy();
    await callTool('paid_call', { url: PAID_URL });
    expect(budget.snapshot().remainingToday).toBe('$0.50');

    // $0.50 is left, but a call can cost up to $1.00, so the reservation cannot fit.
    const refusal = await callTool('paid_call', { url: PAID_URL });

    expect(refusal.isError).toBe(true);
    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);
    expect(fetchWithPayment).toHaveBeenCalledTimes(2);
    expect(budget.snapshot().spentToday).toBe('$2.00');
  });

  it('resumes the day total after a restart, so a restart does not refill the budget', async () => {
    const file = spendStateFile();
    const options = { perCallMax: '$1.00', dailyCeiling: '$2.00', stateFilePath: file };

    const firstProcess = createHarness(cheapPaidCall(), new SpendBudget(options));
    await firstProcess.callTool('paid_call', { url: PAID_URL });
    await firstProcess.callTool('paid_call', { url: PAID_URL });

    // A fresh SpendBudget is what a server restart builds: same configuration, same file.
    const restarted = new SpendBudget(options);
    expect(restarted.snapshot().spentToday).toBe('$2.00');

    const fetchWithPayment = cheapPaidCall();
    const secondProcess = createHarness(fetchWithPayment, restarted);
    const refusal = await secondProcess.callTool('paid_call', { url: PAID_URL });

    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);
    expect(fetchWithPayment).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, spentNanodollars: '2000000000' });
  });

  it('starts a fresh window at UTC midnight', async () => {
    let current = new Date('2026-10-17T23:30:00.000Z');
    const file = spendStateFile();
    const budget = new SpendBudget({
      perCallMax: '$1.00',
      dailyCeiling: '$1.00',
      stateFilePath: file,
      now: () => current,
    });
    const { callTool } = createHarness(cheapPaidCall(), budget);

    expect((await callTool('paid_call', { url: PAID_URL })).isError).toBeFalsy();
    const sameDay = await callTool('paid_call', { url: PAID_URL });
    expect(JSON.parse(sameDay.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);

    current = new Date('2026-10-18T00:00:00.000Z');

    expect((await callTool('paid_call', { url: PAID_URL })).isError).toBeFalsy();
    expect(budget.snapshot()).toMatchObject({ day: '2026-10-18', spentToday: '$1.00', resetsAt: '2026-10-19T00:00:00.000Z' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ day: '2026-10-18' });
  });

  it('does not charge the budget when the seller rejects the payment', async () => {
    const fetchWithPayment = vi.fn().mockResolvedValue(new Response('Payment Required', { status: 402 }));
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$1.00' });
    const { callTool } = createHarness(fetchWithPayment, budget);

    const rejection = await callTool('paid_call', { url: PAID_URL });

    expect(JSON.parse(rejection.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_PAYMENT_REJECTED);
    expect(budget.snapshot().spentToday).toBe('$0.00');
    // Rejected money never settled, so the call must be repeatable within the ceiling.
    expect(budget.authorize().allowed).toBe(true);
  });

  it('treats an unreadable state file as fully spent rather than as a clean slate', async () => {
    const file = spendStateFile();
    writeFileSync(file, 'not json at all', 'utf8');
    // The budget degrades while loading, so the spy has to be in place first.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchWithPayment = cheapPaidCall();
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$10.00', stateFilePath: file });
    const { callTool } = createHarness(fetchWithPayment, budget);

    const refusal = await callTool('paid_call', { url: PAID_URL });

    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);
    expect(JSON.parse(refusal.content[0].text).details.budget.state).toBe('unavailable');
    expect(fetchWithPayment).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('shows both limits in the tool description and the live budget as a tool', async () => {
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$10.00' });
    const { listTools, callTool } = createHarness(cheapPaidCall(), budget);

    const { tools } = await listTools();
    const paidCallTool = tools.find((tool: any) => tool.name === 'paid_call');
    expect(paidCallTool.description).toContain('capped per call at $1.00');
    expect(paidCallTool.description).toContain('$10.00 per UTC day');
    expect(paidCallTool.description).toContain('ERR_BUDGET_EXCEEDED');

    const budgetTool = tools.find((tool: any) => tool.name === 'payment_budget');
    expect(budgetTool).toBeDefined();
    expect(ToolSchema.safeParse(budgetTool).success).toBe(true);

    const reported = await callTool('payment_budget');
    expect(reported.isError).toBeFalsy();
    expect(JSON.parse(reported.content[0].text)).toMatchObject({
      currency: 'USD',
      perCallMax: '$1.00',
      dailyCeiling: '$10.00',
      spentToday: '$0.00',
      reservedToday: '$0.00',
      remainingToday: '$10.00',
      state: 'ok',
    });

    await callTool('paid_call', { url: PAID_URL });
    expect(JSON.parse((await callTool('payment_budget')).content[0].text).remainingToday).toBe('$9.00');
  });

  it('refuses to start with limits that could never allow a call', () => {
    expect(() => new SpendBudget({ perCallMax: '$10.00', dailyCeiling: '$1.00' })).toThrow(/exceeds dailyCeiling/);
    expect(() => new SpendBudget({ perCallMax: 'free', dailyCeiling: '$1.00' })).toThrow(/Invalid USD amount/);
    expect(() => new SpendBudget({ perCallMax: '-$1.00', dailyCeiling: '$10.00' })).toThrow(/Invalid USD amount/);
  });

  it('parses money strings into exact integer nanodollars', () => {
    expect(parseUsdToNanodollars('$1.00')).toBe(1_000_000_000n);
    expect(parseUsdToNanodollars('$0.10')).toBe(100_000_000n);
    expect(parseUsdToNanodollars('0')).toBe(0n);
    expect(() => parseUsdToNanodollars('$1.0000000000')).toThrow(/more than 9 decimal places/);
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

describe('payment audit ledger', () => {
  const PAID_URL = 'https://ledger-audit.test/api/v1/price';

  let ledgerDir: string | undefined;

  beforeEach(() => {
    ledgerDir = undefined;
    mockFetchWithTimeout.mockReset();
  });

  afterEach(() => {
    if (ledgerDir) {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  function tempLedgerFile(name: string): string {
    ledgerDir = mkdtempSync(join(tmpdir(), 'lens-mcp-ledger-'));
    return join(ledgerDir, name);
  }

  /**
   * Wires the ledger the way run.ts does: the ledger wraps the transport's fetch,
   * and a stand-in for wrapFetchWithPayment adds the payment header that the real
   * scheme builds. The price is only observable there — the wrapped fetch hands
   * back a plain Response with no amount on it.
   */
  function createPaidTransport(ledger: PaymentLedger, respond: () => Response) {
    const instrumented = ledger.instrumentFetch(
      vi.fn().mockImplementation(async () => respond()) as unknown as typeof fetch
    );
    const transport = vi.fn(async (url: string, init?: RequestInit) =>
      instrumented(url, { ...init, headers: { 'payment-signature': base64Json(PAYMENT_OFFER) } })
    );
    return createHarness(transport as unknown as Mock, undefined, ledger);
  }

  it('records a failed payment as an attempt', async () => {
    const fetchWithPayment = vi.fn().mockResolvedValue(new Response('Payment Required', { status: 402 }));
    const { callTool, ledger } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: PAID_URL });

    expect(response.isError).toBe(true);
    const [record] = ledger.records();
    expect(ledger.records()).toHaveLength(1);
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
    const ledger = new PaymentLedger();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(settledResponse({ price: '1.00' }))
      .mockResolvedValueOnce(new Response('Payment Required', { status: 402 }))
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
      .mockRejectedValueOnce(transportFailure());
    const { callTool } = createHarness(transport, undefined, ledger);

    await callTool('paid_call', { url: PAID_URL, method: 'POST' });
    await callTool('paid_call', { url: PAID_URL });
    await callTool('paid_call', { url: 'https://ledger-audit.test/api/v1/other' });
    await callTool('paid_call', { url: 'not a url at all' });

    expect(ledger.records().map((record) => [record.outcome, record.errorCode])).toEqual([
      ['success', null],
      ['failure', MCP_ERROR_CODES.ERR_PAYMENT_REJECTED],
      ['failure', MCP_ERROR_CODES.ERR_BAD_REQUEST],
      ['failure', MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE],
    ]);
    // The method the agent asked for, and the URL as it was handed over — including
    // one this process cannot parse, which is recorded rather than dropped.
    expect(ledger.records()[0].method).toBe('POST');
    expect(ledger.records()[3]).toMatchObject({ url: 'not a url at all', host: 'unknown' });
    // A call that threw before any response existed cannot be proved unspent.
    expect(ledger.records()[3].spend).toBe('possible');
  });

  it('records the transaction hash the seller echoes on settlement', async () => {
    const ledger = new PaymentLedger();
    const { callTool } = createHarness(vi.fn().mockResolvedValue(settledResponse({ price: '1.00' })), undefined, ledger);

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
    const ledger = new PaymentLedger({ filePath: tempLedgerFile('payments.jsonl') });
    const { callTool } = createPaidTransport(ledger, () => settledResponse({ price: '1.00' }));

    await callTool('paid_call', { url: 'https://ledger-offer.test/api/v1/price' });

    const record = JSON.stringify(ledger.records()[0]);
    const file = readFileSync(ledgerDir + '/payments.jsonl', 'utf8');
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
    const { callTool } = createHarness(fetchWithPayment, undefined, ledger);

    await callTool('paid_call', { url: PAID_URL });
    await callTool('paid_call', { url: PAID_URL });
    await callTool('bazaar_search', { url: 'https://ledger-audit.test' });

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.outcome)).toEqual(['success', 'failure']);
    expect(lines[0]).toMatchObject({ transactionHash: SETTLEMENT.transaction, spend: 'settled' });
  });

  it('refuses to spend once the audit trail cannot be written', async () => {
    const ledger = new PaymentLedger({ filePath: tempLedgerFile('payments.jsonl') });
    const fetchWithPayment = vi.fn().mockResolvedValue(settledResponse({ price: '1.00' }));
    const { callTool } = createHarness(fetchWithPayment, undefined, ledger);

    // Stand in for a write that failed mid-run; the ledger marks itself not durable.
    ledger.durable = false;

    const refusal = await callTool('paid_call', { url: PAID_URL });

    expect(refusal.isError).toBe(true);
    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_INTERNAL_FAILURE);
    expect(fetchWithPayment).not.toHaveBeenCalled();
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
    const { callTool } = createHarness(transport as unknown as Mock, undefined, ledger);

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
    await callTool('paid_call', { url: 'https://not-allow-listed.test/api/v1/price' });

    const attempts = await register.getSingleMetricAsString('mcp_payment_attempts_total');
    expect(attempts).toMatch(/mcp_payment_attempts_total\{[^}]*host="ledger-metrics\.test"[^}]*network="stellar:testnet"[^}]*outcome="success"[^}]*\} 1/);
    expect(attempts).toMatch(/host="unknown"/);
    // A host outside the allow-list never becomes a series of its own: an agent
    // that loops over URLs must not be able to mint unbounded time series.
    expect(attempts).not.toContain('not-allow-listed.test');

    const settled = await register.getSingleMetricAsString('mcp_payment_amount_usd_total');
    expect(settled).toMatch(/mcp_payment_amount_usd_total\{[^}]*host="ledger-metrics\.test"[^}]*\} 0\.1/);
    expect(settled).not.toContain('not-allow-listed.test');
  });

  it('surfaces the running total to the budget tool', async () => {
    const ledger = new PaymentLedger();
    const instrumented = ledger.instrumentFetch(
      vi.fn().mockResolvedValue(settledResponse({ price: '1.00' })) as unknown as typeof fetch
    );
    const transport = vi.fn(async (url: string, init?: RequestInit) =>
      instrumented(url, { ...init, headers: { 'payment-signature': base64Json(PAYMENT_OFFER) } })
    );
    const budget = new SpendBudget({
      perCallMax: '$1.00',
      dailyCeiling: '$10.00',
      stateFilePath: tempLedgerFile('spend-state.json'),
    });
    const { callTool } = createHarness(transport as unknown as Mock, budget, ledger);

    await callTool('paid_call', { url: 'https://ledger-offer.test/api/v1/price' });

    const reported = JSON.parse((await callTool('payment_budget')).content[0].text);
    expect(reported.recordedSpend).toEqual({
      attempts: 1,
      settledNanodollars: '100000000',
      possibleNanodollars: '0',
      unquantifiedPayments: 0,
    });
    // The two views disagree on purpose: the budget can only hold the worst case
    // it reserved before paying, while the ledger reports the price it actually saw.
    expect(reported.spentToday).toBe('$1.00');
  });

  it('records nothing for discovery, which never pays', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ resources: [{ name: 'Mock Price Feed', url: PAID_URL }] }));
    const { callTool, ledger } = createHarness();

    await callTool('bazaar_search', { url: 'https://ledger-audit.test' });

    expect(ledger.records()).toEqual([]);
    expect(ledger.totalSpend().attempts).toBe(0);
  });
});
