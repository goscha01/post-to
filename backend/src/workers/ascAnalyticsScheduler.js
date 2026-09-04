// Apple App Store Connect Analytics cron.
//
// Polls every hour. For each connected_accounts row where
// provider='app_store_connect' AND metadata.analytics_report_request_id is
// set, calls ascAnalyticsService.walk to pull any new daily instances from
// Apple into asc_analytics_cache.
//
// Interval choice — hourly, not daily. Apple's daily instances become
// available at some point between 06:00 and 12:00 UTC (varies by report
// category), so a daily cron either fires before the data lands or waits
// nearly a full day to notice a straggler. Hourly walks are cheap (small
// number of ASC connections × ~2 categories × existing-set lookup) and
// data-fresh.
//
// Failure isolation: one connection's walk failing does NOT stop the tick
// from moving on to the next connection. Errors are logged with the
// connection id and moved on. Retries on the next tick.

const { createClient } = require('@supabase/supabase-js');
const { Client: PgClient } = require('pg');
const ascAnalytics = require('../services/ascAnalyticsService');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Boot-time auto-migration for asc_analytics_cache.
//
// The Supabase JS client has no way to run raw DDL, and pushing SQL from a dev
// machine hits DNS/IPv6 issues on newer Supabase projects (direct-connect was
// deprecated for free tier). The Railway container CAN reach the direct DB
// URL, so we run the idempotent migration from here at boot instead. Cheap
// (single connection, CREATE TABLE IF NOT EXISTS), safe (idempotent), and
// removes the "please paste this SQL in the dashboard" friction.
// Embedded inline (not read from ../../../supabase/asc-analytics-cache.sql)
// because Railway only builds the backend/ folder — the supabase/ dir at
// repo root isn't present in the deployed container. Keep this in sync with
// supabase/asc-analytics-cache.sql; the file version is what dev machines
// run via scripts/apply-asc-analytics-migration.js. All idempotent.
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS asc_analytics_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  app_id VARCHAR(64) NOT NULL,
  report_category VARCHAR(64) NOT NULL,
  granularity VARCHAR(16) NOT NULL,
  processing_date DATE NOT NULL,
  instance_id VARCHAR(128) NOT NULL,
  rows JSONB NOT NULL,
  row_count INTEGER,
  segments_meta JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_asc_cache_conn_instance
  ON asc_analytics_cache (connection_id, instance_id);

CREATE INDEX IF NOT EXISTS idx_asc_cache_app_cat_date
  ON asc_analytics_cache (app_id, report_category, granularity, processing_date DESC);

CREATE INDEX IF NOT EXISTS idx_asc_cache_conn_date
  ON asc_analytics_cache (connection_id, processing_date DESC);

ALTER TABLE asc_analytics_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations on asc_analytics_cache" ON asc_analytics_cache;
CREATE POLICY "Allow all operations on asc_analytics_cache"
  ON asc_analytics_cache FOR ALL USING (true);
