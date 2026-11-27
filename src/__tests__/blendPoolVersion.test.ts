/**
 * #641: a Blend pool's version is read from the chain (the wasm hash of its
 * contract instance), never from the size of its numbers, and a pool whose
 * version is unknown is skipped and counted. These tests build Soroban ledger
 * entries in the shapes the v1.0.0 and v2.0.0 pool contracts store and serve
 * them from a fake RPC; nothing touches the network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Address, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk'

const { mockLogger, mockGetRpcServer } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockGetRpcServer: vi.fn(),
}))

vi.mock('../logger', () => ({
  createLogger: () => mockLogger,
  logger: mockLogger,
}))

vi.mock('../db', () => ({
  insertLendingRates: vi.fn().mockResolvedValue(1),
  getLatestLendingRates: vi.fn().mockResolvedValue([]),
}))

vi.mock('../network/clients', () => ({
  getRpcServer: mockGetRpcServer,
}))

import {
  blendPoolVersionFromWasmHash,
  deriveReserveRates,
  fetchBlendPool,
  ingestBlendPool,
} from '../ingest/venues/blend'
import * as dbModule from '../db'
import { blend_pool_errors_total, blend_rates_ingested_total } from '../metrics'

// sha256 of pool_v1.0.0.wasm (blend-capital/blend-contracts release v1.0.0_pool_v1.0.0.wasm)
const V1_POOL_WASM = 'baf978f10efdbcd85747868bef8832845ea6809f7643b67a4ac0cd669327fc2c'
// sha256 of pool_v2.0.0.wasm (blend-capital/blend-contracts-v2 release v2.0.0_pool_cli22.0.1)
const V2_POOL_WASM = 'a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e'
// Not a Blend release
const UNKNOWN_WASM = '00'.repeat(32)

// Pool ids from MAINNET_BLEND_POOLS in src/config.ts
const V1_POOL = 'CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP' // Fixed Pool v1
const V2_POOL = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD' // Fixed Pool v2
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' // KNOWN_ASSET_SYMBOLS in blend.ts
// Synthetic oracle address; the reader never uses it.
const ORACLE = StrKey.encodeContract(Buffer.alloc(32, 7))

// ── ScVal builders ───────────────────────────────────────────────────────────

/** A #[contracttype] struct: an ScMap keyed by field-name symbols, sorted. */
function scStruct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k] }))
  )
}
const u32 = (n: number) => xdr.ScVal.scvU32(n)
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' })
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' })

// PoolConfig: v1 storage.rs#L26-L31, v2 storage.rs#L26-L32
function poolConfig(version: 1 | 2): xdr.ScVal {
  const common = {
    oracle: Address.fromString(ORACLE).toScVal(),
    bstop_rate: u32(2_000_000), // 20%, 7 decimals in both
    status: u32(0),
    max_positions: u32(8),
  }
  return scStruct(version === 1 ? common : { ...common, min_collateral: i128(0n) })
}

// ReserveConfig: v1 storage.rs#L44-L56, v2 storage.rs#L45-L59
function reserveConfig(version: 1 | 2): xdr.ScVal {
  const common = {
    index: u32(0),
    decimals: u32(7),
    c_factor: u32(7_500_000),
    l_factor: u32(8_000_000),
    util: u32(7_500_000),
    max_util: u32(9_500_000),
    r_base: u32(100_000),
    r_one: u32(400_000),
    r_two: u32(2_000_000),
    r_three: u32(5_000_000),
    reactivity: u32(20),
  }
  return scStruct(
    version === 1
      ? common
      : { ...common, supply_cap: i128(10n ** 18n), enabled: xdr.ScVal.scvBool(true) }
  )
}

/**
 * ReserveData for one position: 1,000,000 bTokens at b_rate 1.1, 500,000
 * dTokens at d_rate 1.32, ir_mod 1.2345678, encoded at the given scales.
 */
function reserveData(encoding: 'v1-scales' | 'v2-scales'): xdr.ScVal {
  const v1 = encoding === 'v1-scales'
  return scStruct({
    b_rate: i128(v1 ? 1_100_000_000n : 1_100_000_000_000n),
    d_rate: i128(v1 ? 1_320_000_000n : 1_320_000_000_000n),
    ir_mod: i128(v1 ? 1_234_567_800n : 12_345_678n),
    b_supply: i128(1_000_000_0000000n),
    d_supply: i128(500_000_0000000n),
    backstop_credit: i128(0n),
    last_time: u64(1_700_000_000n),
  })
}

