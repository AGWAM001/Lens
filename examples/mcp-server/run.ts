import 'dotenv/config';
import { BazaarMcpServer } from '../../src/mcp/server';
import {
  DEFAULT_MCP_METRICS_PATH,
  DEFAULT_MCP_METRIC_NETWORKS,
  McpTransportConfig,
  parseMetricLabelAllowList,
  resolveMcpTransportConfig,
} from '../../src/mcp/config';
import { SpendBudget, defaultSpendStateFile } from '../../src/mcp/budget';
import { PaymentLedger, defaultPaymentLedgerFile } from '../../src/mcp/ledger';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { createEd25519Signer } from '@x402/stellar';

function formatHttpUrl(host: string, port: number, path: string): string {
  const hostPart = host.includes(':') ? `[${host}]` : host;
  return `http://${hostPart}:${port}${path}`;
}

/**
 * Hosts allowed to become the `host` label of a Prometheus series. Series are
 * permanent, so labelling by whatever URL an agent asks for lets one caller
 * mint unbounded time series; anything outside this list is reported as
 * `unknown`. The audit file always keeps the real host regardless.
 */
function metricHosts(): string[] {
  return parseMetricLabelAllowList(process.env.MCP_METRIC_HOSTS, []);
}

/** Networks allowed to carry the `network` label; see DEFAULT_MCP_METRIC_NETWORKS. */
function metricNetworks(): string[] {
  return parseMetricLabelAllowList(process.env.MCP_METRIC_NETWORKS, DEFAULT_MCP_METRIC_NETWORKS);
}

function formatLabelDomain(labels: readonly string[]): string {
  return labels.length ? labels.join(', ') : 'every value is reported as unknown';
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

  // A single payment is capped by spendControls.maxAmountPerPayment. The value is
  // passed through to the budget so the cumulative ceiling can reserve each call at
  // its worst case; leaving spendControls unset would let the library default of $1
  // differ from whatever MCP_MAX_PAYMENT_PRICE says.
  const maxPrice = process.env.MCP_MAX_PAYMENT_PRICE || '$1.00';
  const dailyCeiling = process.env.MCP_DAILY_SPEND_CEILING || '$10.00';

  // The audit trail is built before the transport so it can observe the payment
  // the transport makes: a wrapped x402 fetch hands back a plain Response and the
  // price only appears on the request, so the offer has to be read at the boundary.
  const ledgerFile = process.env.MCP_PAYMENT_LEDGER_FILE || defaultPaymentLedgerFile();
  const labelHosts = metricHosts();
  const labelNetworks = metricNetworks();
  const paymentLedger = new PaymentLedger({
    filePath: ledgerFile,
    metricHosts: labelHosts,
    metricNetworks: labelNetworks,
  });

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(paymentLedger.instrumentFetch(globalThis.fetch), {
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
    budget,
    paymentLedger
  });

  console.error('[mcp-server] Agent configured for stellar:testnet and stellar:pubnet');
  console.error(`[mcp-server] Spend limits: ${budget.describeLimits()}`);
  // The audit file records where money went, never the key that signed it.
  console.error(`[mcp-server] Payment audit trail: ${ledgerFile}`);
  console.error(
    `[mcp-server] Spend metric labels — host: ${formatLabelDomain(labelHosts)}; network: ${formatLabelDomain(labelNetworks)}`
  );
  if (!labelHosts.length) {
    console.error(
      '[mcp-server] MCP_METRIC_HOSTS is empty, so every spend series is labelled host="unknown". Set it to the nodes this agent pays to get per-host spend.'
    );
  }

  if (transportConfig.transport === 'http') {
    console.error('[mcp-server] Starting Bazaar MCP server on streamable HTTP...');
    const handle = await server.runHttp(transportConfig);
    const address = handle.server.address();
    const host = address && typeof address === 'object' ? address.address : transportConfig.host;
    const port = address && typeof address === 'object' ? address.port : transportConfig.port;
    console.error(`[mcp-server] Listening at ${formatHttpUrl(host, port, transportConfig.path)}`);
    console.error('[mcp-server] Bearer token authentication is required for every request');
    console.error(
      `[mcp-server] Payment spend metrics: GET ${formatHttpUrl(host, port, DEFAULT_MCP_METRICS_PATH)} with the same bearer token`
    );
    return;
  }

  console.error('[mcp-server] Starting Bazaar MCP server on stdio...');
  console.error(
    '[mcp-server] stdio serves no HTTP listener, so the spend metrics of this process cannot be scraped; read the running total with the payment_budget tool or from the audit file above.'
  );
  await server.run();
}

main().catch(err => {
  console.error('[mcp-server] Fatal error:', err);
  process.exit(1);
});
