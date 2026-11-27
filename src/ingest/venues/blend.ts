/**
 * Blend Lending Protocol Venue Adapter & Rate Ingester
 *
 * Reads Blend lending pool reserves, calculates derived utilisation,
 * supply APY, and borrow APY, and stores them in the lending_rates table.
 *
 * Unlike DEX venues, lending rates are not spot prices and are stored
 * in their own table (lending_rates) rather than price_points.
 */

import { runCycleWithDeadline } from '../cycleDeadline'
import {
  Address,
  xdr,
  scValToNative,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Account,
  Keypair,
  rpc as SorobanRpc,
} from '@stellar/stellar-sdk'
import { getNetworkConfig, activeNetwork, type NetworkName } from '../../config'
import { getRpcServer } from '../../network/clients'
import { insertLendingRates, type LendingRateInput } from '../../db'
import { blend_pool_errors_total, blend_rates_ingested_total } from '../../metrics'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import { getLastPrice, resetLastPrice, sleep } from './runner'
import { createLogger } from '../../logger'

const log = createLogger('ingester:blend')

// ── Ephemeral Fee Payer for Soroban Simulations ───────────────────────────────
const FEE_PAYER_KEYPAIR = Keypair.random()

// ── In-memory caches ─────────────────────────────────────────────────────────
const assetSymbolCache = new Map<string, string>()

// Common known Stellar tokens on Mainnet and Testnet
const KNOWN_ASSET_SYMBOLS: Record<string, string> = {
  // Mainnet
  CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EZH3MS2UY7: 'XLM',
  CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC: 'XLM',
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: 'USDC',
  CD252NPIMBFLRLNYWVDZEPISECT7NWGCVME5BC2Z5AOZ2MQ27AC7T5NX: 'BLND',
  CA4NZURNP4MWX5CW74WPUEX44WJ4PB7BR4A362XW3J24TF3J77Y7H6K7: 'wETH',
  // Testnet
  CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWUIE3USOPWWYPYYOB7: 'USDC',
}

// ── Test helper hooks matching reference adapter structure ───────────────────
export function _resetLastPrice(): void {
  resetLastPrice('Blend')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('Blend', network, pairKey)
}