interface ChainPool {
  poolId: string
  /** hex wasm hash, or null for a non-wasm (Stellar Asset) contract */
  wasmHash: string | null
  config: xdr.ScVal
  resConfig: xdr.ScVal
  resData: xdr.ScVal
}

/** A fake Soroban RPC that serves getLedgerEntries from the given pools. */
function fakeRpc(...pools: ChainPool[]) {
  const store = new Map<string, xdr.LedgerEntryData>()
  const durability = xdr.ContractDataDurability.persistent()

  for (const pool of pools) {
    const contract = Address.fromString(pool.poolId).toScAddress()
    const put = (key: xdr.ScVal, val: xdr.ScVal) => {
      const ledgerKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract, key, durability }))
      store.set(
        ledgerKey.toXDR('base64'),
        xdr.LedgerEntryData.contractData(
          new xdr.ContractDataEntry({ ext: new xdr.ExtensionPoint(0), contract, key, durability, val })
        )
      )
    }
    const executable = pool.wasmHash
      ? xdr.ContractExecutable.contractExecutableWasm(Buffer.from(pool.wasmHash, 'hex'))
      : xdr.ContractExecutable.contractExecutableStellarAsset()
    put(
      xdr.ScVal.scvLedgerKeyContractInstance(),
      xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable,
          storage: [new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('Config'), val: pool.config })],
        })
      )
    )
    put(xdr.ScVal.scvSymbol('ResList'), xdr.ScVal.scvVec([Address.fromString(XLM).toScVal()]))
    put(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('ResConfig'), Address.fromString(XLM).toScVal()]), pool.resConfig)
    put(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('ResData'), Address.fromString(XLM).toScVal()]), pool.resData)
  }

  return {
    getLedgerEntries: vi.fn(async (...keys: xdr.LedgerKey[]) => ({
      latestLedger: 1,
      entries: keys.flatMap((key) => {
        const val = store.get(key.toXDR('base64'))
        return val ? [{ key, val }] : []
      }),
    })),
  }
}

const v1Pool: ChainPool = {
  poolId: V1_POOL,
  wasmHash: V1_POOL_WASM,
  config: poolConfig(1),
  resConfig: reserveConfig(1),
  resData: reserveData('v1-scales'),
}

const v2Pool: ChainPool = {
  poolId: V2_POOL,
  wasmHash: V2_POOL_WASM,
  config: poolConfig(2),
  resConfig: reserveConfig(2),
  resData: reserveData('v2-scales'),
}

