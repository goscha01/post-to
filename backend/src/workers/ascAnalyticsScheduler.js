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

const path = require('path');
const fs = require('fs');
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
const MIGRATION_SQL_PATH = path.join(__dirname, '..', '..', '..', 'supabase', 'asc-analytics-cache.sql');
async function ensureTable() {
  // Fast-path: try a bounded SELECT via the JS client — if the table exists,
  // no work to do. Silent 42P01 (undefined_table) means run the migration.
  const { error: probeErr } = await supabase
    .from('asc_analytics_cache')
    .select('id', { count: 'exact', head: true })
    .limit(0);
  if (!probeErr) return { ok: true, ran: false };
  // Any error other than "relation does not exist" — surface and give up.
  const missing = /does not exist|undefined_table|PGRST20[24]|schema cache/i.test(probeErr.message || '');
  if (!missing) {
    logger.warn('asc_analytics_scheduler.ensure_probe_failed', { error: probeErr.message });
    return { ok: false, ran: false, error: probeErr.message };
  }

  const dbUrl = process.env.SUPABASE_DATABASE_URL;
  if (!dbUrl) {
    logger.warn('asc_analytics_scheduler.migration_skipped', {
      reason: 'SUPABASE_DATABASE_URL not set — cannot self-apply migration',
    });
    return { ok: false, ran: false };
  }
  let sql;
  try { sql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8'); }
  catch (err) {
    logger.warn('asc_analytics_scheduler.migration_read_failed', { error: err.message });
    return { ok: false, ran: false };
  }

  const client = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query(sql);
    logger.info('asc_analytics_scheduler.migration_applied', { path: MIGRATION_SQL_PATH });
    return { ok: true, ran: true };
  } catch (err) {
    logger.warn('asc_analytics_scheduler.migration_apply_failed', { error: err.message });
    return { ok: false, ran: false, error: err.message };
  } finally {
    await client.end().catch(() => {});
  }
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