// ── Blend pool versions and their number scales (#641) ───────────────────────
//
// Blend v1 and v2 pools store their token rates and rate modifier at different
// fixed-point scales. Every scale below is read from the pool contract source
// at the release tag whose wasm the configured pools run (see
// BLEND_POOL_WASM_VERSIONS):
//
//   v1: blend-capital/blend-contracts    @ v1.0.0  1c1dabab2a6a71f6354d6d59f4307b99760ef3eb
//   v2: blend-capital/blend-contracts-v2 @ v2.0.0  c19abee5b9be4f49e0cda9057e87d343e5dcc095
//
//   field                         v1                  v2
//   b_rate  (ResData)             9 dp  (SCALAR_9)    12 dp (SCALAR_12)
//   d_rate  (ResData)             9 dp  (SCALAR_9)    12 dp (SCALAR_12)
//   ir_mod  (ResData)             9 dp  (SCALAR_9)     7 dp (SCALAR_7)
//   bstop_rate (Config, take)     7 dp  (SCALAR_7)     7 dp (SCALAR_7)
//   util, r_base..r_three (ResConfig)  7 dp            7 dp
//
// v1 sources:
//   SCALAR_9 = 1e9, SCALAR_7 = 1e7
//     https://github.com/blend-capital/blend-contracts/blob/1c1dabab2a6a71f6354d6d59f4307b99760ef3eb/pool/src/constants.rs#L3-L7
//   d_rate, b_rate, ir_mod documented as 9 decimals
//     https://github.com/blend-capital/blend-contracts/blob/1c1dabab2a6a71f6354d6d59f4307b99760ef3eb/pool/src/pool/reserve.rs#L23-L25
//   d_rate accrues with SCALAR_9; bstop_rate applied with SCALAR_7; b_rate set with SCALAR_9
//     https://github.com/blend-capital/blend-contracts/blob/1c1dabab2a6a71f6354d6d59f4307b99760ef3eb/pool/src/pool/reserve.rs#L91-L108
//   b/d tokens convert to underlying with SCALAR_9
//     https://github.com/blend-capital/blend-contracts/blob/1c1dabab2a6a71f6354d6d59f4307b99760ef3eb/pool/src/pool/reserve.rs#L159-L172
//   borrow rate = base_rate * ir_mod / SCALAR_9; ir_mod bounded to [SCALAR_9 / 10, 10 * SCALAR_9]
//     https://github.com/blend-capital/blend-contracts/blob/1c1dabab2a6a71f6354d6d59f4307b99760ef3eb/pool/src/pool/interest.rs#L40-L42
//     https://github.com/blend-capital/blend-contracts/blob/1c1dabab2a6a71f6354d6d59f4307b99760ef3eb/pool/src/pool/interest.rs#L84
//     https://github.com/blend-capital/blend-contracts/blob/1c1dabab2a6a71f6354d6d59f4307b99760ef3eb/pool/src/pool/interest.rs#L99
//   bstop_rate and util/r_* are 7 decimals
//     https://github.com/blend-capital/blend-contracts/blob/1c1dabab2a6a71f6354d6d59f4307b99760ef3eb/pool/src/storage.rs#L28
//     https://github.com/blend-capital/blend-contracts/blob/1c1dabab2a6a71f6354d6d59f4307b99760ef3eb/pool/src/storage.rs#L49-L54
//
// v2 sources:
//   SCALAR_12 = 1e12, SCALAR_7 = 1e7
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/constants.rs#L3-L7
//   d_rate, b_rate 12 decimals; ir_mod 7 decimals
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/storage.rs#L72-L74
//   d_rate accrues with SCALAR_12; bstop_rate applied with SCALAR_7; b_rate set with SCALAR_12
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/pool/reserve.rs#L72
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/pool/reserve.rs#L98-L106
//   b/d tokens convert to underlying with SCALAR_12
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/pool/reserve.rs#L174-L184
//   borrow rate = base_rate * ir_mod / SCALAR_7; ir_mod bounded to [SCALAR_7 / 10, 10 * SCALAR_7]
//   (the doc comment at interest.rs#L17 still says "9 decimals"; the code uses SCALAR_7)
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/pool/interest.rs#L37
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/pool/interest.rs#L72
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/pool/interest.rs#L83
//   bstop_rate and util/r_* are 7 decimals
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/storage.rs#L29
//     https://github.com/blend-capital/blend-contracts-v2/blob/c19abee5b9be4f49e0cda9057e87d343e5dcc095/pool/src/storage.rs#L50-L55

export type BlendPoolVersion = 1 | 2

export interface BlendScales {
  /** Decimals of `b_rate` and `d_rate` (bToken/dToken to underlying). */
  rateDecimals: number
  /** Decimals of `ir_mod`, the interest rate curve modifier. */
  irModDecimals: number
  /** Decimals of the pool's `bstop_rate` (backstop take rate). */
  backstopRateDecimals: number
  /** Decimals of the ResConfig curve fields: `util`, `r_base`, `r_one`, `r_two`, `r_three`. */
  configDecimals: number
}

export const BLEND_SCALES: Readonly<Record<BlendPoolVersion, Readonly<BlendScales>>> = {
  1: { rateDecimals: 9, irModDecimals: 9, backstopRateDecimals: 7, configDecimals: 7 },
  2: { rateDecimals: 12, irModDecimals: 7, backstopRateDecimals: 7, configDecimals: 7 },
}

/**
 * A pool's version is the Blend release whose pool wasm it runs. The hash is
 * the contract instance's executable, which `fetchBlendPool` already reads
 * with the instance entry. Blend pool contracts have no upgrade entrypoint, so
 * a pool's wasm hash never changes. Each hash is the sha256 of the pool wasm
 * attached to that release, and is the hash the configured pools run on chain:
 *
 *   v1: pool_v1.0.0.wasm from
 *       https://github.com/blend-capital/blend-contracts/releases/tag/v1.0.0_pool_v1.0.0.wasm
 *       (tag commit 1c1dabab2a6a71f6354d6d59f4307b99760ef3eb)
 *   v2: pool_v2.0.0.wasm from
 *       https://github.com/blend-capital/blend-contracts-v2/releases/tag/v2.0.0_pool_cli22.0.1
 *       (tag commit c19abee5b9be4f49e0cda9057e87d343e5dcc095)
 *
 * A pool running any other wasm has an unknown version and is skipped: reading
 * it with either table entry could be off by a power of ten.
 */
