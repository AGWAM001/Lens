import { getBestRoute } from '../aggregator/bestRoute'
import { getDepth, getImpact } from '../pricing/depth'
import { activeNetwork, getNetworkConfig } from '../config'
import type { NetworkName } from '../config'
import type { LensQuoteQueries } from './quoteTool.js'

/**
 * The data layer behind `lens_quote` (#685), built from the three functions the
 * REST routes call: `getBestRoute` serves `GET /price/:a/:b/route`, `getDepth`
 * serves `GET /price/:a/:b/depth` and `getImpact` serves `GET /impact/:a/:b`.
 * Asking through MCP is therefore a different transport, not a different answer.
 *
 * It lives here rather than in `quoteTool.ts` so the tool logic stays testable
 * with a stub and a stdio server that does not serve Lens's own markets never
 * imports `pg` — the same split {@link createLensPriceQueries} makes.
 */
export function createLensQuoteQueries(): LensQuoteQueries {
  return {
    activeNetwork,

    // The declared pair list for that network — the exact list REST's `findPair`
    // searches — with issuers intact. Not the process-wide live registry: a pair
    // REST cannot resolve, this tool must not quietly price.
    watchedPairs(network: NetworkName) {
      return getNetworkConfig(network).pairs
    },

    // Argument order matches the route: the pair's own asset objects, its pair
    // key, the caller's order size, then the network.
    route(assetA, assetB, pairKey, amount, network) {
      return getBestRoute(assetA, assetB, pairKey, amount, network)
    },

    // `getDepth` takes the network first and needs the fee reader's Horizon URL,
    // read from the same network's config the route reads it from.
    depth(network: NetworkName, pairKey: string, amount: number) {
      return getDepth(network, pairKey, amount, {
        horizonUrl: getNetworkConfig(network).horizon.url,
      })
    },

    // The thresholds and liquidity fraction come from the tool, which is where
    // they are documented — this layer only passes them down.
    impact(pairKey, network, thresholds, liquidityFraction) {
      return getImpact(pairKey, { thresholds: [...thresholds], liquidityFraction }, network)
    },
  }
}
