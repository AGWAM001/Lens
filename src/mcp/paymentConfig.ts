// @ts-ignore — @x402 packages ship ESM-only types incompatible with commonjs moduleResolution
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
// @ts-ignore
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { createEd25519Signer } from '@x402/stellar';

export type SupportedStellarNetwork = 'stellar:testnet' | 'stellar:pubnet';

export interface McpPaymentEnvOptions {
  testnetKey?: string;
  mainnetKey?: string;
  enableMainnet?: boolean;
  maxPrice?: string;
  fetchImpl?: typeof fetch;
}

export interface McpPaymentSetupResult {
  fetchWithPayment: typeof fetch;
  activeNetworks: SupportedStellarNetwork[];
  mainnetEnabled: boolean;
  mainnetKeyPresent: boolean;
  warnings: string[];
  info: string[];
}

/**
 * Validates configured secret keys and constructs the x402 payment-wrapped fetch.
 *
 * Rules:
 * 1. Testnet key only is fully supported and recommended for development.
 * 2. Mainnet key requires explicit opt-in (enableMainnet: true); without it, mainnet is disabled.
 * 3. With no keys, returns a fetch instance configured with empty schemes, allowing read-only
 *    operations while refusing paid calls.
 * 4. Never logs or leaks secret key values.
 */
export function setupMcpPayment(options: McpPaymentEnvOptions = {}): McpPaymentSetupResult {
  const testnetKey = options.testnetKey?.trim();
  const mainnetKey = options.mainnetKey?.trim();
  const enableMainnet = Boolean(options.enableMainnet);

  const schemes: Array<{ network: SupportedStellarNetwork; client: any }> = [];
  const activeNetworks: SupportedStellarNetwork[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // Configure testnet
  if (testnetKey) {
    try {
      const testnetSigner = createEd25519Signer(testnetKey, 'stellar:testnet');
      const testnetClient = new ExactStellarScheme(testnetSigner);
      schemes.push({
        network: 'stellar:testnet',
        client: testnetClient,
      });
      activeNetworks.push('stellar:testnet');
    } catch (err: any) {
      // Redact any potential key leakage in error messages
      const sanitized = String(err.message || err).replace(/S[A-Z0-9]{55}/g, '[REDACTED]');
      throw new Error(`Failed to configure signer for network stellar:testnet: ${sanitized}`);
    }
  }

  // Configure mainnet (opt-in)
  const mainnetKeyPresent = Boolean(mainnetKey);
  if (mainnetKey) {
    if (enableMainnet) {
      try {
        const pubnetSigner = createEd25519Signer(mainnetKey, 'stellar:pubnet');
        const pubnetClient = new ExactStellarScheme(pubnetSigner);
        schemes.push({
          network: 'stellar:pubnet',
          client: pubnetClient,
        });
        activeNetworks.push('stellar:pubnet');
        warnings.push('⚠️ WARNING: Mainnet (stellar:pubnet) is enabled! Real funds are reachable.');
      } catch (err: any) {
        const sanitized = String(err.message || err).replace(/S[A-Z0-9]{55}/g, '[REDACTED]');
        throw new Error(`Failed to configure signer for network stellar:pubnet: ${sanitized}`);
      }
    } else {
      info.push(
        'Mainnet key detected but mainnet is not enabled. Set MCP_ENABLE_MAINNET=true to opt in to real funds.'
      );
    }
  }

  if (schemes.length === 0) {
    info.push('No payment signing keys configured. Running in read-only mode; paid_call will refuse.');
  }

  const baseFetch = options.fetchImpl || globalThis.fetch;
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(baseFetch, {
    maxPrice: options.maxPrice || '$1.00',
    schemes,
  });

  return {
    fetchWithPayment,
    activeNetworks,
    mainnetEnabled: enableMainnet && mainnetKeyPresent,
    mainnetKeyPresent,
    warnings,
    info,
  };
}
