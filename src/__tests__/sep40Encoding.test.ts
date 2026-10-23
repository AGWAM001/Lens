/**
 * SEP-40 wire format (#222).
 *
 * These are the tests that matter most for an oracle, because the failure mode
 * here is not an exception — it is a number that looks right and is wrong by
 * four orders of magnitude, read by a contract that trusts it. So the scale,
 * the trimming and the asset identity each get pinned against an independent
 * derivation rather than against the function under test.
 */
import { describe, it, expect, vi } from 'vitest'
import { Asset, Networks, StrKey } from '@stellar/stellar-sdk'

vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    network: {
      passphrase:
        network === 'mainnet'
          ? Networks.PUBLIC
          : 'Test SDF Network ; September 2015',
    },
  }),
}))

import {
  Sep40EncodingError,
  assetFromScVal,
  assetFromSpecArg,
  assetKey,
  assetToScVal,
  assetToSpecArg,
  scalePrice,
  toSep40Asset,
  trimTimestamp,
  unscalePrice,
  venuesToSpecArg,
} from '../publish/sep40'

// The testnet USDC issuer from .env.example's WATCHED_PAIRS entry, verbatim.
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
// The mainnet USDC issuer Lens watches, and the Stellar Asset Contract id that
// issuer is known by on mainnet. Both halves are written out here on purpose:
// the assertion is that the derivation in sep40.ts reproduces the published
// address, which it can only do if code AND issuer are both carried through.
const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const MAINNET_USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

describe('scalePrice / unscalePrice', () => {
  it('scales through fixed-point, not a float multiply', () => {
    // 0.29 * 1e14 is 28999999999999.996 — not an integer, so BigInt() of the
    // product throws and Math.round() of it would publish 28999999999999. The
    // string path is exact, and this pins which one ran.
    expect(Number.isInteger(0.29 * 1e14)).toBe(false)
    expect(scalePrice(0.29, 14)).toBe(29_000_000_000_000n)
    expect(scalePrice(0.1, 14)).toBe(10_000_000_000_000n)
    expect(scalePrice(1.5, 7)).toBe(15_000_000n)
    expect(scalePrice(123.456, 0)).toBe(123n)
  })

  it('round-trips a price back to the value a consumer would read', () => {
    for (const price of [0.0000001, 1, 2.71828, 19.95, 4321.5]) {
      expect(unscalePrice(scalePrice(price, 14), 14)).toBeCloseTo(price, 10)
    }
  })

  it('refuses a price that is not a positive finite number', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => scalePrice(bad, 14)).toThrow(Sep40EncodingError)
    }
  })

  it('refuses decimals the feed could not have been configured with', () => {
    expect(() => scalePrice(1, -1)).toThrow(/between 0 and 36/)
    expect(() => scalePrice(1, 37)).toThrow(/between 0 and 36/)
    expect(() => scalePrice(1, 1.5)).toThrow(/between 0 and 36/)
  })

  it('refuses a scaled value that overflows i128', () => {
    // 1e20 * 1e36 is 1e56, well over the 1.7e38 an i128 holds, while the same
    // price at 14 decimals (1e34) fits comfortably.
    expect(scalePrice(1e20, 14)).toBe(10n ** 34n)
    expect(() => scalePrice(1e20, 36)).toThrow(/overflows i128/)
  })

  it('refuses a price it cannot even write in fixed-point', () => {
    // Number#toFixed switches to exponential notation at 1e21, where the digit
    // string is no longer a number. Better a named error than a rejected tx.
    expect(() => scalePrice(1e24, 14)).toThrow(/cannot be written in fixed-point/)
  })
})

describe('trimTimestamp', () => {
  it('floors to the feed tick, which is what SEP-40 defines', () => {
    // 1_760_000_049 is 9 seconds into a 60-second tick.
    expect(trimTimestamp(1_760_000_049_000, 60)).toBe(1_760_000_040)
    expect(trimTimestamp(1_760_000_040_000, 60)).toBe(1_760_000_040)
    // One millisecond before the tick belongs to the tick before it — that is
    // what "floor" means, and it is why a report never claims a future tick.
    expect(trimTimestamp(1_760_000_039_999, 60)).toBe(1_759_999_980)
    expect(trimTimestamp(1_760_000_049_000, 1)).toBe(1_760_000_049)
  })

  it('refuses a resolution that cannot divide a timestamp', () => {
    expect(() => trimTimestamp(Date.now(), 0)).toThrow(/positive whole number/)
    expect(() => trimTimestamp(Date.now(), 2.5)).toThrow(/positive whole number/)
  })
})

