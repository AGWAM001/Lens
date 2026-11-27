import { describe, it, expect } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { KNOWN_ASSET_SYMBOLS, resolveAssetSymbol } from '../ingest/venues/blend'

/**
 * The token ids the Blend adapter names without asking the network.
 *
 * The list was once typed by hand, and four of its six ids were not valid
 * Stellar addresses at all, mainnet XLM among them. Nothing failed: a lookup
 * that misses simply falls through to a network call. These tests are what
 * would have failed.
 */

// The reserves of Blend Fixed V2
// (CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD) as the pool's own
// get_reserve_list returns them on mainnet. Written here in full on purpose:
// this is the independent check on what the adapter derives.
const FIXED_V2_RESERVES: Record<string, string> = {
  CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA: 'XLM',
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: 'USDC',
  CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV: 'EURC',
}

describe('Blend known asset ids', () => {
  it('every id is a valid Stellar contract address', () => {
    const ids = Object.keys(KNOWN_ASSET_SYMBOLS)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(StrKey.isValidContract(id), `${id} is not a valid contract id`).toBe(true)
    }
  })

  it('names all three reserves of the Fixed V2 pool', () => {
    for (const [id, symbol] of Object.entries(FIXED_V2_RESERVES)) {
      expect(KNOWN_ASSET_SYMBOLS[id]).toBe(symbol)
    }
  })

  it('resolves a known reserve without a network call', async () => {
    // No RPC is mocked in this file: a lookup that missed would try to reach
    // the network and fall back to a shortened id, not to "XLM".
    for (const [id, symbol] of Object.entries(FIXED_V2_RESERVES)) {
      await expect(resolveAssetSymbol(id, 'mainnet')).resolves.toBe(symbol)
    }
  })

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(KNOWN_ASSET_SYMBOLS)).toBe(true)
  })
})