export const BLEND_POOL_WASM_VERSIONS: Readonly<Record<string, BlendPoolVersion>> = {
  baf978f10efdbcd85747868bef8832845ea6809f7643b67a4ac0cd669327fc2c: 1,
  a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e: 2,
}

/**
 * Maps a pool contract's wasm hash (hex) to its Blend version, or null when
 * the hash is not a known Blend pool release. Never looks at reserve numbers.
 */
export function blendPoolVersionFromWasmHash(wasmHashHex: string | null | undefined): BlendPoolVersion | null {
  if (!wasmHashHex) return null
  const key = wasmHashHex.toLowerCase()
  return Object.prototype.hasOwnProperty.call(BLEND_POOL_WASM_VERSIONS, key)
    ? BLEND_POOL_WASM_VERSIONS[key]
    : null
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BlendReserveConfig {
  index: number
  decimals: number
  c_factor?: number | bigint
  l_factor?: number | bigint
  util: number | bigint
  max_util?: number | bigint
  r_base: number | bigint
  r_one: number | bigint
  r_two: number | bigint
  r_three: number | bigint
  reactivity?: number | bigint
  supply_cap?: bigint
  enabled?: boolean
}

export interface BlendReserveData {
  b_rate?: bigint
  bRate?: bigint
  b_supply?: bigint
  bSupply?: bigint
  d_rate?: bigint
  dRate?: bigint
  d_supply?: bigint
  dSupply?: bigint
  ir_mod?: bigint
  interestRateModifier?: bigint
  backstop_credit?: bigint
  backstopCredit?: bigint
  last_time?: number
  lastTime?: number
}

export interface BlendReserveEntry {
  assetId: string
  assetSymbol: string
  config: BlendReserveConfig
  data: BlendReserveData
  /** Version of the pool this reserve belongs to; selects the scales in BLEND_SCALES. */
  version: BlendPoolVersion
}

export interface BlendPoolData {
  poolId: string
  network: NetworkName
  version: BlendPoolVersion
  backstopRate: bigint
  reserves: BlendReserveEntry[]
}

export interface DerivedRates {
  utilization: number
  borrowApr: number
  supplyApr: number
  borrowApy: number
  supplyApy: number
  totalSupply: number
  totalBorrowed: number
  reserves: number
}

// ── Mathematical Calculations ────────────────────────────────────────────────

/**
 * Derives utilisation as a fraction in [0, 1].
 * Formula: totalLiabilities / totalSupply.
 * Pins arithmetic:
 * - If liabilities <= 0 or supply <= 0 => 0
 * - If liabilities >= supply => 1.0
 * - Otherwise => Number(liabilities) / Number(supply)
 */
export function calcUtilization(
  liabilities: bigint | number,
  supply: bigint | number
): number {
  const liabNum = typeof liabilities === 'bigint' ? Number(liabilities) : liabilities
  const suppNum = typeof supply === 'bigint' ? Number(supply) : supply

  if (liabNum <= 0 || suppNum <= 0 || !Number.isFinite(liabNum) || !Number.isFinite(suppNum)) {
    return 0
  }
  if (liabNum >= suppNum) {
    return 1.0
  }
  return liabNum / suppNum
}

/**
 * Converts raw b/d token supplies to underlying amounts, exactly as the pool
 * contract does (see the source links above the scale table):
 *   totalLiabilities = ceil(dSupply * dRate / 10^rateDecimals)
 *   totalSupply      = floor(bSupply * bRate / 10^rateDecimals)
 * where rateDecimals comes from the pool's version.
 */
function toUnderlyingTotals(
  dSupply: bigint,
  dRate: bigint,
  bSupply: bigint,
  bRate: bigint,
  version: BlendPoolVersion
): { totalLiabilities: bigint; totalSupply: bigint } {
  const scalar = 10n ** BigInt(BLEND_SCALES[version].rateDecimals)
  // mulDivCeil(dSupply, dRate, scalar)
  const dProd = dSupply * dRate
  const totalLiabilities = dProd / scalar + (dProd % scalar > 0n ? 1n : 0n)
  // mulDivFloor(bSupply, bRate, scalar)
  const totalSupply = (bSupply * bRate) / scalar
  return { totalLiabilities, totalSupply }
}

/**
 * Calculates liabilities and supply from raw b/d tokens and derives utilisation,
 * using the b_rate/d_rate scale of the given pool version.
 */
export function deriveUtilization(
  dSupply: bigint,
  dRate: bigint,
  bSupply: bigint,
  bRate: bigint,
  version: BlendPoolVersion
): number {
  const { totalLiabilities, totalSupply } = toUnderlyingTotals(dSupply, dRate, bSupply, bRate, version)
  return calcUtilization(totalLiabilities, totalSupply)
}

/**
 * Calculates APR and APY for borrowers and suppliers from Blend's 3-tier interest rate curve.
 *
 * Curve specs (config fields and the backstop take rate are 7 decimals in v1 and v2;
 * ir_mod is 9 decimals in v1 and 7 in v2, see BLEND_SCALES):
 * - Target utilisation: config.util (usually ~75%)
 * - 95% kink: fixed 95%
 * - Rates: r_base + piecewise slopes (r_one, r_two, r_three) modulated by interestRateModifier
 * - APY compounded: Borrowing daily (365x), Supplying weekly (52x)
 */
export function calcInterestRates(
  config: BlendReserveConfig,
  data: BlendReserveData,
  utilization: number,
  backstopRate: bigint | number,
  version: BlendPoolVersion
): { borrowApr: number; supplyApr: number; borrowApy: number; supplyApy: number } {
  const scales = BLEND_SCALES[version]
  const configScalar = 10 ** scales.configDecimals

  const targetUtil = Number(config.util) / configScalar
  const rBase = Number(config.r_base) / configScalar
  const rOne = Number(config.r_one) / configScalar
  const rTwo = Number(config.r_two) / configScalar
  const rThree = Number(config.r_three) / configScalar

  // A missing modifier is read as 1.0 in this version's scale.
  const rawIrMod = data.ir_mod ?? data.interestRateModifier ?? 10n ** BigInt(scales.irModDecimals)
  const irMod = Number(rawIrMod) / 10 ** scales.irModDecimals

  const bstopTake =
    (typeof backstopRate === 'bigint' ? Number(backstopRate) : backstopRate) / 10 ** scales.backstopRateDecimals

  let borrowApr: number
  if (utilization <= targetUtil) {
    const utilScalar = targetUtil === 0 ? 0 : utilization / targetUtil
    const baseRate = utilScalar * rOne + rBase
    borrowApr = baseRate * irMod
  } else if (utilization <= 0.95) {
    const denom = 0.95 - targetUtil
    const utilScalar = denom === 0 ? 0 : (utilization - targetUtil) / denom
    const baseRate = utilScalar * rTwo + rOne + rBase
    borrowApr = baseRate * irMod
  } else {
    const utilScalar = (utilization - 0.95) / 0.05
    const extraRate = utilScalar * rThree
    const intersection = irMod * (rTwo + rOne + rBase)
    borrowApr = extraRate + intersection
  }

  // Supply capture: (1 - backstopTakeRate) * utilization
  const supplyCapture = Math.max(0, 1 - bstopTake) * utilization
  const supplyApr = borrowApr * supplyCapture

  // Daily compounding for borrow APY: (1 + borrowApr / 365) ** 365 - 1
  const borrowApy = Math.pow(1 + borrowApr / 365, 365) - 1
  // Weekly compounding for supply APY: (1 + supplyApr / 52) ** 52 - 1
  const supplyApy = Math.pow(1 + supplyApr / 52, 52) - 1

  return {
    borrowApr: Number.isFinite(borrowApr) ? borrowApr : 0,
    supplyApr: Number.isFinite(supplyApr) ? supplyApr : 0,
    borrowApy: Number.isFinite(borrowApy) ? borrowApy : 0,
    supplyApy: Number.isFinite(supplyApy) ? supplyApy : 0,
  }
}

/**
 * Derives full rate metrics for a reserve entry.
 */
export function deriveReserveRates(
  reserve: BlendReserveEntry,
  backstopRate: bigint
): DerivedRates {
  // A missing rate is read as 1.0 in this pool version's scale.
  const unitRate = 10n ** BigInt(BLEND_SCALES[reserve.version].rateDecimals)
  const dSupply = reserve.data.d_supply ?? reserve.data.dSupply ?? 0n
  const dRate = reserve.data.d_rate ?? reserve.data.dRate ?? unitRate
  const bSupply = reserve.data.b_supply ?? reserve.data.bSupply ?? 0n
  const bRate = reserve.data.b_rate ?? reserve.data.bRate ?? unitRate

  const { totalLiabilities, totalSupply } = toUnderlyingTotals(dSupply, dRate, bSupply, bRate, reserve.version)

  const utilization = calcUtilization(totalLiabilities, totalSupply)
  const rates = calcInterestRates(reserve.config, reserve.data, utilization, backstopRate, reserve.version)

  const assetDecimals = reserve.config.decimals ?? 7
  const assetDivisor = 10 ** assetDecimals

  const totalSupplyFloat = Number(totalSupply) / assetDivisor
  const totalBorrowedFloat = Number(totalLiabilities) / assetDivisor
  const reservesFloat = Math.max(0, totalSupplyFloat - totalBorrowedFloat)

  return {
    utilization,
    borrowApr: rates.borrowApr,
    supplyApr: rates.supplyApr,
    borrowApy: rates.borrowApy,
    supplyApy: rates.supplyApy,
    totalSupply: totalSupplyFloat,
    totalBorrowed: totalBorrowedFloat,
    reserves: reservesFloat,
  }
}

// ── Asset Symbol Resolution ──────────────────────────────────────────────────

/**
 * Resolves token contract address to human-readable symbol (e.g. 'USDC', 'XLM').
 */
export async function resolveAssetSymbol(
  assetId: string,
  network: NetworkName
): Promise<string> {
  if (KNOWN_ASSET_SYMBOLS[assetId]) {
    return KNOWN_ASSET_SYMBOLS[assetId]
  }

  const cached = assetSymbolCache.get(assetId)
  if (cached) return cached

  try {
    const rpc = getRpcServer(network)
    const contract = new Contract(assetId)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call('symbol'))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
      const sym = scValToNative(sim.result.retval)
      if (typeof sym === 'string' && sym.length > 0) {
        assetSymbolCache.set(assetId, sym)
        return sym
      }
    }
  } catch {
    // Contract simulation failed — fallback below
  }

  // Fallback to shortened contract address
  const fallback = `${assetId.slice(0, 4)}...${assetId.slice(-4)}`
  assetSymbolCache.set(assetId, fallback)
  return fallback
}

