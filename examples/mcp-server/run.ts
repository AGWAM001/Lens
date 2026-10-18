import 'dotenv/config';
import { BazaarMcpServer } from '../../src/mcp/server';
import { resolveMcpTransportConfig, McpTransportConfig } from '../../src/mcp/config';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { createEd25519Signer } from '@x402/stellar';

function formatHttpUrl(host: string, port: number, path: string): string {
  const hostPart = host.includes(':') ? `[${host}]` : host;
  return `http://${hostPart}:${port}${path}`;
}

async function main() {
  // Fail closed before a signer exists: an HTTP server that cannot authenticate
  // callers must never reach the point where it can spend.
  let transportConfig: McpTransportConfig;
  try {
    transportConfig = resolveMcpTransportConfig();
  } catch (e: any) {
    console.error(`[mcp-server] Error: ${e.message}`);
    process.exit(1);
  }

  const testnetKey = process.env.MCP_AGENT_SECRET_KEY_TESTNET;
  const mainnetKey = process.env.MCP_AGENT_SECRET_KEY_MAINNET;

  if (!testnetKey || !mainnetKey) {
    console.error('[mcp-server] Error: MCP_AGENT_SECRET_KEY_TESTNET and MCP_AGENT_SECRET_KEY_MAINNET must be set');
    process.exit(1);
  }

  const testnetSigner = createEd25519Signer(testnetKey, 'stellar:testnet');
  const pubnetSigner = createEd25519Signer(mainnetKey, 'stellar:pubnet');

  const testnetClient = new ExactStellarScheme(testnetSigner);
  const pubnetClient = new ExactStellarScheme(pubnetSigner);

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(globalThis.fetch, {
    maxPrice: process.env.MCP_MAX_PAYMENT_PRICE || '$1.00',
    schemes: [
      {
        network: 'stellar:testnet',
        client: testnetClient,
      },
      {
        network: 'stellar:pubnet',
        client: pubnetClient,
      }
    ]
  });

  // paid_call spends from the keys above, so the hosts it may pay for are the
  // operator's decision. Unset means no host is payable at all (#404).
  const paidCallAllowlist = (process.env.MCP_PAID_CALL_ALLOWED_HOSTS || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  const server = new BazaarMcpServer({
    fetchWithPayment,
    paidCallAllowlist
  });

  console.error('[mcp-server] Agent configured for stellar:testnet and stellar:pubnet');

  if (transportConfig.transport === 'http') {
    console.error('[mcp-server] Starting Bazaar MCP server on streamable HTTP...');
    const handle = await server.runHttp(transportConfig);
    const address = handle.server.address();
    const host = address && typeof address === 'object' ? address.address : transportConfig.host;
    const port = address && typeof address === 'object' ? address.port : transportConfig.port;
    console.error(`[mcp-server] Listening at ${formatHttpUrl(host, port, transportConfig.path)}`);
    console.error('[mcp-server] Bearer token authentication is required for every request');
    return;
  }

  console.error('[mcp-server] Starting Bazaar MCP server on stdio...');
  console.error(
    paidCallAllowlist.length > 0
      ? `[mcp-server] paid_call may pay these allow-listed origins: ${paidCallAllowlist.join(', ')}`
      : '[mcp-server] paid_call allow-list is empty: every paid call will be refused. Set MCP_PAID_CALL_ALLOWED_HOSTS to allow hosts.'
  );

  await server.run();
}

main().catch(err => {
  console.error('[mcp-server] Fatal error:', err);
  process.exit(1);
});
