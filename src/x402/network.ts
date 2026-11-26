import type { NetworkName } from '../config'
// @ts-ignore — @x402 packages ship ESM-only types incompatible with commonjs moduleResolution
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
// @ts-ignore
import { ExactStellarScheme } from '@x402/stellar/exact/server'

/** x402 chain identifier per Stellar network. */
export const X402_NETWORK_LABEL: Record<NetworkName, `${string}:${string}`> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

// The x402 payment-address env resolution and the "is x402 configured" check
// live in ./gating so the cache layer can share them without importing the
// @x402 packages (issue #677). Re-exported here so existing imports keep working.
export { paymentAddressFor, isX402Configured } from './gating'

// One resource server per network, built and initialised lazily on first use
// so a network that's never requested never pays the initialize() cost.
const resourceServers = new Map<NetworkName, Promise<any>>()

export function getX402ResourceServer(network: NetworkName, facilitatorUrl: string): Promise<any> {
  let pending = resourceServers.get(network)
  if (!pending) {
    pending = (async () => {
      const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl })
      const server: any = new x402ResourceServer(facilitatorClient)
        .register(X402_NETWORK_LABEL[network], new ExactStellarScheme())
      await server.initialize()
      return server
    })()
    resourceServers.set(network, pending)
  }
  return pending
}

/** Test-only: clears the memoised resource servers between test cases. */
export function _resetX402ResourceServers(): void {
  resourceServers.clear()
}
