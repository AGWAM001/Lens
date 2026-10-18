import 'dotenv/config';
import { BazaarMcpServer } from '../../src/mcp/server';
import { SpendBudget, defaultSpendStateFile } from '../../src/mcp/budget';
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
  
  // A single payment is capped by spendControls.maxAmountPerPayment. The value is
  // passed through to the budget so the cumulative ceiling can reserve each call at
  // its worst case; leaving spendControls unset would let the library default of $1
  // differ from whatever MCP_MAX_PAYMENT_PRICE says. maxPrice is not a field of the
  // x402 client config, so setting it here previously bounded nothing.
  const maxPrice = process.env.MCP_MAX_PAYMENT_PRICE || '$1.00';
  const dailyCeiling = process.env.MCP_DAILY_SPEND_CEILING || '$10.00';

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(globalThis.fetch, {
    spendControls: {
      maxAmountPerPayment: maxPrice,
    },
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

  // The running total outlives the process: this server signs with a real key, and a
  // restart does not refund what the previous process already spent. Point
  // MCP_SPEND_STATE_FILE somewhere durable if the default location is not.
  const budget = new SpendBudget({
    perCallMax: maxPrice,
    dailyCeiling,
    stateFilePath: process.env.MCP_SPEND_STATE_FILE || defaultSpendStateFile(),
  });

  const server = new BazaarMcpServer({
    fetchWithPayment,
    budget
  });

  console.error('[mcp-server] Starting Bazaar MCP server on stdio...');
  console.error('[mcp-server] Agent configured for stellar:testnet and stellar:pubnet');
  // Limits and file paths only: the signing key is never logged.
  console.error(`[mcp-server] Spend limits: ${budget.describeLimits()}`);
  
  await server.run();
}

main().catch(err => {
  console.error('[mcp-server] Fatal error:', err);
  process.exit(1);
});