`;

// Idempotent — always logs at least one of {already_present, applied,
// apply_failed, skipped}.
async function ensureTable() {
  logger.info('asc_analytics_scheduler.ensure_start', {});
  const { error: probeErr } = await supabase
    .from('asc_analytics_cache')
    .select('id')
    .limit(1);
  if (!probeErr) {
    logger.info('asc_analytics_scheduler.ensure_already_present', {});
    return { ok: true, ran: false };
  }
  const missing = /does not exist|undefined_table|PGRST20[24]|schema cache|not find the table/i.test(probeErr.message || '');
  if (!missing) {
    logger.warn('asc_analytics_scheduler.ensure_probe_failed', { error: probeErr.message });
    return { ok: false, ran: false, error: probeErr.message };
  }

  // Prefer SUPABASE_POOLER_URL over SUPABASE_DATABASE_URL. Railway's shared
  // cluster doesn't have IPv6 outbound, and Supabase's direct DB host
  // (db.<ref>.supabase.co) resolves IPv6-only on free tier since Feb 2024.
  // The Supavisor pooler (aws-0-<region>.pooler.supabase.com) is IPv4
  // reachable and the recommended production connection anyway.
  const dbUrl = process.env.SUPABASE_POOLER_URL || process.env.SUPABASE_DATABASE_URL;
  if (!dbUrl) {
    logger.warn('asc_analytics_scheduler.migration_skipped', {
      reason: 'Neither SUPABASE_POOLER_URL nor SUPABASE_DATABASE_URL set — cannot self-apply migration',
    });
    return { ok: false, ran: false };
  }
  const usingPooler = !!process.env.SUPABASE_POOLER_URL;

  const client = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query(MIGRATION_SQL);
    logger.info('asc_analytics_scheduler.migration_applied', {
      host: safeHost(dbUrl),
      via: usingPooler ? 'pooler' : 'direct',
    });
    return { ok: true, ran: true };
  } catch (err) {
    logger.warn('asc_analytics_scheduler.migration_apply_failed', {
      error: err.message,
      host: safeHost(dbUrl),
      via: usingPooler ? 'pooler' : 'direct',
      hint: usingPooler ? null : 'Direct DB URL fails from Railway (IPv6-only). Set SUPABASE_POOLER_URL (Supabase Dashboard → Settings → Database → Connection pooling → Transaction mode) to use the IPv4-reachable Supavisor pooler instead.',
    });
    return { ok: false, ran: false, error: err.message };
  } finally {
    await client.end().catch(() => {});
  }
}

function safeHost(url) {
  try { return new URL(url).hostname; }
  catch { return null; }
}

const POLL_INTERVAL_MS = Number(process.env.ASC_ANALYTICS_SCHEDULER_INTERVAL_MS) || 60 * 60 * 1000;
// Skip connections we've already walked in the last N minutes. Even if
// something else triggered a manual walk (or the process just restarted and
// the interval fires early), we don't want to hammer Apple.
const MIN_WALK_INTERVAL_MS = Number(process.env.ASC_ANALYTICS_MIN_WALK_INTERVAL_MS) || 30 * 60 * 1000;

async function findBootstrappedConnections() {
  // We can't SQL-query into JSONB with the Supabase JS client cleanly, so
  // grab every ASC row and filter in-memory. ASC connection count per user
  // is small (usually 1-2) so this is fine even at scale.
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id, user_id, metadata')
    .eq('provider', 'app_store_connect')
    .eq('status', 'active');
  if (error) throw error;
  return (data || []).filter(r => r.metadata?.analytics_report_request_id);
}

async function tick() {
  let rows;
  try {
    rows = await findBootstrappedConnections();
  } catch (err) {
    logger.warn('asc_analytics_scheduler.query_error', { error: err.message });
    return;
  }
  if (!rows.length) return;

  const now = Date.now();
  let walked = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    const lastCheck = row.metadata?.analytics_last_check_at
      ? new Date(row.metadata.analytics_last_check_at).getTime()
      : 0;
    if (now - lastCheck < MIN_WALK_INTERVAL_MS) {
      skipped += 1;
      continue;
    }
    try {
      await ascAnalytics.walk(row.user_id, row.id);
      walked += 1;
    } catch (err) {
      failed += 1;
      logger.warn('asc_analytics_scheduler.walk_failed', {
        userId: row.user_id, connectionId: row.id,
        error: err.message, status: err.status || null,
      });
    }
  }
  logger.info('asc_analytics_scheduler.tick', {
    total: rows.length, walked, skipped, failed,
  });
}

let started = false;
function start() {
  if (started) return;
  started = true;
  // Delay the first tick so it doesn't race with app boot. Matches the
  // automationScheduler pattern. Runs ensureTable() first so the migration
  // self-applies before the first walk attempts to UPSERT.
  setTimeout(async () => {
    await ensureTable().catch(e => logger.warn('asc_analytics_scheduler.ensure_error', { error: e.message }));
    tick().catch(e => logger.warn('asc_analytics_scheduler.tick_error', { error: e.message }));
    setInterval(() => {
      tick().catch(e => logger.warn('asc_analytics_scheduler.tick_error', { error: e.message }));
    }, POLL_INTERVAL_MS);
  }, 30_000);
  logger.info('asc_analytics_scheduler.started', {
    interval_ms: POLL_INTERVAL_MS,
    min_walk_interval_ms: MIN_WALK_INTERVAL_MS,
  });
}

module.exports = { start, tick, ensureTable };
