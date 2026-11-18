-- AlterTable
ALTER TABLE "lending_rates" ADD COLUMN     "asset_address" TEXT,
ADD COLUMN     "borrow_apr" DECIMAL(18,8),
ADD COLUMN     "reserves" DECIMAL(36,7),
ADD COLUMN     "supply_apr" DECIMAL(18,8),
ADD COLUMN     "total_borrowed" DECIMAL(36,7),
ADD COLUMN     "total_supply" DECIMAL(36,7),
ADD COLUMN     "utilization" DECIMAL(18,8);

-- CreateIndex
CREATE INDEX "lending_rates_network_pool_id_asset_timestamp_idx" ON "lending_rates"("network", "pool_id", "asset", "timestamp" DESC);
