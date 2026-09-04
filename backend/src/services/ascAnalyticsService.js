// Orchestration layer for Apple App Store Connect Analytics.
//
// Sits between the raw REST calls (appStoreConnectService) and the two
// consumers: (1) the cron worker that fetches new instances nightly, and
// (2) the Campaign Assistant tools + dashboard that read cached data.
//
// Contract:
//   - bootstrap(userId, connectionId) — one-time per (user, connection). Creates
//     the ONGOING report request at Apple, saves the request id to metadata.
//     Idempotent: if metadata already has a request id, returns it; if Apple
//     409s because a request already exists, we look it up and save the id.
//   - walk(userId, connectionId) — cron entrypoint. For each report category
//     we care about, list DAILY instances not yet in the cache, download each,
//     parse, upsert to asc_analytics_cache.
//   - getInstallFunnel({connectionId, days}) — aggregate impressions →
//     product-page views → app units over the last N days.
//   - getInstallsBySource({connectionId, days}) — installs grouped by Apple's
//     source-type dimension (App Store Search / Browse / Referrer / Campaign).
//
// Categories we cache today:
//   APP_STORE_ENGAGEMENT — impressions, PPVs, source breakdown, campaign attribution
//   APP_STORE_COMMERCE   — app units, redownloads, proceeds, territory
//
// Categories we skip for now (interesting later, not needed for MVP):
//   APP_USAGE            — sessions, active devices, retention (per-device
//                          data, huge row count)
//   FRAMEWORK_USAGE      — performance signals, low value for marketing

const { createClient } = require('@supabase/supabase-js');
const asc = require('./appStoreConnectService');
const cryptoBox = require('../utils/cryptoBox');
const connections = require('./connectionsService');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Categories fetched by walk(). Order matters only for logging.
const CATEGORIES = ['APP_STORE_ENGAGEMENT', 'APP_STORE_COMMERCE'];

// How many past daily instances to walk on each cron pass. Apple returns
// instances in descending processingDate order; we ask for the top N and
// upsert anything not already in the cache. Set high enough that recovering
// from a several-day outage backfills automatically.
const INSTANCES_PER_WALK = 14;

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

async function loadCredsFromConnection(userId, connectionId) {
  const row = await connections.getRawForUser(userId, connectionId);
  if (!row || row.provider !== 'app_store_connect') return null;
  const meta = row.metadata || {};
  if (!meta.p8_encrypted || !meta.issuer_id || !meta.key_id) return null;
  return {
    row,
    creds: {
      p8: cryptoBox.decrypt(meta.p8_encrypted),
      issuerId: meta.issuer_id,
      keyId: meta.key_id,
    },
    appId: meta.app_id || null,
    metadata: meta,
  };
}

async function patchConnectionMetadata(connectionId, patch) {
  // Merge into existing metadata JSONB. Read-modify-write is fine here — this
  // path is only ever called from the bootstrap flow (once per connection) or
  // the cron walker (once per hour per connection), so racing is a non-issue.
  const { data: current } = await supabase
    .from('connected_accounts')
    .select('metadata')
    .eq('id', connectionId)
    .single();
  const merged = { ...(current?.metadata || {}), ...patch };
  const { error } = await supabase
    .from('connected_accounts')
    .update({ metadata: merged })
    .eq('id', connectionId);
  if (error) throw error;
}

// -----------------------------------------------------------------------
// bootstrap — one-time per connection
// -----------------------------------------------------------------------
async function bootstrap(userId, connectionId) {
  const ctx = await loadCredsFromConnection(userId, connectionId);
  if (!ctx) throw new Error('ASC connection not found');
  if (!ctx.appId) throw new Error('Connection has no primary appId — reconnect and pick an app');

  const existing = ctx.metadata.analytics_report_request_id;
  if (existing) {
    return { requestId: existing, alreadyBootstrapped: true, appId: ctx.appId };
  }

  let requestId;
  try {
    const res = await asc.createOngoingReportRequest(ctx.creds, { appId: ctx.appId });
    requestId = res.id;
  } catch (err) {
    if (err.isConflict) {
      // Apple already has an ONGOING request for this app+team. Look it up.
      const existing = await asc.findOngoingReportRequestForApp(ctx.creds, { appId: ctx.appId });
      if (!existing) {
        throw new Error('Apple reported 409 Conflict but no existing request was found — check the ASC portal for orphaned requests');
      }
      requestId = existing.id;
    } else {
      throw err;
    }
  }

  await patchConnectionMetadata(connectionId, {
    analytics_report_request_id: requestId,
    analytics_bootstrap_at: new Date().toISOString(),
  });

  logger.info('asc_analytics.bootstrap.ok', {
    userId, connectionId, appId: ctx.appId, requestId, viaConflict: !!ctx.metadata.__viaConflict,
  });

  return { requestId, alreadyBootstrapped: false, appId: ctx.appId };
}

