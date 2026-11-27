import 'dotenv/config'
import { pathToFileURL } from 'url'
import WebSocket from 'ws'
import {
  buildThresholdAlertPayload,
  crossesThreshold,
  deliverJsonWithRetries,
  type ThresholdDirection,
} from '../../src/alerts'

const HELP_TEXT = `Usage: npm run alert:bot [-- --once]

A "if XLM > X notify me" bot. It connects to the Lens WebSocket price
stream, watches a single pair, and fires a notification the moment the
price crosses your threshold.

Flags:
  --once   Exit after the first alert fires (handy for testing).
  --help   Show this message.

Environment:
  ALERT_BOT_WS_URL=ws://localhost:3002/ws   Lens WebSocket endpoint
  ALERT_BOT_ASSET_A=XLM                      Base asset to watch
  ALERT_BOT_ASSET_B=USDC                     Quote asset
  ALERT_BOT_THRESHOLD=0.15                   Price level to alert on
  ALERT_BOT_DIRECTION=above                  "above" or "below"
  ALERT_BOT_PAYMENT=                         Optional base64 X-PAYMENT for gated streams
  ALERT_BOT_NOTIFY_URL=                      Optional HTTPS URL to POST alerts to
  ALERT_BOT_NOTIFY_SECRET=                   Optional HMAC secret for the notify URL
`

export interface AlertBotConfig {
  wsUrl: string
  assetA: string
  assetB: string
  threshold: number
  direction: ThresholdDirection
  payment?: string
  notifyUrl?: string
  notifySecret: string
}

interface PriceUpdateMessage {
  type: string
  message?: string
  /** pairKey, e.g. "USDC:ISSUER/XLM" */
  pair: string
  network: string
  price: number
  /** null until this process has seen an earlier price for the same pair+network. */
  previousPrice: number | null
  ts: string
}

function parseDirection(raw: string | undefined): ThresholdDirection {
  if (raw === 'above' || raw === 'below') return raw
  throw new Error('ALERT_BOT_DIRECTION must be "above" or "below"')
}

export function readConfig(): AlertBotConfig {
  const wsUrl = process.env.ALERT_BOT_WS_URL ?? 'ws://localhost:3002/ws'
  const assetA = (process.env.ALERT_BOT_ASSET_A ?? 'XLM').toUpperCase()
  const assetB = (process.env.ALERT_BOT_ASSET_B ?? 'USDC').toUpperCase()
  const threshold = Number(process.env.ALERT_BOT_THRESHOLD)
  const direction = parseDirection(process.env.ALERT_BOT_DIRECTION ?? 'above')

  if (!Number.isFinite(threshold)) {
    throw new Error('ALERT_BOT_THRESHOLD must be a number (e.g. 0.15)')
  }

  return {
    wsUrl,
    assetA,
    assetB,
    threshold,
    direction,
    payment: process.env.ALERT_BOT_PAYMENT || undefined,
    notifyUrl: process.env.ALERT_BOT_NOTIFY_URL || undefined,
    notifySecret: process.env.ALERT_BOT_NOTIFY_SECRET ?? 'alert-bot',
  }
}

/** Asset codes from a pairKey, ignoring issuers, in stable order. */
function pairCodes(pair: string): string[] {
  return pair.split('/').map(side => side.split(':')[0].toUpperCase()).sort()
}

/** True when a price update is for the pair we are watching (either order). */
export function matchesPair(config: AlertBotConfig, msg: Pick<PriceUpdateMessage, 'pair'>): boolean {
  const want = [config.assetA, config.assetB].sort().join('/')
  return pairCodes(msg.pair).join('/') === want
}

async function fireAlert(config: AlertBotConfig, currentPrice: number, timestamp: string): Promise<void> {
  const payload = buildThresholdAlertPayload(config, config.assetA, config.assetB, currentPrice, timestamp)

  console.log(
    `[alert-bot] ALERT ${payload.assetA}/${payload.assetB} is ${config.direction} ${config.threshold} ` +
    `— price ${currentPrice} at ${timestamp}`
  )

  if (config.notifyUrl) {
    await deliverJsonWithRetries(config.notifyUrl, payload, config.notifySecret)
  }
}

export async function runAlertBot(config = readConfig(), once = false): Promise<void> {
  const headers = config.payment ? { 'X-PAYMENT': config.payment } : undefined
  const ws = new WebSocket(config.wsUrl, { headers })

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      console.log(
        `[alert-bot] connected to ${config.wsUrl} — watching ${config.assetA}/${config.assetB} ` +
        `${config.direction} ${config.threshold}`
      )
      resolve()
    })
    ws.on('error', reject)
  })

  await new Promise<void>((resolve, reject) => {
    ws.on('message', (data: WebSocket.RawData) => {
      let msg: PriceUpdateMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (msg.type === 'error') {
        reject(new Error(msg.message ?? 'stream error'))
        return
      }
      if (msg.type !== 'price_update' || !matchesPair(config, msg)) return
      // The first event for a pair has no previous price to cross from.
      if (msg.previousPrice === null || msg.previousPrice === undefined) return

      if (crossesThreshold(config, msg.previousPrice, msg.price)) {
        void fireAlert(config, msg.price, msg.ts)
        if (once) {
          ws.close()
          resolve()
        }
      }
    })

    ws.on('close', () => resolve())
    ws.on('error', reject)
  })
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(HELP_TEXT.trim())
    return
  }

  const once = process.argv.includes('--once')
  await runAlertBot(undefined, once)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(err => {
    console.error('[alert-bot] fatal error:', (err as Error).message)
    process.exit(1)
  })
}