// ── Pool State Ingestion ─────────────────────────────────────────────────────

/**
 * Reads the wasm hash (hex) of a contract instance's executable, or null when
 * the instance is not a wasm contract (e.g. a Stellar Asset Contract).
 */
function instanceWasmHash(instance: xdr.ScContractInstance): string | null {
  const executable = instance.executable()
  if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) return null
  return Buffer.from(executable.wasmHash()).toString('hex')
}

/**
 * Fetches raw Blend pool data from Soroban RPC.
 * Returns null if the pool cannot be loaded, or if its version cannot be
 * determined from its wasm hash (see BLEND_POOL_WASM_VERSIONS). A pool of
 * unknown version is never read with a default scale; the caller counts the
 * null as a skipped pool.
 */
export async function fetchBlendPool(
  poolId: string,
  network: NetworkName
): Promise<BlendPoolData | null> {
  const rpc = getRpcServer(network)

  const contractInstanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(poolId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )

  const resListKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(poolId).toScAddress(),
      key: xdr.ScVal.scvSymbol('ResList'),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )

  const initialEntries = await rpc.getLedgerEntries(contractInstanceKey, resListKey)
  if (!initialEntries.entries || initialEntries.entries.length === 0) {
    return null
  }

  let reserveList: string[] = []
  let backstopRate = 1_000_000n // default 10%
  let wasmHash: string | null = null

  for (const entry of initialEntries.entries) {
    const cd = entry.val.contractData()
    const keyScVal = cd.key()

    if (keyScVal.switch() === xdr.ScValType.scvSymbol() && keyScVal.sym().toString() === 'ResList') {
      const nativeList = scValToNative(cd.val())
      if (Array.isArray(nativeList)) {
        reserveList = nativeList.map((addr: any) =>
          typeof addr === 'string' ? addr : addr.toString()
        )
      }
    } else if (keyScVal.switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
      const instance = cd.val().instance()
      wasmHash = instanceWasmHash(instance)
      const storage = instance.storage()
      if (storage) {
        for (const storageEntry of storage) {
          const k = storageEntry.key()
          if (k.switch() === xdr.ScValType.scvSymbol() && k.sym().toString() === 'Config') {
            const configObj = scValToNative(storageEntry.val())
            if (configObj && (configObj.bstop_rate !== undefined || configObj.backstopRate !== undefined)) {
              const rateVal = configObj.bstop_rate ?? configObj.backstopRate
              backstopRate = BigInt(rateVal)
            }
          }
        }
      }
    }
  }

  const version = blendPoolVersionFromWasmHash(wasmHash)
  if (version === null) {
    log.warn(
      { pool: poolId, network, wasmHash },
      'skipping Blend pool: version could not be determined from its wasm hash'
    )
    return null
  }

  if (reserveList.length === 0) {
    return null
  }

  // Fetch reserve configs and reserve data for all assets in the pool
  const ledgerKeys: xdr.LedgerKey[] = []
  for (const assetId of reserveList) {
    ledgerKeys.push(
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(poolId).toScAddress(),
          key: xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol('ResConfig'),
            Address.fromString(assetId).toScVal(),
          ]),
          durability: xdr.ContractDataDurability.persistent(),
        })
      )
    )
    ledgerKeys.push(
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(poolId).toScAddress(),
          key: xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol('ResData'),
            Address.fromString(assetId).toScVal(),
          ]),
          durability: xdr.ContractDataDurability.persistent(),
        })
      )
    )
  }

  const reserveEntries = await rpc.getLedgerEntries(...ledgerKeys)
  const configsMap = new Map<string, BlendReserveConfig>()
  const dataMap = new Map<string, BlendReserveData>()

  for (const entry of reserveEntries.entries ?? []) {
    const cd = entry.val.contractData()
    const k = cd.key()
    if (k.switch() === xdr.ScValType.scvVec()) {
      const vec = k.vec()
      if (!vec || vec.length < 2) continue
      const tag = vec[0].sym().toString()
      const assetAddr = Address.fromScVal(vec[1]).toString()
      const val = scValToNative(cd.val())

      if (tag === 'ResConfig') {
        configsMap.set(assetAddr, val as BlendReserveConfig)
      } else if (tag === 'ResData') {
        dataMap.set(assetAddr, val as BlendReserveData)
      }
    }
  }

  const reserves: BlendReserveEntry[] = []
  for (const assetId of reserveList) {
    const config = configsMap.get(assetId)
    const data = dataMap.get(assetId)
    if (!config || !data) continue

    const assetSymbol = await resolveAssetSymbol(assetId, network)
    reserves.push({
      assetId,
      assetSymbol,
      config,
      data,
      version,
    })
  }

  return {
    poolId,
    network,
    version,
    backstopRate,
    reserves,
  }
}