// -----------------------------------------------------------------------
// walk — cron entrypoint
// -----------------------------------------------------------------------
// For a single connection: list reports for its request → for each interesting
// category, list recent DAILY instances → download + parse + upsert any we
// don't have yet. Returns a summary of what was fetched.
async function walk(userId, connectionId) {
  const ctx = await loadCredsFromConnection(userId, connectionId);
  if (!ctx) throw new Error('ASC connection not found');
  const requestId = ctx.metadata.analytics_report_request_id;
  if (!requestId) throw new Error('Analytics not bootstrapped for this connection');
  if (!ctx.appId) throw new Error('Connection has no primary appId');

  const reports = await asc.listReportsInRequest(ctx.creds, requestId, { categories: CATEGORIES });
  const summary = { categories: {}, totalInstances: 0, totalRows: 0 };

  for (const report of reports) {
    if (!CATEGORIES.includes(report.category)) continue;

    // Which instance ids do we already have?
    const { data: existing } = await supabase
      .from('asc_analytics_cache')
      .select('instance_id')
      .eq('connection_id', connectionId)
      .eq('report_category', report.category)
      .eq('granularity', 'DAILY');
    const existingSet = new Set((existing || []).map(r => r.instance_id));

    // Latest N daily instances from Apple.
    const instances = await asc.listInstancesForReport(ctx.creds, report.id, {
      granularity: 'DAILY',
      limit: INSTANCES_PER_WALK,
    });
    const catSummary = { name: report.name, instancesFound: instances.length, newInstances: 0, rowsInserted: 0 };

    for (const inst of instances) {
      if (existingSet.has(inst.id)) continue;
      try {
        const segments = await asc.listSegmentsInInstance(ctx.creds, inst.id);
        // Concatenate all segment rows for this instance. Reports usually have
        // 1 segment but very large days can have multiple.
        const allRows = [];
        for (const seg of segments) {
          const rows = await asc.downloadSegment(seg);
          allRows.push(...rows);
        }
        const { error: upsertErr } = await supabase
          .from('asc_analytics_cache')
          .upsert({
            user_id: userId,
            connection_id: connectionId,
            app_id: ctx.appId,
            report_category: report.category,
            granularity: 'DAILY',
            processing_date: inst.processingDate,
            instance_id: inst.id,
            rows: allRows,
            row_count: allRows.length,
            segments_meta: segments,
            fetched_at: new Date().toISOString(),
          }, { onConflict: 'connection_id,instance_id' });
        if (upsertErr) throw upsertErr;
        catSummary.newInstances += 1;
        catSummary.rowsInserted += allRows.length;
        summary.totalRows += allRows.length;
      } catch (err) {
        logger.warn('asc_analytics.walk.instance_failed', {
          userId, connectionId, category: report.category,
          instanceId: inst.id, processingDate: inst.processingDate,
          error: err.message, status: err.status || null,
        });
      }
    }
    summary.categories[report.category] = catSummary;
    summary.totalInstances += catSummary.newInstances;
  }

  await patchConnectionMetadata(connectionId, {
    analytics_last_check_at: new Date().toISOString(),
    analytics_last_walk_summary: {
      at: new Date().toISOString(),
      newInstances: summary.totalInstances,
      newRows: summary.totalRows,
    },
  });

  logger.info('asc_analytics.walk.ok', {
    userId, connectionId,
    newInstances: summary.totalInstances,
    newRows: summary.totalRows,
  });
  return summary;
}

// -----------------------------------------------------------------------
// Aggregations — read from asc_analytics_cache, aggregate for a window
// -----------------------------------------------------------------------
// Apple's engagement schema (as of 2026) has these columns we care about:
//   Date, App Apple Identifier, Source Type, Source Info, Campaign, Territory,
//   Impressions, Impressions Unique Device, Product Page Views,
//   Product Page Views Unique Device, ...
// Commerce schema:
//   Date, App Name, App Apple Identifier, Sub Type, Territory, Currency,
//   App Units, Redownloads, Total Downloads, Proceeds, ...
//
// Column names sometimes vary by report version. The aggregation helpers below
// look them up defensively and fall back to zero if a column is missing (so a
// schema drift doesn't 500 the assistant — the model just sees a zero and
// notes the data is incomplete).

