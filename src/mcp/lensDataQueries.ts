import { getActivePairs } from '../pairsRegistry'
import { activeNetwork, getNetworkConfig } from '../config'
import type { NetworkName } from '../config'
import { listPairs } from '../routes/pairs'
import { listPools } from '../routes/pools'
import {
  MARKET_CAP_UNSUPPORTED,
  SCREENER_DEFAULT_LIMIT,
  SCREENER_MAX_LIMIT,
  runScreener,
  ScreenerCursorError,
  ScreenerSortError,
} from '../services/screener'
import type { LensDataQueries } from './lensTools.js'

/**
 * The data layer behind the three Lens data tools (#409), built from the same
 * functions the REST routes call: `listPairs` serves `GET /pairs`, `listPools`
 * serves `GET /pools` and `runScreener` serves both `GET /screener` and the
 * GraphQL `screener` query. Asking through MCP is therefore a different
 * transport, not a different answer.
 *
 * Like {@link createLensPriceQueries}, this lives in its own module so the tool
 * logic stays testable with a stub and only a process that opts into serving
 * Lens's own data imports `pg`.
 */
export function createLensDataQueries(): LensDataQueries {
  return {
    activeNetwork,

    // On this process's own network the live registry is the truth: a pair added
    // through POST /pairs is watched from that moment, and REST lists it. For any
    // other network the registry says nothing — its entries were registered
    // against whichever network this process runs — so that network's declared
    // pairs are used instead, rather than answering a mainnet question with the
    // pairs a testnet process happens to watch.
    listPairs(network, page) {
      return listPairs(network, page, pairsFor(network))
    },

    listPools(network, page) {
      return listPools(network, page)
    },

    watchedPairs(network) {
      return pairsFor(network)
    },

    async screen(request) {
      if (request.marketCapAsked) {
        return { ok: false, error: MARKET_CAP_UNSUPPORTED }
      }
      // The screener's own ceiling is tighter than the MCP page ceiling, so the
      // page size has to be settled here and reported back: echoing the ask would
      // tell the agent it got a page the service never fetched. Same formula
      // runScreener applies, kept next to the call that runs it.
      const limit = Math.min(SCREENER_MAX_LIMIT, Math.max(1, request.limit ?? SCREENER_DEFAULT_LIMIT))
      try {
        const page = await runScreener({
          network: request.network,
          filters: request.filters,
          sortBy: request.sortBy,
          order: request.order,
          cursor: request.cursor ?? null,
          limit,
        })
        return { ok: true, page, limit }
      } catch (e) {
        // Both are refusals the REST route also answers with a 4xx; anything
        // else is the database being unreachable and stays a throw.
        if (e instanceof ScreenerCursorError || e instanceof ScreenerSortError) {
          return { ok: false, error: e.message }
        }
        throw e
      }
    },
  }
}

function pairsFor(network: NetworkName) {
  return network === activeNetwork ? getActivePairs() : getNetworkConfig(network).pairs
}