/**
 * Ingests a single Blend pool.
 * If the pool cannot be read, it is skipped with a log and a metric increment, NOT a crash.
 */
export async function ingestBlendPool(
  poolId: string,
  network: NetworkName,
  fetchPool = fetchBlendPool
): Promise<LendingRateInput[]> {
  try {
    const pool = await fetchPool(poolId, network)
    if (!pool || pool.reserves.length === 0) {
      log.warn({ pool: poolId, network }, 'skipping Blend pool: no reserves found or pool could not be read')
      blend_pool_errors_total.inc({ pool: poolId, network })
      return []
    }

    const rates: LendingRateInput[] = []
    const now = new Date()

    for (const reserve of pool.reserves) {
      const derived = deriveReserveRates(reserve, pool.backstopRate)

      rates.push({
        poolId,
        asset: reserve.assetSymbol,
        assetAddress: reserve.assetId,
        source: 'blend',
        supplyApy: derived.supplyApy,
        borrowApy: derived.borrowApy,
        supplyApr: derived.supplyApr,
        borrowApr: derived.borrowApr,
        utilization: derived.utilization,
        totalSupply: derived.totalSupply,
        totalBorrowed: derived.totalBorrowed,
        reserves: derived.reserves,
        timestamp: now,
      })
    }

    if (rates.length > 0) {
      await insertLendingRates(rates, network)
      blend_rates_ingested_total.inc({ pool: poolId, network }, rates.length)
    }

    return rates
  } catch (err) {
    log.error({ err, pool: poolId, network }, 'failed to ingest Blend pool')
    blend_pool_errors_total.inc({ pool: poolId, network })
    return []
  }
}

