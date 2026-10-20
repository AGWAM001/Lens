import 'dotenv/config';
import { BazaarMcpServer } from '../../src/mcp/server';
import { createLensPriceQueries } from '../../src/mcp/priceQueries';
import { activeNetwork } from '../../src/config';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { createEd25519Signer } from '@x402/stellar';

async function main() {
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
    paidCallAllowlist,
    // Lens's own aggregated prices, read from the same Postgres the API serves.
    priceQueries: createLensPriceQueries(),
    paidCallAllowlist
  });

  console.error('[mcp-server] Starting Bazaar MCP server on stdio...');
  console.error('[mcp-server] Agent configured for stellar:testnet and stellar:pubnet');
  console.error(`[mcp-server] lens_get_price serves aggregated prices on ${activeNetwork}`);
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
