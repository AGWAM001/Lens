-- CreateTable
CREATE TABLE "oracle_comparisons" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "asset" TEXT NOT NULL,
    "oracle" TEXT NOT NULL,
    "lens_price" DECIMAL(36,18),
    "oracle_price" DECIMAL(36,18),
    "deviation_pct" DECIMAL(10,4),
    "status" TEXT NOT NULL,
    "venues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sample_count" INTEGER NOT NULL DEFAULT 0,
    "oracle_timestamp" TIMESTAMP(3),
    "age_seconds" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oracle_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oracle_comparisons_network_asset_timestamp_idx" ON "oracle_comparisons"("network", "asset", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "oracle_comparisons_network_asset_oracle_timestamp_idx" ON "oracle_comparisons"("network", "asset", "oracle", "timestamp" DESC);

