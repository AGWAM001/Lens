-- #241: persistent record of detected ingestion gaps, so history/candle/VWAP
-- responses can declare windows that overlap missing data as incomplete.

-- CreateTable
CREATE TABLE "ingestion_gaps" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "source" TEXT NOT NULL,
    "pair_key" TEXT NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingestion_gaps_network_pair_key_source_status_idx" ON "ingestion_gaps"("network", "pair_key", "source", "status");

-- CreateIndex
CREATE INDEX "ingestion_gaps_network_pair_key_start_time_end_time_idx" ON "ingestion_gaps"("network", "pair_key", "start_time", "end_time");

