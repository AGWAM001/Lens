import type { FastifyInstance } from 'fastify'
import { prisma } from '../db'
import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import { venueAdapters } from '../ingest/venues'
import '../middleware/network'

export const ON_CHAIN_SOURCES: readonly string[] = [
  'SDEX',
  'AMM',
  'soroswap_amm',
  'aquarius_amm',
]

function getOnChainSources(): string[] {
  const sources = new Set<string>(ON_CHAIN_SOURCES)
  try {
    for (const adapter of venueAdapters) {
      if (adapter.source) {
        sources.add(adapter.source)
      }
    }
  } catch {
    // fallback to default ON_CHAIN_SOURCES
  }
  return Array.from(sources)
}

function findWatchedPair(assetA: string, assetB: string, network: NetworkName) {
  const parse = (a: string) => {
    if (a.toLowerCase() === 'native') return { code: 'XLM', issuer: null as string | null }
    const [code, issuer] = a.split(':')
    return { code: (code ?? '').toUpperCase(), issuer: issuer ?? null }
  }
  const qA = parse(assetA)
  const qB = parse(assetB)

  const matches = (
    q: { code: string; issuer: string | null },
    side: { code: string; issuer?: string | null },
  ) => {
    if (q.code !== side.code.toUpperCase()) return false
    if (!q.issuer || !side.issuer) return true
    return q.issuer === side.issuer
  }

  try {
    return getNetworkConfig(network).pairs.find(
      p =>
        (matches(qA, p.assetA) && matches(qB, p.assetB)) ||
        (matches(qA, p.assetB) && matches(qB, p.assetA)),
    )
  } catch {
    return undefined
  }
}

function getCandidatePairKeys(assetA: string, assetB: string, network: NetworkName): string[] {
  const keys = new Set<string>()
  keys.add([assetA, assetB].sort().join('/'))
  keys.add(`${assetA}/${assetB}`)
  keys.add(`${assetB}/${assetA}`)
  keys.add([assetA.toUpperCase(), assetB.toUpperCase()].sort().join('/'))

  const matched = findWatchedPair(assetA, assetB, network)
  if (matched?.pairKey) {
    keys.add(matched.pairKey)
  }

  return Array.from(keys)
}

export async function registerPremiumRoutes(app: FastifyInstance) {
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { network?: string }
  }>('/premium/:assetA/:assetB', { config: { scope: 'read:prices' } }, async (req, reply) => {
    const log = req.log.child({ component: 'route:premium' })
    const { assetA, assetB } = req.params

    const requestedNetwork = req.query.network
    if (requestedNetwork !== undefined && requestedNetwork !== 'testnet' && requestedNetwork !== 'mainnet') {
      return reply.status(400).send({
        error: `Invalid network "${requestedNetwork}" — expected one of: testnet, mainnet`,
        code: 'INVALID_NETWORK',
      })
    }

    const network: NetworkName = req.network ?? (requestedNetwork as NetworkName) ?? activeNetwork

    const candidateKeys = getCandidatePairKeys(assetA, assetB, network)
    const pairKeyCondition = candidateKeys.length === 1 ? candidateKeys[0] : { in: candidateKeys }
    const onChainSources = getOnChainSources()

    try {
      // 1. Most recent on-chain price point
      const onChain = await prisma.pricePoint.findFirst({
        where: {
          network,
          pairKey: pairKeyCondition,
          source: { in: onChainSources },
        },
        orderBy: { timestamp: 'desc' },
      })

      // 2. Most recent CEX price points across all CEX sources
      const cexRows = await prisma.pricePoint.findMany({
        where: {
          network,
          pairKey: pairKeyCondition,
          source: { notIn: onChainSources },
        },
        orderBy: { timestamp: 'desc' },
      })

      // For each CEX source, pick its most recent price point (first encountered due to desc order)
      const latestByCex = new Map<string, typeof cexRows[0]>()
      for (const row of cexRows) {
        if (!latestByCex.has(row.source)) {
          latestByCex.set(row.source, row)
        }
      }

      // Pick the CEX with the highest price (best bid)
      let bestCex: typeof cexRows[0] | null = null
      for (const pt of latestByCex.values()) {
        if (!bestCex || Number(pt.price) > Number(bestCex.price)) {
          bestCex = pt
        }
      }

      // 3. Check staleness against configurable bound
      const stalenessBoundSeconds =
        config.premium?.stalenessSeconds ??
        parseInt(process.env.PREMIUM_STALENESS_SECONDS ?? '60', 10)
      const now = Date.now()

      if (!onChain || !bestCex) {
        const staleSide: 'onChain' | 'cex' | 'both' =
          !onChain && !bestCex ? 'both' : !onChain ? 'onChain' : 'cex'
        log.warn(
          { assetA, assetB, network, staleSide, stalenessBoundSeconds },
          'Missing price data rejected as stale',
        )
        return reply.status(400).send({
          error: 'Price data is stale',
          code: 'STALE_DATA',
          stale: staleSide,
          ageSeconds: null,
          onChainAgeSeconds: onChain
            ? Math.max(0, Math.floor((now - new Date(onChain.timestamp).getTime()) / 1000))
            : null,
          cexAgeSeconds: bestCex
            ? Math.max(0, Math.floor((now - new Date(bestCex.timestamp).getTime()) / 1000))
            : null,
        })
      }

      const onChainAgeSeconds = Math.max(
        0,
        Math.floor((now - new Date(onChain.timestamp).getTime()) / 1000),
      )
      const cexAgeSeconds = Math.max(
        0,
        Math.floor((now - new Date(bestCex.timestamp).getTime()) / 1000),
      )

      const onChainStale = onChainAgeSeconds > stalenessBoundSeconds
      const cexStale = cexAgeSeconds > stalenessBoundSeconds

      if (onChainStale || cexStale) {
        const staleSide: 'onChain' | 'cex' | 'both' =
          onChainStale && cexStale ? 'both' : onChainStale ? 'onChain' : 'cex'

        const reportedAge =
          staleSide === 'onChain'
            ? onChainAgeSeconds
            : staleSide === 'cex'
              ? cexAgeSeconds
              : Math.max(onChainAgeSeconds, cexAgeSeconds)

        log.warn(
          {
            assetA,
            assetB,
            network,
            staleSide,
            onChainAgeSeconds,
            cexAgeSeconds,
            stalenessBoundSeconds,
          },
          'Stale price data rejected',
        )

        return reply.status(400).send({
          error: 'Price data is stale',
          code: 'STALE_DATA',
          stale: staleSide,
          ageSeconds: reportedAge,
          onChainAgeSeconds,
          cexAgeSeconds,
        })
      }

      const onChainPrice = Number(onChain.price)
      const cexPrice = Number(bestCex.price)

      if (onChainPrice <= 0) {
        log.error({ onChainPrice, cexPrice }, 'Invalid on-chain price')
        return reply.status(500).send({
          error: 'Internal server error',
          code: 'INVALID_PRICE',
        })
      }

      const spreadBps = Number((((cexPrice - onChainPrice) / onChainPrice) * 10000).toFixed(2))

      return reply.status(200).send({
        assetA,
        assetB,
        network,
        onChain: {
          price: onChainPrice,
          source: onChain.source,
          timestamp: new Date(onChain.timestamp).toISOString(),
        },
        cex: {
          price: cexPrice,
          source: bestCex.source,
          timestamp: new Date(bestCex.timestamp).toISOString(),
        },
        spreadBps,
      })
    } catch (err) {
      log.error({ err, assetA, assetB, network }, 'Premium computation failed')
      return reply.status(500).send({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      })
    }
  })
}
