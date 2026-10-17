import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment: typeof fetch;

  constructor(config: McpServerConfig) {
    this.fetchWithPayment = config.fetchWithPayment;
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
          description:
            'Search for discovery resources indexed in a Stellar Bazaar node. ' +
            'Cost: Free (no payment or tokens required). ' +
            'Preconditions: Requires a reachable HTTP/HTTPS base URL of a Stellar Bazaar catalog node. ' +
            'When NOT to use: Do NOT use this tool to execute paid API requests or purchase data (use `paid_call`). ' +
            'Do NOT use this tool to query live SDEX order books or pricing feeds directly (use Lens REST/GraphQL APIs instead). ' +
            'Do NOT pass specific API resource paths in the URL argument (provide only the root base URL of the node).',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description:
                  'The base URL of the Stellar Bazaar catalog node (e.g. "https://bazaar.example.com" or "http://localhost:3000"). ' +
                  'Format: Absolute HTTP or HTTPS URL without subpaths or trailing slashes.',
              },
              query: {
                type: 'string',
                description:
                  'Optional search term to filter discovery catalog resources by keyword (e.g. "XLM price", "oracle"). ' +
                  'Format: UTF-8 plain text search string. If omitted, all indexed resources are returned.',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'paid_call',
          description:
            'Make an authenticated paid API call to an x402-enabled Stellar Bazaar resource endpoint. ' +
            'Cost & Real Funds: SPENDS REAL CRYPTOGRAPHIC FUNDS (XLM/USDC) from the configured on-chain wallet. ' +
            'Enforces a strict per-call spending limit (default max $1.00 USD equivalent via MCP_MAX_PAYMENT_PRICE). ' +
            'Preconditions: Requires a funded Stellar signer with sufficient balance and valid trustlines. ' +
            'Host Allow-List: Payments are restricted strictly to permitted hosts; calls to unlisted hosts will fail. ' +
            'When NOT to use: Do NOT use this tool for free discovery searches (use `bazaar_search` instead). ' +
            'Do NOT use if the agent does not intend to spend real funds or if estimated cost exceeds the per-call limit ($1.00). ' +
            'Do NOT use for unverified, external, or non-Bazaar endpoints.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description:
                  'The full destination URL of the paid Bazaar resource endpoint (e.g. "https://api.example.com/v1/price"). ' +
                  'Format: Valid absolute HTTP or HTTPS URL pointing to an allowed payment host.',
              },
              method: {
                type: 'string',
                description:
                  'HTTP request method for the target endpoint. ' +
                  'Format: Uppercase HTTP verb string ("GET" or "POST"). Default: "GET".',
              },
            },
            required: ['url'],
          },
        },
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

      if (request.params.name === 'paid_call') {
        const url = String(request.params.arguments?.url);
        const method = request.params.arguments?.method ? String(request.params.arguments?.method) : 'GET';
        
        try {
          const res = await this.fetchWithPayment(url, { method });
          
          if (!res.ok) {
            if (res.status === 402) {
              return this.createErrorResponse('ERR_PAYMENT_REJECTED', 'Payment required but was rejected or failed.');
            }
            return this.createErrorResponse('ERR_BAD_REQUEST', `Request failed with status ${res.status}`);
          }
          
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

  private createErrorResponse(code: McpErrorCode, reason: string) {
    // For MCP, returning isError: true with a JSON payload is the standard way to return tool errors.
    const payload = {
      isError: true,
      code,
      reason,
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