describe('Blend pool version detection (#641)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('blendPoolVersionFromWasmHash', () => {
    it('maps the v1.0.0 and v2.0.0 pool wasm hashes to their versions', () => {
      expect(blendPoolVersionFromWasmHash(V1_POOL_WASM)).toBe(1)
      expect(blendPoolVersionFromWasmHash(V2_POOL_WASM)).toBe(2)
      expect(blendPoolVersionFromWasmHash(V2_POOL_WASM.toUpperCase())).toBe(2)
    })

    it('returns null for any other hash or no hash', () => {
      expect(blendPoolVersionFromWasmHash(UNKNOWN_WASM)).toBeNull()
      expect(blendPoolVersionFromWasmHash('')).toBeNull()
      expect(blendPoolVersionFromWasmHash(null)).toBeNull()
      expect(blendPoolVersionFromWasmHash(undefined)).toBeNull()
      expect(blendPoolVersionFromWasmHash('constructor')).toBeNull()
      expect(blendPoolVersionFromWasmHash('__proto__')).toBeNull()
    })
  })

  describe('fetchBlendPool', () => {
    it('reads the version from the pool instance and carries it onto every reserve', async () => {
      mockGetRpcServer.mockReturnValue(fakeRpc(v1Pool, v2Pool))

      const p1 = await fetchBlendPool(V1_POOL, 'mainnet')
      const p2 = await fetchBlendPool(V2_POOL, 'mainnet')

      expect(p1?.version).toBe(1)
      expect(p1?.reserves.map((r) => r.version)).toEqual([1])
      expect(p1?.backstopRate).toBe(2_000_000n)
      expect(p2?.version).toBe(2)
      expect(p2?.reserves.map((r) => r.version)).toEqual([2])
      expect(p2?.backstopRate).toBe(2_000_000n)
    })

    it('a v1 pool and a v2 pool holding the same position produce the same utilisation, totals and rates', async () => {
      mockGetRpcServer.mockReturnValue(fakeRpc(v1Pool, v2Pool))

      const p1 = (await fetchBlendPool(V1_POOL, 'mainnet'))!
      const p2 = (await fetchBlendPool(V2_POOL, 'mainnet'))!
      const r1 = deriveReserveRates(p1.reserves[0], p1.backstopRate)
      const r2 = deriveReserveRates(p2.reserves[0], p2.backstopRate)

      expect(r1).toEqual(r2)
      expect(r1.totalSupply).toBe(1_100_000)
      expect(r1.totalBorrowed).toBe(660_000)
      expect(r1.reserves).toBe(440_000)
      expect(r1.utilization).toBeCloseTo(0.6, 12)
      // (0.6 / 0.75 * 4% + 1%) * 1.2345678
      expect(r1.borrowApr).toBeCloseTo(0.042 * 1.2345678, 10)
      // borrowApr * (1 - 20% backstop) * utilisation
      expect(r1.supplyApr).toBeCloseTo(0.042 * 1.2345678 * 0.8 * 0.6, 10)
    })

    it('never takes the version from the size of the numbers', async () => {
      // Swap the encodings: v1 wasm holding v2-sized numbers and vice versa.
      // The version still follows the wasm hash.
      mockGetRpcServer.mockReturnValue(
        fakeRpc(
          { ...v1Pool, resData: reserveData('v2-scales') },
          { ...v2Pool, resData: reserveData('v1-scales') }
        )
      )

      const p1 = (await fetchBlendPool(V1_POOL, 'mainnet'))!
      const p2 = (await fetchBlendPool(V2_POOL, 'mainnet'))!

      expect(p1.version).toBe(1)
      expect(p1.reserves[0].version).toBe(1)
      expect(p2.version).toBe(2)
      expect(p2.reserves[0].version).toBe(2)
    })

    it('returns null for a pool running an unknown wasm, without reading its reserves', async () => {
      const rpc = fakeRpc({ ...v2Pool, wasmHash: UNKNOWN_WASM })
      mockGetRpcServer.mockReturnValue(rpc)

      expect(await fetchBlendPool(V2_POOL, 'mainnet')).toBeNull()
      expect(rpc.getLedgerEntries).toHaveBeenCalledTimes(1)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ pool: V2_POOL, network: 'mainnet', wasmHash: UNKNOWN_WASM }),
        'skipping Blend pool: version could not be determined from its wasm hash'
      )
    })

    it('returns null for a contract with no wasm (e.g. a Stellar Asset Contract)', async () => {
      mockGetRpcServer.mockReturnValue(fakeRpc({ ...v2Pool, wasmHash: null }))

      expect(await fetchBlendPool(V2_POOL, 'mainnet')).toBeNull()
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ pool: V2_POOL, wasmHash: null }),
        'skipping Blend pool: version could not be determined from its wasm hash'
      )
    })
  })

  describe('ingestBlendPool', () => {
    it('skips and counts a pool whose version cannot be determined, writing nothing', async () => {
      mockGetRpcServer.mockReturnValue(fakeRpc({ ...v1Pool, wasmHash: UNKNOWN_WASM }))
      const errSpy = vi.spyOn(blend_pool_errors_total, 'inc')
      const okSpy = vi.spyOn(blend_rates_ingested_total, 'inc')

      const rates = await ingestBlendPool(V1_POOL, 'mainnet')

      expect(rates).toEqual([])
      expect(errSpy).toHaveBeenCalledWith({ pool: V1_POOL, network: 'mainnet' })
      expect(okSpy).not.toHaveBeenCalled()
      expect(dbModule.insertLendingRates).not.toHaveBeenCalled()
    })

    it('ingests a v1 pool with v1 scales', async () => {
      mockGetRpcServer.mockReturnValue(fakeRpc(v1Pool))

      const rates = await ingestBlendPool(V1_POOL, 'mainnet')

      expect(rates).toHaveLength(1)
      expect(rates[0].asset).toBe('XLM')
      expect(rates[0].totalSupply).toBe(1_100_000)
      expect(rates[0].totalBorrowed).toBe(660_000)
      expect(rates[0].borrowApr).toBeCloseTo(0.042 * 1.2345678, 10)
      expect(dbModule.insertLendingRates).toHaveBeenCalledTimes(1)
    })
  })
})
