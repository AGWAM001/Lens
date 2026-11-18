import { prisma } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { deliverJsonWithRetries } from './delivery'
import { priceEmitter } from '../events'
import { createLogger } from '../logger'

const log = createLogger('dispersion')

export const DISPERSION_ALERT_EVENT = 'dispersion:alert'

export interface VenueQuote {
  venue: string
  price: number
  timestamp: Date
}

export interface VenueDispersionAlertPayload {
  type: 'venue_dispersion'
  pairKey: string
  assetA: string
  assetB: string
  network: NetworkName
  dispersionPct: number
  thresholdPct: number
  outlyingVenue: string
  outlierDeviationPct: number
  median: number
  venueCount: number
  venues: Array<{
    venue: string
    price: number
    deviationPct: number
  }>
  staleVenues: string[]
  isAmbiguous: boolean
  timestamp: string
}

// ── In-Memory Alert Cooldown Suppression ─────────────────────────────────────
// Keyed by `${network}:${pairKey}`
const lastAlertTimestamp = new Map<string, number>()

export function _resetDispersionAlertCooldown(): void {
  lastAlertTimestamp.clear()
}

export function isAlertSuppressed(
  key: string,
  cooldownSeconds: number,
  now: number = Date.now()
): boolean {
  const last = lastAlertTimestamp.get(key)
  if (!last) return false
  return now - last < cooldownSeconds * 1000
}

export function recordAlertFired(key: string, now: number = Date.now()): void {
  lastAlertTimestamp.set(key, now)
}

export function clearAlertState(key: string): void {
  lastAlertTimestamp.delete(key)
}

/**
 * Builds the payload for a cross-venue dispersion alert.
 */
export function buildDispersionAlertPayload(params: {
  pairKey: string
  assetA: string
  assetB: string
  network: NetworkName
  dispersionPct: number
  thresholdPct: number
  outlyingVenue: string
  outlierDeviationPct: number
  median: number
  venueCount: number
  venues: Array<{ venue: string; price: number; deviationPct: number }>
  staleVenues: string[]
  isAmbiguous: boolean
  timestamp?: string
}): VenueDispersionAlertPayload {
  return {
    type: 'venue_dispersion',
    pairKey: params.pairKey,
    assetA: params.assetA,
    assetB: params.assetB,
    network: params.network,
    dispersionPct: params.dispersionPct,
    thresholdPct: params.thresholdPct,
    outlyingVenue: params.outlyingVenue,
    outlierDeviationPct: params.outlierDeviationPct,
    median: params.median,
    venueCount: params.venueCount,
    venues: params.venues,
    staleVenues: params.staleVenues,
    isAmbiguous: params.isAmbiguous,
    timestamp: params.timestamp ?? new Date().toISOString(),
  }
}

/**
 * Delivers a dispersion alert through the existing alerts path:
 * 1. Delivers signed JSON payloads to registered webhooks watching either asset of the pair.
 * 2. Emits a `dispersion:alert` event on the shared `priceEmitter`.
 */
export async function dispatchDispersionAlert(
  payload: VenueDispersionAlertPayload
): Promise<number> {
  const { assetA, assetB, network } = payload

  // Emit on shared priceEmitter so in-process listeners / websockets receive it immediately
  try {
    priceEmitter.emit(DISPERSION_ALERT_EVENT, payload)
  } catch (err) {
    log.error({ err }, 'failed to emit dispersion alert on priceEmitter')
  }

  // Find webhooks registered for this network and pair
  const webhooks = await prisma.webhook.findMany({
    where: {
      network,
      assetA: assetA.toUpperCase(),
      assetB: assetB.toUpperCase(),
    },
  })

  if (webhooks.length === 0) return 0

  await Promise.allSettled(
    webhooks.map((wh) => deliverJsonWithRetries(wh.url, payload, wh.secret))
  )

  return webhooks.length
}
