# Bazaar MCP Server Example

This directory contains two runnable examples that expose the Lens Bazaar
catalog as a [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server:

| Command | File | What it does |
|---|---|---|
| `npm run mcp:server` | `run.ts` | Starts the Bazaar MCP server on stdio. It signs x402 payment challenges with two Stellar secret keys — one for testnet, one for mainnet — and forwards paid API calls to Bazaar resources, handling the 402 → sign → 200 loop automatically. |
| `npm run mcp:agent` | `agent.ts` | Starts a mock Bazaar API on `http://localhost:3000`, connects an MCP client to the server, lists the available tools, calls `bazaar_search`, then makes a `paid_call` to the discovered resource. End-to-end demonstration of an agent discovering and paying for a resource. |

## ⚠️ Warning: this signs with a real mainnet key

`run.ts` requires `MCP_AGENT_SECRET_KEY_MAINNET` and builds a signer for
`stellar:pubnet` (mainnet). Any payment the server signs spends **real XLM**
from the account that key controls — there is no sandbox, no dry-run, and no
confirmation prompt.

**Do not run these commands with a funded mainnet key until you have read the
"Safe way to try it first" section below.**

The MCP server can spend up to `MCP_MAX_PAYMENT_PRICE` (default `$1.00`) per
paid call from the mainnet account.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `MCP_AGENT_SECRET_KEY_TESTNET` | Yes | Stellar secret key used to sign payments on `stellar:testnet` |
| `MCP_AGENT_SECRET_KEY_MAINNET` | Yes | Stellar secret key used to sign payments on `stellar:pubnet` (mainnet) — **real money** |
| `MCP_MAX_PAYMENT_PRICE` | No | Maximum price the server will pay per request (default: `$1.00`) |

Both keys are required: `run.ts` exits with an error if either is unset.

The server talks to two Stellar networks:
- `stellar:testnet` — safe, friendbot-funded play money
- `stellar:pubnet` — mainnet, real XLM

## Safe way to try it first

Never test with a funded mainnet key. Instead:

1. Create a fresh testnet account and fund it via [friendbot](https://docs.stellar.org/create-account) so it holds testnet XLM. Set `MCP_AGENT_SECRET_KEY_TESTNET` to that testnet secret.
2. For `MCP_AGENT_SECRET_KEY_MAINNET`, use a brand-new mainnet account with **zero XLM** (or any account you can afford to lose). A payment attempt against an unfunded account fails deterministically with `ERR_INSUFFICIENT_BALANCE` instead of spending money.
3. Leave `MCP_MAX_PAYMENT_PRICE` at its default `$1.00`, or lower it.

Only once you have confirmed the flow behaves as expected on testnet should you consider pointing `MCP_AGENT_SECRET_KEY_MAINNET` at a funded mainnet account — and only with an amount you are prepared to spend.

Never log, echo, print, or commit a real secret key. This README shows env var names only; it never shows a key value.

## Worked example: connect a client and call each tool

Prerequisites:

- Node.js installed
- Dependencies installed at the repo root (`npm install`)
- The two secret-key env vars set (see "Safe way to try it first" above)

Run the server in one terminal:

```bash
export MCP_AGENT_SECRET_KEY_TESTNET=<your-testnet-secret-key>
export MCP_AGENT_SECRET_KEY_MAINNET=<your-empty-mainnet-secret-key>
npm run mcp:server
```

The server starts on stdio and logs:

```
[mcp-server] Starting Bazaar MCP server on stdio...
[mcp-server] Agent configured for stellar:testnet and stellar:pubnet
```

In another terminal, run the agent example, which connects an MCP client,
lists the tools, and calls both of them:

```bash
npm run mcp:agent
```

Expected output (shortened for readability here; the actual run prints full
JSON):

```
[mock-server] Started mock Bazaar API on http://localhost:3000
[agent] Starting MCP server child process...
[agent] Connected to Bazaar MCP server.
[agent] Available tools: bazaar_search, paid_call

[agent] 1. Discovering resources at http://localhost:3000...
[agent] Executing tool: bazaar_search
[agent] Search result: {"resources":[{"name":"Mock Price Feed",...}]}

[agent] 2. Making a paid call to http://localhost:3000/api/v1/price...
[agent] Executing tool: paid_call
[agent] The MCP server will handle the 402 loop automatically...
[agent] Paid call succeeded! Retrieved data:
{"asset":"XLM","price":0.15,"timestamp":"..."}

[agent] End to end demonstration complete.
```

### What each tool does

- `bazaar_search` — searches a Bazaar node's discovery endpoint. Takes `url`
  (base URL of the Bazaar API) and an optional `query`. Returns the catalog of
  discoverable resources, or a structured error such as `ERR_NO_RESULTS` or
  `ERR_SERVICE_UNREACHABLE`.
- `paid_call` — makes a paid API call to a Bazaar resource, handling the x402
  402 payment loop automatically. Takes `url` (full URL of the resource) and an
  optional `method` (default `GET`). Returns the resource body, or a structured
  error such as `ERR_PAYMENT_REJECTED`, `ERR_INSUFFICIENT_BALANCE`,
  `ERR_MISSING_TRUSTLINE`, `ERR_EXPIRED_AUTHORISATION`, or
  `ERR_SERVICE_UNREACHABLE`.

### Standalone client example

You can also connect your own MCP client to the server. This TypeScript
example connects via stdio, lists tools, and calls both tools:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', 'examples/mcp-server/run.ts'],
  });

  const client = new Client(
    { name: 'bazaar-client-example', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  const tools = await client.listTools();
  console.log('Available tools:', tools.tools.map((t) => t.name).join(', '));

  // 1. Search for resources
  const search = await client.callTool({
    name: 'bazaar_search',
    arguments: { url: 'http://localhost:3000', query: 'XLM price' },
  });
  console.log('Search:', search.content[0].text);

  // 2. Make a paid call to the discovered resource
  const paid = await client.callTool({
    name: 'paid_call',
    arguments: { url: 'http://localhost:3000/api/v1/price' },
  });
  console.log('Paid call:', paid.content[0].text);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Run it with `npx tsx <file>` from the repo root, with the secret-key env vars
set. The server process is spawned automatically by the transport.

## Error codes

Paid-call failures return deterministic, machine-readable codes (see
`src/mcp/codes.ts`):

| Code | Meaning |
|---|---|
| `ERR_PAYMENT_REJECTED` | Payment was required but rejected or failed |
| `ERR_INSUFFICIENT_BALANCE` | The signing account lacks the balance to pay |
| `ERR_MISSING_TRUSTLINE` | Missing trustline for the required asset |
| `ERR_EXPIRED_AUTHORISATION` | The transaction signature expired before submission |
| `ERR_SERVICE_UNREACHABLE` | The Bazaar service could not be reached |
| `ERR_NO_RESULTS` | The search returned no resources |
| `ERR_BAD_REQUEST` | The request failed with a non-402 error status |
| `ERR_INTERNAL_FAILURE` | An unknown error occurred during the paid call |

An agent is the least able caller to notice a wrong answer: the server
prefers returning a structured error over guessing a best-effort result, so
always check `isError` before acting on a tool response.

## Related

- MCP server implementation: [`src/mcp/server.ts`](../../src/mcp/server.ts)
- Error codes: [`src/mcp/codes.ts`](../../src/mcp/codes.ts)
- Tests: [`tests/mcp.test.ts`](../../tests/mcp.test.ts)
- Repo README MCP section: [`README.md`](../../README.md#mcp-model-context-protocol)
