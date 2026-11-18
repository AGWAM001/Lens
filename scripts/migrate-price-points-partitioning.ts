import { pgPool } from '../src/db'
import {
  isPricePointsPartitioned,
  migratePricePointsToPartitioned,
  ensurePricePointsPartitions,
  computeTableChecksum,
} from '../src/partitioning/pricePoints'

async function main() {
  console.log('[partitioning-migration] Starting price_points partitioning check...')

  const already = await isPricePointsPartitioned(pgPool)
  if (already) {
    console.log('[partitioning-migration] price_points is already range-partitioned. Ensuring upcoming partitions exist...')
    const creation = await ensurePricePointsPartitions(pgPool, { precreateDays: 14 })
    console.log(`[partitioning-migration] Verified partitions: ${creation.created.length} created, ${creation.existing.length} already existing.`)
    await pgPool.end()
    return
  }

  console.log('[partitioning-migration] price_points is currently unpartitioned. Beginning safe migration...')
  const preCheck = await computeTableChecksum(pgPool, 'price_points')
  console.log(`[partitioning-migration] Source table rows: ${preCheck.rowCount}, checksum: ${preCheck.checksum}`)

  const result = await migratePricePointsToPartitioned(pgPool, {
    precreateDays: 14,
  })

  console.log('[partitioning-migration] Migration completed successfully!')
  console.log(`[partitioning-migration] Preserved rows: ${result.rowCount}`)
  console.log(`[partitioning-migration] Verified checksum: ${result.checksum}`)

  await pgPool.end()
}

main().catch(err => {
  console.error('[partitioning-migration] Fatal error during migration:', err)
  process.exit(1)
})