const toInt = v => {
  const n = parseInt(String(v || '0').replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

async function loadCategoryRows({ connectionId, category, days }) {
  const daysClamped = Math.max(1, Math.min(90, parseInt(days, 10) || 14));
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - daysClamped);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('asc_analytics_cache')
    .select('processing_date, rows, row_count')
    .eq('connection_id', connectionId)
    .eq('report_category', category)
    .eq('granularity', 'DAILY')
    .gte('processing_date', cutoffIso)
    .order('processing_date', { ascending: false });
  if (error) throw error;
  return { rows: data || [], days: daysClamped };
}

async function getInstallFunnel({ connectionId, days = 14 }) {
  const { rows, days: d } = await loadCategoryRows({
    connectionId, category: 'APP_STORE_ENGAGEMENT', days,
  });

  let impressions = 0, impressionsUniq = 0, ppv = 0, ppvUniq = 0;
  const perDay = [];
  for (const row of rows) {
    let dImp = 0, dImpU = 0, dPpv = 0, dPpvU = 0;
    for (const r of row.rows || []) {
      dImp += toInt(r['Impressions']);
      dImpU += toInt(r['Impressions Unique Device']);
      dPpv += toInt(r['Product Page Views']);
      dPpvU += toInt(r['Product Page Views Unique Device']);
    }
    impressions += dImp; impressionsUniq += dImpU; ppv += dPpv; ppvUniq += dPpvU;
    perDay.push({
      date: row.processing_date,
      impressions: dImp, impressionsUniqueDevice: dImpU,
      productPageViews: dPpv, productPageViewsUniqueDevice: dPpvU,
    });
  }

  // Commerce app units for the same window — needed to compute install
  // conversion rate. Load in parallel with engagement in a real optimization
  // pass; here we do it sequentially for readability.
  const commerce = await loadCategoryRows({
    connectionId, category: 'APP_STORE_COMMERCE', days,
  });
  let appUnits = 0, redownloads = 0;
  const perDayInstalls = new Map();
  for (const row of commerce.rows) {
    let dInstalls = 0, dRedl = 0;
    for (const r of row.rows || []) {
      dInstalls += toInt(r['App Units']);
      dRedl += toInt(r['Redownloads']);
    }
    appUnits += dInstalls; redownloads += dRedl;
    perDayInstalls.set(row.processing_date, dInstalls);
  }
  // Splice installs into perDay (indexed by date).
  for (const d of perDay) {
    d.installs = perDayInstalls.get(d.date) || 0;
  }

  const conversionRate = ppvUniq > 0 ? appUnits / ppvUniq : null;
  return {
    days: d,
    totals: {
      impressions,
      impressionsUniqueDevice: impressionsUniq,
      productPageViews: ppv,
      productPageViewsUniqueDevice: ppvUniq,
      installs: appUnits,
      redownloads,
      conversionRate,  // installs / unique PPV; null when no PPV
    },
    perDay,
    dataCoverageDays: perDay.length,
  };
}

async function getInstallsBySource({ connectionId, days = 14 }) {
  const { rows, days: d } = await loadCategoryRows({
    connectionId, category: 'APP_STORE_ENGAGEMENT', days,
  });
  // Aggregate by Source Type. Also expose the top campaigns under each source.
  const bySource = new Map(); // sourceType → { impressions, ppv, campaigns: Map<name, ppv> }
  for (const row of rows) {
    for (const r of row.rows || []) {
      const sourceType = String(r['Source Type'] || 'Unknown').trim() || 'Unknown';
      const campaign = String(r['Campaign'] || '').trim();
      const bucket = bySource.get(sourceType) || {
        impressions: 0,
        impressionsUniqueDevice: 0,
        productPageViews: 0,
        productPageViewsUniqueDevice: 0,
        campaigns: new Map(),
      };
      bucket.impressions += toInt(r['Impressions']);
      bucket.impressionsUniqueDevice += toInt(r['Impressions Unique Device']);
      bucket.productPageViews += toInt(r['Product Page Views']);
      bucket.productPageViewsUniqueDevice += toInt(r['Product Page Views Unique Device']);
      if (campaign) {
        bucket.campaigns.set(campaign, (bucket.campaigns.get(campaign) || 0) + toInt(r['Product Page Views']));
      }
      bySource.set(sourceType, bucket);
    }
  }
  const sources = [];
  for (const [sourceType, b] of bySource) {
    sources.push({
      sourceType,
      impressions: b.impressions,
      impressionsUniqueDevice: b.impressionsUniqueDevice,
      productPageViews: b.productPageViews,
      productPageViewsUniqueDevice: b.productPageViewsUniqueDevice,
      topCampaigns: Array.from(b.campaigns.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([campaign, ppv]) => ({ campaign, productPageViews: ppv })),
    });
  }
  // Sort sources by impressions desc so highest-signal is first.
  sources.sort((a, b) => b.impressions - a.impressions);
  return { days: d, sources };
}

async function getStatus({ userId, connectionId }) {
  const ctx = await loadCredsFromConnection(userId, connectionId);
  if (!ctx) return null;
  const { count } = await supabase
    .from('asc_analytics_cache')
    .select('*', { count: 'exact', head: true })
    .eq('connection_id', connectionId);
  return {
    bootstrapped: !!ctx.metadata.analytics_report_request_id,
    reportRequestId: ctx.metadata.analytics_report_request_id || null,
    bootstrapAt: ctx.metadata.analytics_bootstrap_at || null,
    lastCheckAt: ctx.metadata.analytics_last_check_at || null,
    lastWalkSummary: ctx.metadata.analytics_last_walk_summary || null,
    cachedInstances: count || 0,
  };
}

module.exports = {
  bootstrap,
  walk,
  getInstallFunnel,
  getInstallsBySource,
  getStatus,
  _internal: { loadCategoryRows, toInt, CATEGORIES },
};
