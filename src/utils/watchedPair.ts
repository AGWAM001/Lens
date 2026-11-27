import { type NetworkName } from '../config'
import { getPairsForNetwork } from '../pairsRegistry'

/**
 * Resolve a requested pair against the ones this network watches.
 *
 * The issuer is honoured when the caller supplies one. It used to be discarded
 * outright — `a.split(':')[0]` — so every asset called USDC was the same asset,
 * and a request for Circle's mainnet USDC was answered with testnet USDC's
 * price, stamped `"network":"testnet"`, at 1.72 per XLM against a real ~0.18.
 *
 * That is the worst failure mode an oracle has: not a refusal, but a confident
 * wrong number. Asset codes are not unique on Stellar — anyone can issue
 * "USDC", and Horizon lists many — so the issuer is the only thing that
 * identifies an asset. A bare code still matches on code alone, since callers
 * quoting XLM or a single-issuer asset rely on that.
 *
 * `native` means XLM and codes are case-insensitive. Runtime-registered pairs
 * (POST /pairs) are included on the active network via getPairsForNetwork.
 */
export function findWatchedPair(assetA: string, assetB: string, network: NetworkName) {
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
    // Only enforce the issuer when both sides name one; XLM has none, and a
    // caller passing a bare code is not asserting which issuer they meant.
    if (!q.issuer || !side.issuer) return true
    return q.issuer === side.issuer
  }

  return getPairsForNetwork(network).find(
    p =>
      (matches(qA, p.assetA) && matches(qB, p.assetB)) ||
      (matches(qA, p.assetB) && matches(qB, p.assetA)),
  )
}
