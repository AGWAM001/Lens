import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { SpendBudget } from './budget.js';
import { fetchWithTimeout } from '../fetch.js';

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
  /**
   * Cumulative ceiling over paid calls. Optional so a server can still run with
   * per-call limits only, but leaving it out means nothing bounds a day: the
   * per-payment cap only answers how much one mistake can cost, so a caller in a
   * retry loop can pay it again and again without limit.
   */
  budget?: SpendBudget;
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment: typeof fetch;
  private budget?: SpendBudget;

  constructor(config: McpServerConfig) {
    this.fetchWithPayment = config.fetchWithPayment;
    this.budget = config.budget;
    this.server = new Server(
      {
        name: 'bazaar-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'bazaar_search',
          description: 'Search for resources in a Stellar Bazaar node',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The base URL of the Bazaar API',
              },
              query: {
                type: 'string',
                description: 'Optional search query',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'paid_call',
          description:
            'Make a paid API call to a Bazaar resource, handling the 402 loop automatically. ' +
            (this.budget
              ? this.budget.describeLimits()
              : 'No cumulative spend ceiling is configured for this server; payments are bounded per call only.'),
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The full URL of the resource to fetch',
              },
              method: {
                type: 'string',
                description: 'HTTP method (default: GET)',
              },
            },
            required: ['url'],
          },
        },
        ...(this.budget
          ? [
              {
                name: 'payment_budget',
                description:
                  "Report the payment limits this server enforces and how much of today's budget is left, " +
                  'without making a paid call. Read this before spending to plan cost.',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  required: [],
                },
              },
            ]
          : []),
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'bazaar_search') {
        const url = String(request.params.arguments?.url);
        const query = request.params.arguments?.query ? String(request.params.arguments?.query) : undefined;
        
        try {
          const endpoint = query 
            ? `${url.replace(/\/$/, '')}/discovery/search?q=${encodeURIComponent(query)}`
            : `${url.replace(/\/$/, '')}/discovery/resources`;
            
          const res = await fetchWithTimeout(endpoint);
          
          if (!res.ok) {
            return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', `Service returned ${res.status}`);
          }
          
          const data = await res.json();
          
          const hasResources = (d: unknown): d is { resources: unknown[] } => 
            typeof d === 'object' && d !== null && 'resources' in d && Array.isArray((d as Record<string, unknown>).resources);

          if ((Array.isArray(data) && data.length === 0) || (hasResources(data) && data.resources.length === 0)) {
            return this.createErrorResponse('ERR_NO_RESULTS', 'No resources found');
          }
          
          return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          };
        } catch (e: any) {
          return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', e.message);
        }
      }

      if (request.params.name === 'payment_budget') {
        if (!this.budget) {
          return this.createErrorResponse('ERR_BAD_REQUEST', 'This server has no spend budget configured.');
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(this.budget.snapshot(), null, 2) }],
        };
      }

      if (request.params.name === 'paid_call') {
        const url = String(request.params.arguments?.url);
        const method = request.params.arguments?.method ? String(request.params.arguments?.method) : 'GET';

        const decision = this.budget?.authorize();
        if (decision && !decision.allowed) {
          return this.createErrorResponse('ERR_BUDGET_EXCEEDED', decision.reason, { budget: decision.snapshot });
        }
        const reservationId = decision?.allowed ? decision.reservationId : undefined;

        try {
          const res = await this.fetchWithPayment(url, { method });

          if (!res.ok) {
            if (res.status === 402) {
              // The seller rejected the payment, so nothing settled and the budget is untouched.
              this.settleReservation(reservationId, false);
              return this.createErrorResponse('ERR_PAYMENT_REJECTED', 'Payment required but was rejected or failed.');
            }
            // The resource failed after the payment loop ran; the payment may have settled anyway.
            this.settleReservation(reservationId, true);
            return this.createErrorResponse('ERR_BAD_REQUEST', `Request failed with status ${res.status}`);
          }

          this.settleReservation(reservationId, true);
          const text = await res.text();
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          
          return {
            content: [{ type: 'text', text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) }],
          };
        } catch (e: any) {
          this.settleReservation(reservationId, !this.paymentCouldNotHaveSettled(e));
          return this.handlePaidCallError(e);
        }
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private handlePaidCallError(e: any) {
    const msg = String(e.message || e).toLowerCase();
    
    if (msg.includes('signatureexpirationledger') || msg.includes('signature expired')) {
      return this.createErrorResponse('ERR_EXPIRED_AUTHORISATION', 'The transaction signature expired before it could be submitted.');
    }
    
    if (msg.includes('trustline') || msg.includes('op_no_trust')) {
      return this.createErrorResponse('ERR_MISSING_TRUSTLINE', 'Missing trustline for the required asset.');
    }
    
    if (msg.includes('insufficient') || msg.includes('underfunded')) {
      return this.createErrorResponse('ERR_INSUFFICIENT_BALANCE', 'Insufficient balance to complete the payment.');
    }

    if (msg.includes('fetch') || msg.includes('network')) {
      return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', 'Failed to reach the service: ' + e.message);
    }
    
    return this.createErrorResponse('ERR_INTERNAL_FAILURE', e.message || 'An unknown error occurred during the paid call.');
  }

  /**
   * Books or drops the worst-case hold taken by authorize(). `mayHaveSettled`
   * is true unless the failure proves no payment went through; anything that
   * cannot be proven is counted, so the ceiling stays an upper bound.
   */
  private settleReservation(reservationId: number | undefined, mayHaveSettled: boolean): void {
    if (reservationId === undefined || !this.budget) {
      return;
    }
    if (mayHaveSettled) {
      this.budget.commit(reservationId);
    } else {
      this.budget.release(reservationId);
    }
  }

  /**
   * True when an error proves the payment never settled: the transport failed
   * before offering payment, or the wallet could not fund or submit it. A
   * network failure mid-flight is not proof, and neither is an unknown error.
   */
  private paymentCouldNotHaveSettled(e: any): boolean {
    const msg = String(e?.message || e).toLowerCase();
    return (
      msg.includes('failed to parse payment requirements') ||
      msg.includes('failed to create payment payload') ||
      msg.includes('signatureexpirationledger') ||
      msg.includes('signature expired') ||
      msg.includes('trustline') ||
      msg.includes('op_no_trust') ||
      msg.includes('insufficient') ||
      msg.includes('underfunded')
    );
  }

  private createErrorResponse(code: McpErrorCode, reason: string, details?: Record<string, unknown>) {
    // For MCP, returning isError: true with a JSON payload is the standard way to return tool errors.
    const payload = {
      isError: true,
      code,
      reason,
      ...(details ? { details } : {}),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
