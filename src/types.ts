export interface PricePoint {
  id?: string
  assetA: string
  assetB: string
  pairKey: string
  source: 'SDEX' | 'AMM'
  poolId?: string
  price: number
  baseVolume: number
  counterVolume: number
  ledger: number
  timestamp: Date
  eventId?: string
}

export interface AggregatedPrice {
  assetA: string
  assetB: string
  pairKey: string
  price: number | string
  sdexPrice: number | string
  ammPrice: number | string
  bestRoute: 'SDEX' | 'AMM' | 'SPLIT' | 'UNKNOWN'
  volume24h: number | string
  sdexVolume24h: number | string
  ammVolume24h: number | string
  vwap1m: number | string
  vwap5m: number | string
  vwap1h: number | string
  vwap24h: number | string
  priceChange24h: number | string
  lastUpdated: Date
  sources: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  lastTradeAgeSeconds: number | null
  stale: boolean
}

export interface RouteInfo {
  route: 'SDEX' | 'AMM' | 'SPLIT' | 'UNKNOWN'
  sdexPrice: number | string
  ammPrice: number | string
  estimatedOutput: number | string
  slippagePct: number | string
  recommendation: string
}

export interface WatchedPair {
  assetA: AssetId
  assetB: AssetId
  pairKey: string
}

export interface AssetId {
  code: string
  issuer: string | null  // null for native XLM
}

export interface PriceBucket {
  bucket: Date
  window: string
  vwap: number
  sdexVwap: number | null
  ammVwap: number | null
  volume: number
  tradeCount: number
  open: number | null
  close: number | null
  high: number | null
  low: number | null
}
