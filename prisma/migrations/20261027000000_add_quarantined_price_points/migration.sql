-- CreateTable
CREATE TABLE "quarantined_price_points" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "asset_a" TEXT NOT NULL,
    "asset_b" TEXT NOT NULL,
    "pair_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "pool_id" TEXT,
    "price" DECIMAL(36,18) NOT NULL,
    "base_volume" DECIMAL(36,7) NOT NULL,
    "counter_volume" DECIMAL(36,7) NOT NULL,
    "ledger" INTEGER NOT NULL DEFAULT 0,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "event_id" TEXT,
    "reference_median" DECIMAL(36,18) NOT NULL,
    "rejection_reason" TEXT NOT NULL,
    "rejection_bound" DECIMAL(36,18),
    "quarantined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quarantined_price_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quarantined_price_points_network_pair_key_timestamp_idx" ON "quarantined_price_points"("network", "pair_key", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "quarantined_price_points_network_pair_key_quarantined_at_idx" ON "quarantined_price_points"("network", "pair_key", "quarantined_at" DESC);
