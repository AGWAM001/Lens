import { prisma } from './db'
import { activeNetwork, type NetworkName } from './config'
import { buildThresholdAlertPayload, crossesThreshold, deliverJsonWithRetries } from './alerts'

export interface PriceUpdate {
  assetA: string
  assetB: string
  previousPrice: number
  currentPrice: number
  network?: NetworkName
}

export async function dispatchPriceUpdate(update: PriceUpdate): Promise<void> {
  const { assetA, assetB, previousPrice, currentPrice, network = activeNetwork } = update

  const webhooks = await prisma.webhook.findMany({
    where: {
      network,
      assetA: assetA.toUpperCase(),
      assetB: assetB.toUpperCase(),
    },
  })

  if (webhooks.length === 0) return

  const triggered = webhooks.filter(wh => crossesThreshold(wh, previousPrice, currentPrice))

  if (triggered.length === 0) return

  const timestamp = new Date().toISOString()

  await Promise.allSettled(
    triggered.map(wh =>
      deliverJsonWithRetries(
        wh.url,
        buildThresholdAlertPayload(wh, assetA, assetB, currentPrice, timestamp),
        wh.secret
      )
    )
  )
}