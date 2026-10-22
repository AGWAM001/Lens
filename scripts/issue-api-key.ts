/**
 * CLI to mint the first (or any) Lens API key.
 *
 * The plaintext key is printed exactly once — only its SHA-256 hash is stored.
 * Run with:
 *   npm run key:issue -- --label "Acme integrator" --per-min 120 --per-day 50000
 *
 * Requires DATABASE_URL to be set (same as the server).
 */
import 'dotenv/config'
import { randomBytes, createHash } from 'crypto'
import { PrismaClient } from '@prisma/client'

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = 'true'
      }
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const label = args.label ?? 'default'
  const ratePerMin = args['per-min'] ? parseInt(args['per-min'], 10) : undefined
  const ratePerDay = args['per-day'] ? parseInt(args['per-day'], 10) : undefined
  const rawScopes = args.scopes ?? args.scope
  const scopes = rawScopes ? rawScopes.split(',').map((s) => s.trim()).filter(Boolean) : undefined

  const plaintext = `lens_${randomBytes(24).toString('hex')}`
  const hash = createHash('sha256').update(plaintext, 'utf8').digest('hex')

  const prisma = new PrismaClient()
  try {
    const record = await prisma.apiKey.create({
      data: {
        hash,
        label,
        ...(ratePerMin !== undefined ? { ratePerMin } : {}),
        ...(ratePerDay !== undefined ? { ratePerDay } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
      },
    })

    console.log('✅ API key created.')
    console.log(`   id:         ${record.id}`)
    console.log(`   label:      ${record.label}`)
    console.log(`   ratePerMin: ${record.ratePerMin}`)
    console.log(`   ratePerDay: ${record.ratePerDay}`)
    console.log(`   scopes:     ${record.scopes?.join(', ') || '(all)'}`)
    console.log('')
    console.log('   Plaintext key (store it now — it will not be shown again):')
    console.log(`   ${plaintext}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error('Failed to create API key:', err)
  process.exit(1)
})
