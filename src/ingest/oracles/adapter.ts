import type { NetworkName } from '../../config'

/** A normalized quote returned by any external price oracle. */
export interface OracleQuote {
  price: number
  /** Unix timestamp in seconds supplied by the oracle. */
  timestamp: number
}

/** Contract for external oracle integrations used by the comparison endpoint. */
export interface OracleAdapter {
  readonly name: string
  isConfigured(network: NetworkName): boolean
  getPrice(asset: string, network: NetworkName): Promise<OracleQuote | null>
}
