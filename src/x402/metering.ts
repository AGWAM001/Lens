import Redis from 'ioredis'
import { redis } from '../redis'
import { prisma } from '../db'
import { ApiKeyContext } from '../api/auth'

type OveragePolicy = 'block' | 'charge_402' | 'allow_overage'

interface QuotaConfig {
  monthlyQuotaCents: number
  dailyQuotaCents: number
  overagePolicy: OveragePolicy
}

export interface UsageSummary {
  keyId: string
  dailyCalls: number
  dailyCents: number
  monthlyCalls: number
  monthlyCents: number
  dailyQuotaCents: number
  monthlyQuotaCents: number
  dailyRemainingCents: number
  monthlyRemainingCents: number
  overagePolicy: OveragePolicy
  quotaExceeded: boolean
  dailyResetsAt: string
  monthlyResetsAt: string
  resets: {
    daily: string
    monthly: string
  }
  resetsInSeconds: {
    daily: number
    monthly: number
  }
}

function getDailyBase(keyId: string): string {
  const d = new Date()
  return `lens:x402:quota:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}:${keyId}`
}

function getMonthlyBase(keyId: string): string {
  const d = new Date()
  return `lens:x402:quota:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}:${keyId}`
}

function secondsUntilEndOfDay(): number {
  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return Math.max(1, Math.floor((end.getTime() - now.getTime()) / 1000))
}

function secondsUntilEndOfMonth(): number {
  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return Math.max(1, Math.floor((end.getTime() - now.getTime()) / 1000))
}

export async function getQuotaConfig(keyId: string): Promise<QuotaConfig> {
  const record = await prisma.apiKey.findUnique({ where: { id: keyId } })
  if (!record) {
    return { monthlyQuotaCents: 10000, dailyQuotaCents: 500, overagePolicy: 'block' }
  }
  return {
    monthlyQuotaCents: record.monthlyQuotaCents ?? 10000,
    dailyQuotaCents: record.dailyQuotaCents ?? 500,
    overagePolicy: (record.overagePolicy as OveragePolicy) ?? 'block',
  }
}

export async function checkQuota(keyId: string): Promise<{ allowed: boolean; reason?: string }> {
  const config = await getQuotaConfig(keyId)
  const summary = await getUsageSummaryInternal(keyId, config)
  if (summary.dailyCents >= summary.dailyQuotaCents || summary.monthlyCents >= summary.monthlyQuotaCents) {
    return { allowed: false, reason: `${config.overagePolicy} quota exceeded` }
  }
  return { allowed: true }
}

export async function recordUsage(keyId: string, centsSpent: number): Promise<void> {
  const db = redis as unknown as Redis
  const multi = db.multi()
  multi.incrby(getDailyBase(keyId) + ':calls', 1)
  multi.incrby(getDailyBase(keyId) + ':cents', centsSpent)
  multi.incrby(getMonthlyBase(keyId) + ':calls', 1)
  multi.incrby(getMonthlyBase(keyId) + ':cents', centsSpent)
  multi.expire(getDailyBase(keyId) + ':calls', secondsUntilEndOfDay())
  multi.expire(getDailyBase(keyId) + ':cents', secondsUntilEndOfDay())
  multi.expire(getMonthlyBase(keyId) + ':calls', secondsUntilEndOfMonth())
  multi.expire(getMonthlyBase(keyId) + ':cents', secondsUntilEndOfMonth())
  await multi.exec()
}

export async function getUsageSummary(keyId: string): Promise<UsageSummary> {
  const config = await getQuotaConfig(keyId)
  return getUsageSummaryInternal(keyId, config)
}

async function getUsageSummaryInternal(keyId: string, config: QuotaConfig): Promise<UsageSummary> {
  const db = redis as unknown as Redis
  const [
    dailyCallsRaw,
    dailyCentsRaw,
    monthlyCallsRaw,
    monthlyCentsRaw,
  ] = await Promise.all([
    db.get(getDailyBase(keyId) + ':calls'),
    db.get(getDailyBase(keyId) + ':cents'),
    db.get(getMonthlyBase(keyId) + ':calls'),
    db.get(getMonthlyBase(keyId) + ':cents'),
  ])

  const dailyCalls = parseInt(dailyCallsRaw ?? '0', 10)
  const dailyCents = parseInt(dailyCentsRaw ?? '0', 10)
  const monthlyCalls = parseInt(monthlyCallsRaw ?? '0', 10)
  const monthlyCents = parseInt(monthlyCentsRaw ?? '0', 10)

  const quotaExceeded = dailyCents >= config.dailyQuotaCents || monthlyCents >= config.monthlyQuotaCents
  const now = new Date()
  const dailyResetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  const monthlyResetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const dailyResetsAt = dailyResetDate.toISOString()
  const monthlyResetsAt = monthlyResetDate.toISOString()

  return {
    keyId,
    dailyCalls,
    dailyCents,
    monthlyCalls,
    monthlyCents,
    dailyQuotaCents: config.dailyQuotaCents,
    monthlyQuotaCents: config.monthlyQuotaCents,
    dailyRemainingCents: Math.max(0, config.dailyQuotaCents - dailyCents),
    monthlyRemainingCents: Math.max(0, config.monthlyQuotaCents - monthlyCents),
    overagePolicy: config.overagePolicy,
    quotaExceeded,
    dailyResetsAt,
    monthlyResetsAt,
    resets: {
      daily: dailyResetsAt,
      monthly: monthlyResetsAt,
    },
    resetsInSeconds: {
      daily: secondsUntilEndOfDay(),
      monthly: secondsUntilEndOfMonth(),
    },
  }
}

export async function getAllUsageSummaries(): Promise<UsageSummary[]> {
  const keys = await prisma.apiKey.findMany({
    where: { revokedAt: null },
    select: { id: true },
  })
  const summaries = await Promise.all(keys.map(k => getUsageSummary(k.id)))
  return summaries
}

export function parseCents(price: string): number {
  const match = price.match(/^\$(\d+(?:\.\d+)?)$/)
  if (!match) return 0
  return Math.round(parseFloat(match[1]) * 100)
}

export async function copyUsageHistory(sourceKeyId: string, targetKeyId: string): Promise<void> {
  const db = redis as unknown as Redis
  if (!db || typeof db.get !== 'function') return
  try {
    const [
      dailyCalls,
      dailyCents,
      monthlyCalls,
      monthlyCents,
    ] = await Promise.all([
      db.get(getDailyBase(sourceKeyId) + ':calls'),
      db.get(getDailyBase(sourceKeyId) + ':cents'),
      db.get(getMonthlyBase(sourceKeyId) + ':calls'),
      db.get(getMonthlyBase(sourceKeyId) + ':cents'),
    ])

    if (typeof db.multi !== 'function') return
    const multi = db.multi()
    if (dailyCalls) {
      multi.set(getDailyBase(targetKeyId) + ':calls', dailyCalls, 'EX', secondsUntilEndOfDay())
    }
    if (dailyCents) {
      multi.set(getDailyBase(targetKeyId) + ':cents', dailyCents, 'EX', secondsUntilEndOfDay())
    }
    if (monthlyCalls) {
      multi.set(getMonthlyBase(targetKeyId) + ':calls', monthlyCalls, 'EX', secondsUntilEndOfMonth())
    }
    if (monthlyCents) {
      multi.set(getMonthlyBase(targetKeyId) + ':cents', monthlyCents, 'EX', secondsUntilEndOfMonth())
    }
    if (typeof multi.exec === 'function') {
      await multi.exec()
    }
  } catch {
    // Graceful fallback if Redis mock or server fails
  }
}
