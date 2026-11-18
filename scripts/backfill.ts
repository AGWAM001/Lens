/**
 * CLI command to backfill data for a given source, pair, and time range.
 *
 * Usage:
 *   npm run backfill -- --source SDEX --pair XLM/USDC --start 2026-10-15T00:00:00Z --end 2026-10-15T06:00:00Z
 *   npm run backfill -- --detect --source SDEX --pair XLM/USDC
 *
 * Idempotent: re-running against the same range refetches and writes through
 * the same idempotent live ingestion path (upsertPricePoints), producing zero duplicates.
 */
import 'dotenv/config'
import { activeNetwork, type NetworkName } from '../src/config'
import { backfill } from '../src/backfill/backfillService'
import { detectGaps } from '../src/backfill/gaps'
import { prisma, pgPool } from '../src/db'

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

function printUsage() {
  console.log(`
Usage:
  npm run backfill -- --source <SOURCE> --pair <PAIR> --start <ISO_DATE> --end <ISO_DATE> [--network <NETWORK>]

Options:
  --source   Source venue (e.g. SDEX, AMM, soroswap_amm, aquarius_amm)
  --pair     Watched pair (e.g. XLM/USDC or USDC:GBBD.../XLM)
  --start    Start timestamp (ISO 8601 string)
  --end      End timestamp (ISO 8601 string)
  --network  Stellar network (testnet | mainnet, default: activeNetwork)
  --detect   Run gap detection for the pair/source first
  --cadence  Expected cadence threshold in milliseconds (optional)
`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help || (!args.source && !args.pair && !args.start)) {
    printUsage()
    process.exit(args.help ? 0 : 1)
  }

  const network: NetworkName = (args.network as NetworkName) ?? activeNetwork
  const source = args.source
  const pair = args.pair

  if (!source) {
    console.error('Error: --source is required (e.g. --source SDEX)')
    process.exit(1)
  }
  if (!pair) {
    console.error('Error: --pair is required (e.g. --pair XLM/USDC)')
    process.exit(1)
  }

  try {
    // If --detect flag is set, run detection
    if (args.detect === 'true') {
      console.log(`[gaps:detect] Detecting gaps for source=${source}, pair=${pair}, network=${network}…`)
      const cadenceMs = args.cadence ? parseInt(args.cadence, 10) : undefined
      const start = args.start ? new Date(args.start) : undefined
      const end = args.end ? new Date(args.end) : undefined

      const detected = await detectGaps({
        network,
        pair,
        source,
        start,
        end,
        cadenceMs,
      })

      console.log(`[gaps:detect] Found ${detected.length} gap record(s):`)
      for (const g of detected) {
        console.log(`   - [${g.start.toISOString()} → ${g.end.toISOString()}] status: ${g.status}`)
      }

      if (!args.start && !args.end) {
        // Detection only
        return
      }
    }

    if (!args.start || !args.end) {
      console.error('Error: --start and --end are required for backfill (e.g. --start 2026-10-15T00:00:00Z --end 2026-10-15T06:00:00Z)')
      process.exit(1)
    }

    const start = new Date(args.start)
    const end = new Date(args.end)

    console.log(`[backfill] Running backfill for source=${source}, pair=${pair}, network=${network}`)
    console.log(`   Window: ${start.toISOString()} → ${end.toISOString()}`)

    const result = await backfill({
      source,
      pair,
      start,
      end,
      network,
    })

    if (result.unfillable) {
      console.warn(`⚠️  ${result.message}`)
      console.log('   Result: Unfillable gap recorded with status=permanent.')
    } else {
      console.log('✅ Backfill complete.')
      console.log(`   Points ingested: ${result.pointsIngested}`)
      console.log(`   Gaps updated:    ${result.gapsFilled}`)
    }
  } finally {
    await prisma.$disconnect()
    await pgPool.end()
  }
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', (err as Error).message)
  process.exit(1)
})