describe('toSep40Asset', () => {
  it('names native XLM by symbol, because it has no asset contract', () => {
    expect(toSep40Asset({ code: 'XLM', issuer: null }, 'testnet')).toEqual({
      kind: 'other',
      symbol: 'XLM',
    })
  })

  it('derives the anchored asset id from code and issuer rather than a list', () => {
    const asset = toSep40Asset({ code: 'USDC', issuer: TESTNET_USDC_ISSUER }, 'testnet')
    expect(asset.kind).toBe('stellar')
    if (asset.kind === 'stellar') {
      expect(StrKey.isValidContract(asset.contractId)).toBe(true)
      // Independent derivation: the SDK hashes the asset's own LedgerKey.
      expect(asset.contractId).toBe(
        new Asset('USDC', TESTNET_USDC_ISSUER).contractId('Test SDF Network ; September 2015')
      )
    }
  })

  it('reproduces the published mainnet USDC contract address', () => {
    const asset = toSep40Asset({ code: 'USDC', issuer: MAINNET_USDC_ISSUER }, 'mainnet')
    expect(asset).toEqual({ kind: 'stellar', contractId: MAINNET_USDC_SAC })
    // and the same derivation the assertion is checked against
    expect(new Asset('USDC', MAINNET_USDC_ISSUER).contractId(Networks.PUBLIC)).toBe(MAINNET_USDC_SAC)
  })

  it('keeps two tokens that share a code apart', () => {
    const real = toSep40Asset({ code: 'USDC', issuer: TESTNET_USDC_ISSUER }, 'testnet')
    // A second issuer that is structurally valid, built from raw bytes rather
    // than typed by hand: the point of the assertion is that two *resolvable*
    // issuers give two different assets, which a mangled address cannot show.
    const otherIssuer = StrKey.encodeEd25519PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
    const imposter = toSep40Asset({ code: 'USDC', issuer: otherIssuer }, 'testnet')
    expect(assetKey(real)).not.toBe(assetKey(imposter))
    // A near-miss address is a refusal, not a second asset.
    expect(() =>
      toSep40Asset(
        { code: 'USDC', issuer: 'GBBE47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
        'testnet'
      )
    ).toThrow(/not a valid G/)
  })

  it('refuses an anchored asset whose issuer is not an account id', () => {
    expect(() => toSep40Asset({ code: 'USDC', issuer: 'not-an-account' }, 'testnet')).toThrow(
      /not a valid G\.\.\. account id/
    )
  })
})

describe('Asset encoding on the wire', () => {
  it('round-trips both variants through the spec union', () => {
    const stellar: Parameters<typeof assetToSpecArg>[0] = {
      kind: 'stellar',
      contractId: MAINNET_USDC_SAC,
    }
    expect(assetToSpecArg(stellar)).toEqual({ tag: 'Stellar', values: [MAINNET_USDC_SAC] })
    expect(assetFromSpecArg(assetToSpecArg(stellar))).toEqual(stellar)

    const other = { kind: 'other', symbol: 'XLM' } as const
    expect(assetToSpecArg(other)).toEqual({ tag: 'Other', values: ['XLM'] })
    expect(assetFromSpecArg(assetToSpecArg(other))).toEqual(other)
  })

  it('encodes a contracttype enum variant as Vec[Symbol(variant), value]', () => {
    const stellar = { kind: 'stellar', contractId: MAINNET_USDC_SAC } as const
    const vec = assetToScVal(stellar).vec()
    expect(vec).toHaveLength(2)
    expect(vec![0].sym().toString()).toBe('Stellar')
    expect(assetFromScVal(assetToScVal(stellar))).toEqual(stellar)
    expect(assetFromScVal(assetToScVal({ kind: 'other', symbol: 'XLM' }))).toEqual({
      kind: 'other',
      symbol: 'XLM',
    })
    // The Stellar branch carries an ADDRESS, not a string: a consumer decoding
    // the vec gets back the same contract id it asked about.
    const other = { kind: 'other', symbol: 'XLM' } as const
    const otherVec = assetToScVal(other).vec()
    expect(otherVec![0].sym().toString()).toBe('Other')
    expect(otherVec![1].sym().toString()).toBe('XLM')
  })

  it('rejects a value that is not an Asset union', () => {
    expect(() => assetFromSpecArg({ tag: 'Stellar', values: ['GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'] })).toThrow(
      /not a C\.\.\. contract id/
    )
    expect(() => assetFromSpecArg('XLM')).toThrow(/expected a SEP-40 Asset/)
    expect(() => assetFromSpecArg({ tag: 'Weird', values: ['x'] })).toThrow(/unknown SEP-40 Asset variant/)
  })
})

describe('venuesToSpecArg', () => {
  it('refuses to name zero venues behind a number', () => {
    // This is the instruction the whole feature hangs on, so the message is
    // asserted too: a silent skip is how an unsourced price gets through.
    expect(() => venuesToSpecArg([])).toThrow(/a price you cannot source is worse than no price/)
  })

  it('caps the list at what the contract stores', () => {
    const many = Array.from({ length: 17 }, (_, i) => `venue_${i}`)
    expect(() => venuesToSpecArg(many)).toThrow(/exceed the feed's limit of 16/)
  })

  it('refuses a venue name the ledger cannot hold', () => {
    expect(() => venuesToSpecArg(['a_venue_name_that_is_definitely_longer_than_thirty_two_bytes'])).toThrow(
      /Soroban symbol limit/
    )
  })

  it('dedupes and sorts so the same sources encode identically', () => {
    expect(venuesToSpecArg(['soroswap_amm', 'SDEX', 'SDEX'])).toEqual(['SDEX', 'soroswap_amm'])
  })
})
