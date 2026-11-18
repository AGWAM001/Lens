import type { NetworkName } from '../config'

export type GapStatus = 'open' | 'filled' | 'permanent'

export interface GapRecord {
  id: string
  network: NetworkName
  source: string
  pair: string
  start: Date
  end: Date
  status: GapStatus
  detectedAt: Date
  updatedAt: Date
}

export interface OverlappingGapSummary {
  source: string
  start: string
  end: string
  status: 'open' | 'permanent'
}

export interface IncompleteWindowDeclaration {
  incomplete?: boolean
  gaps?: OverlappingGapSummary[]
}

export interface BackfillResult {
  success: boolean
  unfillable?: boolean
  source: string
  pair: string
  network: NetworkName
  start: Date
  end: Date
  pointsIngested: number
  gapsFilled: number
  message?: string
}
