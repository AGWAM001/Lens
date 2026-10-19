import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { activeNetwork, getNetworkConfig } from '../config'
import type { NetworkName } from '../config'
import type { LensPriceQueries } from './priceTool.js'

/**
 * Order size the route is computed for. REST's `/price` and `/route` default to
 * the same 1000 units, so an agent reading the MCP tool and an operator reading
 * the HTTP response see one number rather than two.
 */
const ROUTE_AMOUNT = 1000

/**
 * The data layer behind `lens_get_price`, built from the same aggregation the
 * REST and GraphQL surfaces serve.
 *
 * Keeping this in its own module is what lets `server.ts` stay free of the
 * database: the tool's logic is testable with a stub, and only a process that
 * opts into serving Lens's own prices pays for importing `pg` and Prisma.
 */
export function createLensPriceQueries(): LensPriceQueries {
  return {
    activeNetwork,

    // The declared pair list for that network, not the process-wide runtime
    // registry: entries added through POST /pairs are registered against
    // whichever network the API process runs, so reading them here would let a
    // mainnet request resolve a pair that was only ever added on testnet.
    watchedPairs(network: NetworkName) {
      return getNetworkConfig(network).pairs
    },

    aggregatedPrice(pairKey: string, network: NetworkName) {
      return getAggregatedPrice(pairKey, network)
    },

    bestRoute(assetA, assetB, pairKey, network) {
      return getBestRoute(assetA, assetB, pairKey, ROUTE_AMOUNT, network)
    },
  }
}
