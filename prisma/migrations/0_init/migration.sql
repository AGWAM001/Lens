-- CreateTable
CREATE TABLE "price_points" (
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
    "ledger" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "event_id" TEXT,

    CONSTRAINT "price_points_pkey" PRIMARY KEY ("id","timestamp")
);

-- CreateTable
CREATE TABLE "lending_rates" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "asset" TEXT NOT NULL,
    "asset_issuer" TEXT,
    "venue" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "pool_name" TEXT,
    "supply_rate" DECIMAL(18,8) NOT NULL,
    "borrow_rate" DECIMAL(18,8) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lending_rates_pkey" PRIMARY KEY ("id","timestamp")
);

-- CreateTable
CREATE TABLE "pool_snapshots" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "pool_id" TEXT NOT NULL,
    "asset_a" TEXT NOT NULL,
    "asset_b" TEXT NOT NULL,
    "reserve_a" DECIMAL(36,7) NOT NULL,
    "reserve_b" DECIMAL(36,7) NOT NULL,
    "spot_price" DECIMAL(36,18) NOT NULL,
    "total_shares" DECIMAL(36,7),
    "fee_bp" INTEGER NOT NULL DEFAULT 30,
    "ledger" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_snapshots_pkey" PRIMARY KEY ("id","timestamp")
);

-- CreateTable
CREATE TABLE "price_aggregates" (
    "pair_key" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "window" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "vwap" DECIMAL(36,18) NOT NULL,
    "sdex_vwap" DECIMAL(36,18),
    "amm_vwap" DECIMAL(36,18),
    "volume" DECIMAL(36,7) NOT NULL DEFAULT 0,
    "sdex_volume" DECIMAL(36,7) DEFAULT 0,
    "amm_volume" DECIMAL(36,7) DEFAULT 0,
    "trade_count" INTEGER DEFAULT 0,
    "open_price" DECIMAL(36,18),
    "close_price" DECIMAL(36,18),
    "high_price" DECIMAL(36,18),
    "low_price" DECIMAL(36,18),

    CONSTRAINT "price_aggregates_pkey" PRIMARY KEY ("network","pair_key","window","bucket")
);

-- CreateTable
CREATE TABLE "price_snapshots" (
    "pair" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "ts" TIMESTAMP(3) NOT NULL,
    "price" DECIMAL(36,18) NOT NULL,
    "volume" DECIMAL(36,7) NOT NULL DEFAULT 0,

    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("network","pair","ts")
);

-- CreateTable
CREATE TABLE "indexer_state" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "last_cursor" TEXT,
    "last_ledger" INTEGER,
    "last_processed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexer_state_pkey" PRIMARY KEY ("network","id")
);

-- CreateTable
CREATE TABLE "pair_configs" (
    "pair_key" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "asset_a_code" TEXT NOT NULL,
    "asset_a_issuer" TEXT,
    "asset_b_code" TEXT NOT NULL,
    "asset_b_issuer" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pair_configs_pkey" PRIMARY KEY ("network","pair_key")
);

-- CreateTable
CREATE TABLE "bazaar_resources" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "mime_type" TEXT,
    "service_name" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "icon_url" TEXT,
    "mcp_tool_name" TEXT,
    "http_method" TEXT,
    "accepts" JSONB NOT NULL,
    "pay_to" TEXT NOT NULL,
    "bazaar_info" JSONB NOT NULL,
    "bazaar_schema" JSONB NOT NULL,
    "route_template" TEXT,
    "extension_keys" TEXT[] DEFAULT ARRAY['bazaar']::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bazaar_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_attempts" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "tx_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "payer" TEXT,
    "pay_to" TEXT,
    "asset" TEXT,
    "amount" TEXT,
    "error_reason" TEXT,
    "error_message" TEXT,
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "url" TEXT NOT NULL,
    "asset_a" TEXT NOT NULL,
    "asset_b" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "direction" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery_failures" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempt_count" INTEGER NOT NULL,
    "last_status" INTEGER,
    "error_category" TEXT NOT NULL,
    "first_attempt_at" TIMESTAMP(3) NOT NULL,
    "last_attempt_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rate_per_min" INTEGER NOT NULL DEFAULT 60,
    "rate_per_day" INTEGER NOT NULL DEFAULT 10000,
    "revoked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monthly_quota_cents" INTEGER DEFAULT 10000,
    "daily_quota_cents" INTEGER DEFAULT 500,
    "overage_policy" TEXT NOT NULL DEFAULT 'block',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oracle_publications" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "pair_key" TEXT NOT NULL,
    "quoted_asset" TEXT NOT NULL,
    "base_asset" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "trigger" TEXT,
    "price" DECIMAL(36,18),
    "scaled_price" TEXT,
    "decimals" INTEGER,
    "feed_timestamp" BIGINT,
    "resolution" INTEGER,
    "venues" TEXT,
    "source_count" INTEGER,
    "deviation_pct" DOUBLE PRECISION,
    "reason" TEXT,
    "tx_hash" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oracle_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_points_network_pair_key_timestamp_idx" ON "price_points"("network", "pair_key", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "price_points_network_pair_key_source_timestamp_idx" ON "price_points"("network", "pair_key", "source", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "price_point_identity" ON "price_points"("network", "source", "event_id");

-- CreateIndex
CREATE INDEX "lending_rates_network_asset_timestamp_idx" ON "lending_rates"("network", "asset", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "lending_rates_network_asset_venue_timestamp_idx" ON "lending_rates"("network", "asset", "venue", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "pool_snapshots_network_pool_id_timestamp_idx" ON "pool_snapshots"("network", "pool_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "price_snapshots_network_pair_ts_idx" ON "price_snapshots"("network", "pair", "ts");

-- CreateIndex
CREATE INDEX "bazaar_resources_network_type_pay_to_created_at_id_idx" ON "bazaar_resources"("network", "type", "pay_to", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "bazaar_resources_extension_keys_idx" ON "bazaar_resources" USING GIN ("extension_keys");

-- CreateIndex
CREATE UNIQUE INDEX "bazaar_http_identity" ON "bazaar_resources"("network", "url", "http_method");

-- CreateIndex
CREATE UNIQUE INDEX "bazaar_mcp_identity" ON "bazaar_resources"("network", "url", "mcp_tool_name");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_attempt_identity" ON "settlement_attempts"("network", "tx_hash");

-- CreateIndex
CREATE INDEX "webhooks_network_asset_a_asset_b_idx" ON "webhooks"("network", "asset_a", "asset_b");

-- CreateIndex
CREATE INDEX "webhook_delivery_failures_created_at_idx" ON "webhook_delivery_failures"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");

-- CreateIndex
CREATE INDEX "oracle_publications_network_pair_key_created_at_idx" ON "oracle_publications"("network", "pair_key", "created_at" DESC);

-- CreateIndex
CREATE INDEX "oracle_publications_network_quoted_asset_feed_timestamp_idx" ON "oracle_publications"("network", "quoted_asset", "feed_timestamp" DESC);

