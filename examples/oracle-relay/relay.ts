import 'dotenv/config'
import { pathToFileURL } from 'url'
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
} from '@stellar/stellar-sdk'

const HELP_TEXT = `Usage: npm run oracle:relay [-- --once]

Environment:
  ORACLE_RELAY_API_URL=http://localhost:3002
  ORACLE_RELAY_CONTRACT_ID=...
  ORACLE_RELAY_SOURCE_SECRET=...
  ORACLE_RELAY_ASSET_A=XLM
  ORACLE_RELAY_ASSET_B=USDC
  ORACLE_RELAY_INTERVAL_MS=60000
`

export interface OracleRelayConfig {
  apiUrl: string
  contractId: string
  sourceSecret: string
  assetA: string
  assetB: string
  intervalMs: number
  networkPassphrase: string
  rpcUrl: string
}

export interface OraclePriceSnapshot {
  assetA: string
  assetB: string
  price: number | string
  timestamp: string
}

function readConfig(): OracleRelayConfig {
  const apiUrl = process.env.ORACLE_RELAY_API_URL ?? 'http://localhost:3002'
  const contractId = process.env.ORACLE_RELAY_CONTRACT_ID
  const sourceSecret = process.env.ORACLE_RELAY_SOURCE_SECRET
  const assetA = process.env.ORACLE_RELAY_ASSET_A ?? 'XLM'
  const assetB = process.env.ORACLE_RELAY_ASSET_B ?? 'USDC'
  const intervalMs = parseInt(process.env.ORACLE_RELAY_INTERVAL_MS ?? '60000', 10)
  const rpcUrl = process.env.ORACLE_RELAY_RPC_URL ?? 'https://soroban-testnet.stellar.org'
  const networkPassphrase = process.env.ORACLE_RELAY_NETWORK_PASSPHRASE ?? Networks.TESTNET

  if (!contractId) throw new Error('ORACLE_RELAY_CONTRACT_ID is required')
  if (!sourceSecret) throw new Error('ORACLE_RELAY_SOURCE_SECRET is required')

  return {
    apiUrl,
    contractId,
    sourceSecret,
    assetA,
    assetB,
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000,
    networkPassphrase,
    rpcUrl,
  }
}

export async function fetchLensPrice(
  apiUrl: string,
  assetA: string,
  assetB: string,
  options?: { stringDecimals?: boolean }
): Promise<OraclePriceSnapshot> {
  const headers: Record<string, string> = {}
  if (options?.stringDecimals) {
    // Negotiate full 18-decimal precision string serialization
    headers['X-Decimal-Format'] = 'string'
  }

  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/price/${assetA}/${assetB}`, {
    headers,
  })
  if (!response.ok) {
    throw new Error(`Lens price request failed with HTTP ${response.status}`)
  }

  const data = await response.json() as { assetA: string; assetB: string; price: number | string; lastUpdated?: string }
  if (typeof data.price !== 'number' && typeof data.price !== 'string') {
    throw new Error('Lens price payload did not include a valid price')
  }

  return {
    assetA: data.assetA,
    assetB: data.assetB,
    price: data.price,
    timestamp: data.lastUpdated ?? new Date().toISOString(),
  }
}

export function formatOraclePrice(price: number | string): string {
  if (typeof price === 'string') {
    return price
  }
  return price.toFixed(7)
}

async function loadSourceAccount(rpc: SorobanRpc.Server, source: Keypair): Promise<Account> {
  const account = await rpc.getAccount(source.publicKey())
  return new Account(source.publicKey(), account.sequenceNumber())
}

export async function readOraclePrice(
  rpc: SorobanRpc.Server,
  config: OracleRelayConfig,
): Promise<string | null> {
  const source = Keypair.fromSecret(config.sourceSecret)
  const sourceAccount = await loadSourceAccount(rpc, source)
  const contract = new Contract(config.contractId)
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call('get_price'))
    .setTimeout(30)
    .build()

  const simulation = await rpc.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(simulation) || !simulation.result?.retval) {
    return null
  }

  const current = scValToNative(simulation.result.retval)
  return typeof current === 'string' ? current : String(current)
}

export async function pushOraclePrice(
  rpc: SorobanRpc.Server,
  config: OracleRelayConfig,
  snapshot: OraclePriceSnapshot,
): Promise<void> {
  const source = Keypair.fromSecret(config.sourceSecret)
  const sourceAccount = await loadSourceAccount(rpc, source)
  const contract = new Contract(config.contractId)
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call('set_price', nativeToScVal(formatOraclePrice(snapshot.price))))
    .setTimeout(30)
    .build()

  const prepared = await rpc.prepareTransaction(tx)
  prepared.sign(source)
  await rpc.sendTransaction(prepared)
}

export async function runOracleRelay(config = readConfig(), once = false): Promise<void> {
  const rpc = new SorobanRpc.Server(config.rpcUrl, { allowHttp: true })

  do {
    const snapshot = await fetchLensPrice(config.apiUrl, config.assetA, config.assetB)
    const currentPrice = await readOraclePrice(rpc, config)
    await pushOraclePrice(rpc, config, snapshot)

    console.log(
      `[oracle-relay] ${snapshot.assetA}/${snapshot.assetB} price ${formatOraclePrice(snapshot.price)} ` +
      `(on-chain: ${currentPrice ?? 'unavailable'})`
    )

    if (!once) {
      await new Promise(resolve => setTimeout(resolve, config.intervalMs))
    }
  } while (!once)
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(HELP_TEXT.trim())
    return
  }

  const once = process.argv.includes('--once')
  await runOracleRelay(undefined, once)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(err => {
    console.error('[oracle-relay] fatal error:', (err as Error).message)
    process.exit(1)
  })
}