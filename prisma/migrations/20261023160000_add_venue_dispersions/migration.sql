-- #239: history of per-pair cross-venue price dispersion, written by the
-- periodic venue reconciliation job and served by GET /dispersion.

-- CreateTable
CREATE TABLE "venue_dispersions" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "pair_key" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "venue_count" INTEGER NOT NULL,
    "median" DECIMAL(36,18),
    "dispersion_pct" DECIMAL(10,4),
    "spread_bps" DECIMAL(10,2),
    "min_price" DECIMAL(36,18),
    "max_price" DECIMAL(36,18),
    "outlier_venue" TEXT,
    "outlier_deviation" DECIMAL(10,4),
    "status" TEXT NOT NULL DEFAULT 'ok',
    "is_ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "fresh_venues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stale_venues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "venues" JSONB,

    CONSTRAINT "venue_dispersions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "venue_dispersions_network_pair_key_timestamp_idx" ON "venue_dispersions"("network", "pair_key", "timestamp" DESC);