/**
 * Ingests all configured Blend pools for a network.
 */
export async function ingestBlendPools(
  network: NetworkName,
  ingestPool = ingestBlendPool,
  signal?: AbortSignal
): Promise<number> {
  const netConfig = getNetworkConfig(network)
  if (!netConfig.blend.enabled) {
    return 0
  }

  let totalIngested = 0
  for (const poolId of netConfig.blend.pools) {
    // Abandonment checkpoint (#351): the cycle deadline has fired, so do not
    // start another pool. One pool is one write unit, so stopping here leaves
    // nothing half-written.
    if (signal?.aborted) break
    try {
      const rates = await ingestPool(poolId, network)
      totalIngested += rates.length
    } catch (err) {
      log.error({ err, pool: poolId, network }, 'failed to ingest Blend pool')
      blend_pool_errors_total.inc({ pool: poolId, network })
    }
  }
  return totalIngested
}

/**
 * Ingests blend pools matching a pair if applicable.
 */
export async function ingestBlendPair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): Promise<void> {
  await ingestBlendPools(network)
}

// ── VenueAdapter Contract Implementation ──────────────────────────────────────

export const blendAdapter: VenueAdapter<BlendPoolData[], BlendReserveEntry[]> = {
  name: 'Blend',
  type: 'Lending Pool',
  description: 'Blend lending pools on Soroban, supply and borrow rates',
  source: 'blend',
  onChain: true,
  sourceTimeCapability: { status: 'unavailable' },
  // Informational here rather than load-bearing: `derive` returns no price
  // points, so Blend contributes nothing to `/volumes` and never reaches the
  // net/gross split (#244). It is 'primary' because it holds its own reserves —
  // it is the venue a DeFindex vault allocates *into*, not one that re-reports
  // another venue's trades.
  classification: 'primary',

  isEnabled(network: NetworkName): boolean {
    return getNetworkConfig(network).blend?.enabled ?? false
  },

  getPollIntervalMs(network: NetworkName): number {
    return getNetworkConfig(network).blend.pollIntervalMs
  },

  async discover(_pair: WatchedPair, network: NetworkName): Promise<BlendPoolData[][]> {
    const netConfig = getNetworkConfig(network)
    if (!netConfig.blend.enabled) return []
    const pools: BlendPoolData[] = []
    for (const poolId of netConfig.blend.pools) {
      const data = await fetchBlendPool(poolId, network)
      if (data) pools.push(data)
    }
    return pools.length > 0 ? [pools] : []
  },

  async read(target: BlendPoolData[], _pair: WatchedPair, _network: NetworkName): Promise<BlendReserveEntry[] | null> {
    return target.flatMap((p) => p.reserves)
  },

  derive(_raw: BlendReserveEntry[], _target: BlendPoolData[], _pair: WatchedPair, _network: NetworkName): VenuePricePoint[] {
    // Blend rates are stored in lending_rates, not price_points.
    return []
  },

  async write(_points: VenuePricePoint[], target: BlendPoolData[], _pair: WatchedPair, network: NetworkName): Promise<void> {
    for (const pool of target) {
      await ingestBlendPool(pool.poolId, network)
    }
  },

  async ingestPair(pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestBlendPair(pair, network)
  },

  _resetLastPrice,
  _getLastPrice,
}

