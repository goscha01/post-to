-- Apple App Store Connect Analytics cache.
--
-- Apple's App Analytics Reports API is a THREE-step async flow:
--   1. POST /v1/analyticsReportRequests   → returns request id (persists forever
--      once created, keeps generating reports going forward for ONGOING type)
--   2. GET /v1/analyticsReportRequests/{id}/reports  → list of report ids per
--      category (APP_STORE_ENGAGEMENT, APP_STORE_COMMERCE, APP_USAGE, ...)
--   3. GET /v1/analyticsReports/{reportId}/instances → daily instances
--   4. GET /v1/analyticsReportInstances/{instanceId}/segments → S3-signed URLs
--      to download gzipped CSVs
--
-- All of that lag (creation → first instance available: 24-48h; then daily) is
-- Apple's. We cache the parsed CSV rows here so the Campaign Assistant tools
-- and dashboards read from Postgres (fast, aggregatable) instead of hitting
-- Apple every request.
--
-- The report-request id itself lives in connected_accounts.metadata under
-- analytics_report_request_id — no new column needed, JSONB is fine.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS asc_analytics_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  connection_id UUID NOT NULL,             -- connected_accounts.id where provider='app_store_connect'
  app_id VARCHAR(64) NOT NULL,             -- Apple app id (numeric string)
  report_category VARCHAR(64) NOT NULL,    -- APP_STORE_ENGAGEMENT | APP_STORE_COMMERCE | APP_USAGE | FRAMEWORK_USAGE
  granularity VARCHAR(16) NOT NULL,        -- DAILY | WEEKLY | MONTHLY
  processing_date DATE NOT NULL,           -- date Apple processed the report (approximately the data window's end)
  instance_id VARCHAR(128) NOT NULL,       -- Apple's instance id — uniqueness key across the pipeline
  rows JSONB NOT NULL,                     -- parsed CSV rows as an array of objects
  row_count INTEGER,                       -- length of `rows` for quick counts + JSONB path avoidance
  segments_meta JSONB,                     -- optional: url/sizeInBytes/checksum from the segments API for auditing
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uniqueness: one row per (connection, instance). Enforces idempotent upserts
-- when the cron re-walks the same instance twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_asc_cache_conn_instance
  ON asc_analytics_cache (connection_id, instance_id);

-- Primary lookup pattern: "give me last N days of engagement/commerce for app X".
CREATE INDEX IF NOT EXISTS idx_asc_cache_app_cat_date
  ON asc_analytics_cache (app_id, report_category, granularity, processing_date DESC);

-- Secondary lookup for cron: "which instances have I already fetched for this connection?"
CREATE INDEX IF NOT EXISTS idx_asc_cache_conn_date
  ON asc_analytics_cache (connection_id, processing_date DESC);

-- RLS: permissive (server uses service role; mirrors campaign_assistant_* pattern).
ALTER TABLE asc_analytics_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations on asc_analytics_cache" ON asc_analytics_cache;
CREATE POLICY "Allow all operations on asc_analytics_cache"
  ON asc_analytics_cache FOR ALL USING (true);