/**
 * Starts the Blend ingester polling loop for a network.
 */
export async function startBlendIngester(
  network: NetworkName = activeNetwork
): Promise<void> {
  const netConfig = getNetworkConfig(network)
  if (!netConfig.blend.enabled) {
    log.info({ network }, 'Blend disabled; ingester not started')
    return
  }

  log.info({ network, pools: netConfig.blend.pools.length }, 'starting Blend lending rate ingester')

  let consecutiveErrors = 0
  while (true) {
    try {
      // Bounded like every other ingester (#351). Blend runs outside
      // startVenueAdapterLoop — it writes lending_rates, not price_points — so
      // without this its cycle has no upper bound: a slow Soroban RPC stretches
      // one sweep indefinitely, the loop never crashes, restartIngester never
      // fires, and the venue goes quiet with nothing raised anywhere.
      await runCycleWithDeadline({
        venue: 'Blend',
        network,
        cycle: async (signal) => {
          await ingestBlendPools(network, ingestBlendPool, signal)
        },
      })
      consecutiveErrors = 0
    } catch (err) {
      consecutiveErrors++
      const backoffMs = Math.min(10_000 * Math.pow(2, consecutiveErrors - 1), 60_000)
      log.error(
        { err, network, attempt: consecutiveErrors, backoffMs },
        'Blend ingestion cycle failed; retrying'
      )
      await sleep(backoffMs)
      continue
    }

    const pollInterval = netConfig.blend.pollIntervalMs
    await sleep(pollInterval)
  }
}
