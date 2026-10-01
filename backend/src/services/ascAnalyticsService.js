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
//   COMMERCE   — app units, redownloads, proceeds, territory
//
// Categories we skip for now (interesting later, not needed for MVP):
//   APP_USAGE            — sessions, active devices, retention (per-device
//                          data, huge row count)
//   FRAMEWORK_USAGE      — performance signals, low value for marketing

const { createClient } = require('@supabase/supabase-js');
const asc = require('./appStoreConnectService');
const cryptoBox = require('../utils/cryptoBox');
const connections = require('./connectionsService');
const metaAds = require('./metaAdsService');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Categories fetched by walk(). Apple's valid categories are:
//   APP_USAGE, APP_STORE_ENGAGEMENT, COMMERCE, FRAMEWORK_USAGE, PERFORMANCE
// (Apple renamed APP_STORE_COMMERCE → COMMERCE in a recent API rev — our
// initial impl used the old name and got PARAMETER_ERROR.INVALID at walk
// time. If a category rename ever happens again, update this list and the
// getInstallFunnel filter together.)
const CATEGORIES = ['APP_STORE_ENGAGEMENT', 'COMMERCE'];

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
  let requestId = ctx.metadata.analytics_report_request_id;
  if (!requestId) throw new Error('Analytics not bootstrapped for this connection');
  if (!ctx.appId) throw new Error('Connection has no primary appId');

  // Self-heal: three failure modes have all caused a silent "walks return
  // zero forever, dashboard drifts stale" pattern:
  //   (a) stoppedDueToInactivity — Apple auto-pauses ONGOING requests
  //       that go long stretches without being polled.
  //   (b) The stored requestId points at a request Apple no longer has
  //       (deleted / GC'd / migrated) — listReportsInRequest silently
  //       returns [].
  //   (c) Apple has no ONGOING request at all for this app (nuked
  //       server-side), so findOngoingReportRequestForApp returns null.
  //
  // Check for (a) and (c) up front; check for (b) after listReportsInRequest.
  let rebootstrapReason = null;
  const requestState = await asc.findOngoingReportRequestForApp(ctx.creds, { appId: ctx.appId })
    .catch(err => {
      logger.warn('asc_analytics.walk.request_state_check_failed', {
        userId, connectionId, error: err.message,
      });
      return null;
    });
  if (!requestState) {
    rebootstrapReason = 'no_ongoing_request_at_apple';
  } else if (requestState.stoppedDueToInactivity) {
    rebootstrapReason = 'stoppedDueToInactivity';
  } else if (requestState.id !== requestId) {
    rebootstrapReason = 'request_id_mismatch';
  }

  if (rebootstrapReason) {
    logger.warn('asc_analytics.walk.rebootstrap_triggered', {
      userId, connectionId, oldRequestId: requestId,
      apiRequestId: requestState?.id || null,
      stoppedDueToInactivity: requestState?.stoppedDueToInactivity || false,
      reason: rebootstrapReason,
    });
    try {
      const created = await asc.createOngoingReportRequest(ctx.creds, { appId: ctx.appId });
      requestId = created.id;
    } catch (err) {
      if (err.isConflict) {
        // Race / already-exists: look it up and use whatever Apple has.
        const existing = await asc.findOngoingReportRequestForApp(ctx.creds, { appId: ctx.appId });
        if (existing && !existing.stoppedDueToInactivity) requestId = existing.id;
        else throw err;
      } else {
        throw err;
      }
    }
    await patchConnectionMetadata(connectionId, {
      analytics_report_request_id: requestId,
      analytics_bootstrap_at: new Date().toISOString(),
      analytics_rebootstrap_reason: rebootstrapReason,
      analytics_rebootstrap_at: new Date().toISOString(),
    });
  }

  const reports = await asc.listReportsInRequest(ctx.creds, requestId, { categories: CATEGORIES });

  // Failure mode (b): stored requestId is dead server-side. Apple 200s the
  // /reports endpoint but returns an empty data array (validateStatus:
  // () => true swallowed the 404 or similar). Re-bootstrap and try again
  // with a fresh request id.
  let reportsToWalk = reports;
  if (reports.length === 0 && !rebootstrapReason) {
    logger.warn('asc_analytics.walk.rebootstrap_triggered', {
      userId, connectionId, oldRequestId: requestId,
      reason: 'empty_reports_list',
    });
    try {
      const created = await asc.createOngoingReportRequest(ctx.creds, { appId: ctx.appId });
      requestId = created.id;
      await patchConnectionMetadata(connectionId, {
        analytics_report_request_id: requestId,
        analytics_bootstrap_at: new Date().toISOString(),
        analytics_rebootstrap_reason: 'empty_reports_list',
        analytics_rebootstrap_at: new Date().toISOString(),
      });
      reportsToWalk = await asc.listReportsInRequest(ctx.creds, requestId, { categories: CATEGORIES });
    } catch (err) {
      // 409 means a fresh request already exists; just retry the list.
      if (err.isConflict) {
        const existing = await asc.findOngoingReportRequestForApp(ctx.creds, { appId: ctx.appId });
        if (existing) {
          requestId = existing.id;
          reportsToWalk = await asc.listReportsInRequest(ctx.creds, requestId, { categories: CATEGORIES });
        }
      }
      // If still nothing, fall through — reportsToWalk stays [], walk
      // returns 0-new, and we surface the state to the client.
    }
  }
  const summary = { categories: {}, totalInstances: 0, totalRows: 0, requestId, reportsCount: reportsToWalk.length };

  for (const report of reportsToWalk) {
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
      // Diagnostic fields — makes it possible to see WHY a walk returned
      // zero (Apple has no request / Apple request has no reports / Apple
      // has reports but they're empty) by querying the metadata later.
      requestId,
      apiRequestState: requestState
        ? { id: requestState.id, stoppedDueToInactivity: requestState.stoppedDueToInactivity }
        : null,
      reportsCount: reportsToWalk.length,
      rebootstrapReason: rebootstrapReason || null,
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
// Apple's current analytics schema (verified 2026-09-28 against ProofPix
// cache) is LONG format, not wide: each row is (Date × Event × dimensions ×
// Counts). Column names by category:
//
//   APP_STORE_ENGAGEMENT: Date, Event, Counts, Device, Browser, App Name,
//                         Page Type, Territory, Source Type,
//                         Browser Version, Engagement Type,
//                         Platform Version, App Apple Identifier
//     Event values seen:  Impression, Page view, Tap
//     Page Type values:   Store sheet, No page, Product page, App privacy
//     Source Type values: App Store search, App Store browse, App referrer,
//                         Web referrer, Unavailable
//
//   COMMERCE:             Date, Counts, Device, App Name, Campaign,
//                         Page Type, Pre-Order, Territory, Page Title,
//                         App Version, Source Info, Source Type,
//                         Download Type, Platform Version, App Apple Identifier
//     Download Type:      First-time download, Redownload, Auto-update, Restore
//                         (Auto-update = the app updating itself; NOT an install.
//                          First-time download = a genuine new install.)
//
// The initial implementation of these aggregators assumed a wide schema with
// per-metric columns (Impressions, Product Page Views, App Units) — that
// schema doesn't exist in the current Apple API, so every metric summed to
// zero even though 100+ instances were cached. This defensive-fallback
// approach reads whichever schema the row was stored under: if row.Event or
// row['Download Type'] is present, use long-format filtering; otherwise fall
// back to the legacy wide-column lookup.

const toInt = v => {
  const n = parseInt(String(v || '0').replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

// Which engagement events count as which funnel step. Kept in one place so
// schema changes are a one-line update.
const IMPRESSION_EVENTS = new Set(['Impression']);
const PAGE_VIEW_EVENTS = new Set(['Page view']);
// Both "Product page" and "Store sheet" count as a product-page view. Apple
// uses "Store sheet" for the modal presentation of the product page that
// appears from search / browse / featured tiles — it's the same product-page
// content, just presented as a sheet. Excluding it undercounts PPV by 10-20×
// on typical apps (verified against ProofPix: Sep 15 had 63 "Product page"
// vs 774 "Store sheet" — the sheet is where nearly all product-page traffic
// actually lands). "No page" (impression-only interactions) and "App
// privacy" (privacy detail page) are excluded — they aren't the funnel step
// we're measuring.
const PAGE_VIEW_PAGE_TYPES = new Set(['Product page', 'Store sheet']);

// COMMERCE Download Type values that count as a NEW install (not an update).
// Restore = re-download on a new device with the same Apple ID; grouped with
// installs since it represents a device gaining the app.
const INSTALL_DOWNLOAD_TYPES = new Set(['First-time download', 'Restore']);
const REDOWNLOAD_TYPES = new Set(['Redownload']);

async function loadCategoryRows({ connectionId, category, days }) {
  // Analytics cache queries are just Supabase reads — cheap regardless of
  // window size. Cap at 365 to bound response size; anything larger belongs
  // in an export flow, not the dashboard.
  const daysClamped = Math.max(1, Math.min(365, parseInt(days, 10) || 14));
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - daysClamped);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  // CRITICAL: Apple's ONGOING request contains multiple REPORTS per
  // category (verified Oct 1 — reportsCount: 15 for ProofPix). Each report
  // publishes its own instance per processing_date with different
  // dimensional cuts of the same underlying events, and `walk` upserts
  // each separately (unique by instance_id). Summing rows across all of
  // them double- or triple-counts the metrics. We dedupe here by picking
  // the ONE instance per processing_date with the most rows — that's the
  // "comprehensive" cut, and others are subsets of it. Correct long-term
  // fix is to store report_id/report_name and let the caller filter;
  // this is the no-schema-change workaround.
  const { data, error } = await supabase
    .from('asc_analytics_cache')
    .select('processing_date, rows, row_count, instance_id')
    .eq('connection_id', connectionId)
    .eq('report_category', category)
    .eq('granularity', 'DAILY')
    .gte('processing_date', cutoffIso)
    .order('processing_date', { ascending: false });
  if (error) throw error;

  // Dedupe: keep the single instance per processing_date with the highest
  // row_count. Multiple instances for the same date = different Apple
  // reports with overlapping event data; summing them triple-counts.
  const bestByDate = new Map();
  for (const row of (data || [])) {
    const existing = bestByDate.get(row.processing_date);
    if (!existing || (row.row_count || 0) > (existing.row_count || 0)) {
      bestByDate.set(row.processing_date, row);
    }
  }
  const deduped = [...bestByDate.values()].sort((a, b) =>
    b.processing_date.localeCompare(a.processing_date)
  );
  return { rows: deduped, days: daysClamped };
}

// Accumulate a single row into the running totals + per-day buckets. Handles
// current long-format schema (Event/Counts) with a fallback to the legacy
// wide-column names so historic cache rows still contribute.
//
// `perDay` is a Map<dateISO, { impressions, ppv, installs, redownloads }> —
// keyed by the ROW's Date field, not the cache instance's processing_date,
// because Apple's per-instance CSVs contain rows spanning many event dates
// (a report generated on 09-25 typically holds rows dated 09-22 and earlier).
function bucketByRowDate(perDay, dateKey) {
  let b = perDay.get(dateKey);
  if (!b) {
    b = {
      impressions: 0,
      productPageViews: 0,
      // Two separate install sources kept independently so the conversion
      // rate can use the Analytics-attributed number (page-view → install)
      // while the display summary can use the Sales & Trends number
      // (all-source, authoritative). Mixing them into one field is what
      // made conversion rates come out >100%.
      analyticsInstalls: 0,
      salesInstalls: null,        // null = S&T did not cover this day
      redownloads: 0,
      // Presence flags. True iff Apple has published ANY row of that
      // category for the day — lets the client render "—" (not "0") for
      // days where Apple's async pipeline hasn't caught up yet, so real
      // zeros aren't confused with pending data.
      engagementDataAvailable: false,
      commerceDataAvailable: false,
    };
    perDay.set(dateKey, b);
  }
  return b;
}

function accumulateEngagement(perDay, instanceRows) {
  for (const r of instanceRows || []) {
    const dateKey = String(r?.Date || '').slice(0, 10);
    if (!dateKey) continue;
    const b = bucketByRowDate(perDay, dateKey);
    b.engagementDataAvailable = true;
    if (r.Event !== undefined) {
      const c = toInt(r.Counts);
      if (IMPRESSION_EVENTS.has(r.Event)) b.impressions += c;
      else if (PAGE_VIEW_EVENTS.has(r.Event) && PAGE_VIEW_PAGE_TYPES.has(r['Page Type'])) b.productPageViews += c;
    } else {
      b.impressions += toInt(r['Impressions']);
      b.productPageViews += toInt(r['Product Page Views']);
    }
  }
}

function accumulateCommerce(perDay, instanceRows) {
  for (const r of instanceRows || []) {
    const dateKey = String(r?.Date || '').slice(0, 10);
    if (!dateKey) continue;
    const b = bucketByRowDate(perDay, dateKey);
    b.commerceDataAvailable = true;
    if (r['Download Type'] !== undefined) {
      const c = toInt(r.Counts);
      if (INSTALL_DOWNLOAD_TYPES.has(r['Download Type'])) b.analyticsInstalls += c;
      else if (REDOWNLOAD_TYPES.has(r['Download Type'])) b.redownloads += c;
    } else {
      b.analyticsInstalls += toInt(r['App Units']);
      b.redownloads += toInt(r['Redownloads']);
    }
  }
}

// Product types in the Sales & Trends TSV that represent a NEW app install.
// See https://developer.apple.com/help/app-store-connect/reference/product-type-identifiers/
//   1  = iPhone / iPod touch app (new install)
//   1F = Universal app (new install)
//   1T = iPad app (new install)
// Updates (7, 7F, 7T) and IAP (IA*, 3) are excluded.
const SALES_INSTALL_PRODUCT_TYPES = new Set(['1', '1F', '1T']);
const SALES_REDOWNLOAD_PRODUCT_TYPES = new Set(['1R', '1FR', '1TR']);

async function getInstallFunnel({ connectionId, days = 14, userId }) {
  const { rows, days: d } = await loadCategoryRows({
    connectionId, category: 'APP_STORE_ENGAGEMENT', days,
  });
  const commerce = await loadCategoryRows({
    connectionId, category: 'COMMERCE', days,
  });

  // Bucket by the row's own Date field. We restrict AFTER accumulation to the
  // requested window because rows can span dates outside the processing_date
  // cutoff.
  const perDayMap = new Map();
  for (const row of rows) accumulateEngagement(perDayMap, row.rows);
  for (const row of commerce.rows) accumulateCommerce(perDayMap, row.rows);

  // Overlay Sales & Trends installs on top of Analytics-COMMERCE installs.
  // Rationale: Apple's Analytics async report pipeline lags Sales & Trends
  // by 2-3 days for install data. On the 7-day view the Analytics COMMERCE
  // report typically shows 0 First-time downloads for the most recent days
  // even though Sales & Trends already has real install counts (same window,
  // authoritative source — this is what the Overview tab displays). Fetching
  // both keeps this tab consistent with Overview.
  //
  // Sales & Trends requires a vendor_number; when it's missing we fall back
  // to the Analytics-only numbers so the funnel still renders.
  let salesInstallsSource = 'analytics_commerce_only';
  const ctx = userId ? await loadCredsFromConnection(userId, connectionId) : null;
  if (ctx?.metadata?.vendor_number) {
    try {
      const reports = await asc.getSalesReportRange(ctx.creds, {
        vendorNumber: ctx.metadata.vendor_number,
        days: d,
      });
      // Reset installs/redownloads on every day-bucket in the window: Sales
      // & Trends is the authoritative source, and mixing the two per-day
      // would double-count on days where both have data. We use the S&T
      // number outright, and keep the Analytics-COMMERCE number only as a
      // fallback for days S&T doesn't cover.
      const salesByDate = new Map();
      for (const rep of reports || []) {
        let dayInstalls = 0, dayRedl = 0;
        for (const r of rep.rows || []) {
          if (SALES_INSTALL_PRODUCT_TYPES.has(r.productType)) dayInstalls += r.units || 0;
          else if (SALES_REDOWNLOAD_PRODUCT_TYPES.has(r.productType)) dayRedl += r.units || 0;
        }
        salesByDate.set(rep.reportDate, { installs: dayInstalls, redownloads: dayRedl });
      }
      for (const [date, sales] of salesByDate) {
        const b = bucketByRowDate(perDayMap, date);
        b.salesInstalls = sales.installs;
        b.redownloads = sales.redownloads;
      }
      salesInstallsSource = salesByDate.size > 0 ? 'sales_and_trends' : 'analytics_commerce_only';
      logger.info('asc_analytics.funnel.sales_overlay', {
        connectionId, days: d, salesDaysCovered: salesByDate.size,
      });
    } catch (err) {
      // Sales & Trends fetch is best-effort. If Apple 401s or times out here,
      // fall back to the Analytics-COMMERCE numbers rather than failing the
      // whole funnel request.
      logger.warn('asc_analytics.funnel.sales_overlay_failed', {
        connectionId, error: err.message, status: err.status || null,
      });
    }
  }

  // Build the full list of dates in the window (yesterday back N days),
  // then look up each in perDayMap. Missing dates get an all-null bucket
  // so the client always renders a complete N-row table — otherwise days
  // Apple hasn't published at all just vanish, and the user sees a
  // 5-row table for a 7-day window and thinks it's broken.
  const windowDates = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 1; i <= d; i++) {
    const dt = new Date(today);
    dt.setUTCDate(dt.getUTCDate() - i);
    windowDates.push(dt.toISOString().slice(0, 10));
  }
  const cutoffIso = windowDates[windowDates.length - 1];

  // Also include any perDayMap entries whose dates fall inside the window
  // but weren't in the windowDates loop (they will be, actually — dedupe by
  // Set to be safe against timezone edge cases in the map keys).
  const allWindowDates = [...new Set([
    ...windowDates,
    ...[...perDayMap.keys()].filter(k => k >= cutoffIso),
  ])].sort().reverse();

  const perDay = allWindowDates.map(date => {
      const b = perDayMap.get(date) || {
        impressions: 0, productPageViews: 0,
        analyticsInstalls: 0, salesInstalls: null, redownloads: 0,
        engagementDataAvailable: false, commerceDataAvailable: false,
      };
      return [date, b];
    }).map(([date, b]) => {
      // Display install value: prefer S&T when it covered this day (fresher,
      // authoritative). Otherwise use Analytics-COMMERCE. Null when neither
      // source has data yet — client renders as "—".
      const stCovered = b.salesInstalls !== null;
      const displayInstalls = stCovered
        ? b.salesInstalls
        : (b.commerceDataAvailable ? b.analyticsInstalls : null);

      // When engagement data is available but ONLY the thin "summary" report
      // has landed (PPV present, zero impression events), show impressions
      // as "—" rather than "0" — the comprehensive report with impression
      // events hasn't published yet. 0 PPV + 0 impressions on a day with
      // engagement data IS a real zero (no activity that day).
      const partialEngagement =
        b.engagementDataAvailable && b.impressions === 0 && b.productPageViews > 0;

      return {
        date,
        impressions: !b.engagementDataAvailable || partialEngagement ? null : b.impressions,
        impressionsUniqueDevice: 0,
        productPageViews: b.engagementDataAvailable ? b.productPageViews : null,
        productPageViewsUniqueDevice: 0,
        installs: displayInstalls,
        // Analytics-attributed installs (First-time download in the ASC
        // Analytics COMMERCE report). NOT the same as displayInstalls when
        // S&T fills the gap. Used for conversion rate only.
        analyticsInstalls: b.commerceDataAvailable ? b.analyticsInstalls : null,
        engagementDataAvailable: b.engagementDataAvailable,
        commerceDataAvailable: b.commerceDataAvailable,
        installsFromSalesAndTrends: stCovered,
        partialEngagement,
      };
    });

  // Sum nulls as 0 for totals. Display totals use the S&T-preferred number
  // so the summary card matches Overview.
  const totals = perDay.reduce((acc, d) => ({
    impressions: acc.impressions + (d.impressions || 0),
    productPageViews: acc.productPageViews + (d.productPageViews || 0),
    installs: acc.installs + (d.installs || 0),
    redownloads: acc.redownloads + (perDayMap.get(d.date)?.redownloads || 0),
  }), { impressions: 0, productPageViews: 0, installs: 0, redownloads: 0 });

  // Conversion rate must use ANALYTICS-ATTRIBUTED installs, not S&T
  // installs. S&T counts every install regardless of path (search "Get"
  // without page view, iCloud restores, universal-purchase auto-installs),
  // so S&T-installs / Analytics-PPV is structurally > 100% and meaningless
  // as a funnel conversion metric. Analytics-attributed installs come from
  // the ASC Analytics COMMERCE report (First-time download rows), which
  // Apple aggregates against the same user journeys as the PPV events.
  //
  // Only include days where BOTH engagement AND commerce data are available
  // — otherwise we'd be dividing incomplete data by complete data.
  const attributableDays = perDay.filter(d =>
    d.engagementDataAvailable && d.commerceDataAvailable
  );
  const attributableInstalls = attributableDays.reduce((s, d) => s + (d.analyticsInstalls || 0), 0);
  const attributablePpv = attributableDays.reduce((s, d) => s + (d.productPageViews || 0), 0);
  // Apple's Analytics COMMERCE report lags Sales & Trends by several days
  // for install attribution — a day can have the commerce "summary"
  // (Auto-updates etc.) but zero First-time download rows while S&T
  // already knows there were real installs that day. If every attributable
  // day shows analyticsInstalls=0 but we know (from S&T) there were
  // installs, that's "attribution pending", not "nobody converted". Show
  // "—" instead of a misleading 0.0%.
  const attributableSalesInstalls = attributableDays.reduce(
    (s, d) => s + (d.installsFromSalesAndTrends && typeof d.installs === 'number' ? d.installs : 0),
    0
  );
  const attributionPending = attributableInstalls === 0 && attributableSalesInstalls > 0;
  const conversionRate = (attributableDays.length > 0 && attributablePpv > 0 && !attributionPending)
    ? attributableInstalls / attributablePpv
    : null;

  return {
    days: d,
    installsSource: salesInstallsSource,
    totals: {
      impressions: totals.impressions,
      impressionsUniqueDevice: 0,
      productPageViews: totals.productPageViews,
      productPageViewsUniqueDevice: 0,
      installs: totals.installs,
      redownloads: totals.redownloads,
      conversionRate,
    },
    perDay,
    // Count only days where SOME real data is available (not the null-filled
    // placeholder rows). The client uses this to decide whether to render
    // the funnel section at all — a fully-empty perDay means no Apple data
    // has been cached yet for this connection.
    dataCoverageDays: perDay.filter(d =>
      d.engagementDataAvailable || d.commerceDataAvailable || d.installsFromSalesAndTrends
    ).length,
  };
}

async function getInstallsBySource({ connectionId, days = 14 }) {
  const { rows, days: d } = await loadCategoryRows({
    connectionId, category: 'APP_STORE_ENGAGEMENT', days,
  });
  // Match the funnel's effective date window: filter rows by their own Date
  // field, not just by the cache instance's processing_date. Apple's
  // per-instance CSVs contain rows spanning MANY event dates (a report
  // published Sep 25 holds rows dated back to Sep 15+). Without this
  // filter, sources totals balloon to several multiples of what the funnel
  // reports for the same window.
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - d);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  // Aggregate by Source Type. Long-format schema means each metric lives in
  // its own row keyed by Event — bucket accumulation branches on Event.
  const bySource = new Map();
  for (const row of rows) {
    for (const r of row.rows || []) {
      const rowDate = String(r?.Date || '').slice(0, 10);
      if (!rowDate || rowDate < cutoffIso) continue;
      const sourceType = String(r['Source Type'] || 'Unknown').trim() || 'Unknown';
      const campaign = String(r['Campaign'] || '').trim();
      const bucket = bySource.get(sourceType) || {
        impressions: 0,
        impressionsUniqueDevice: 0,
        productPageViews: 0,
        productPageViewsUniqueDevice: 0,
        campaigns: new Map(),
      };
      if (r && r.Event !== undefined) {
        const c = toInt(r.Counts);
        if (IMPRESSION_EVENTS.has(r.Event)) bucket.impressions += c;
        else if (PAGE_VIEW_EVENTS.has(r.Event) && PAGE_VIEW_PAGE_TYPES.has(r['Page Type'])) {
          bucket.productPageViews += c;
          if (campaign) bucket.campaigns.set(campaign, (bucket.campaigns.get(campaign) || 0) + c);
        }
      } else {
        bucket.impressions += toInt(r['Impressions']);
        bucket.impressionsUniqueDevice += toInt(r['Impressions Unique Device']);
        bucket.productPageViews += toInt(r['Product Page Views']);
        bucket.productPageViewsUniqueDevice += toInt(r['Product Page Views Unique Device']);
        if (campaign) bucket.campaigns.set(campaign, (bucket.campaigns.get(campaign) || 0) + toInt(r['Product Page Views']));
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
  sources.sort((a, b) => b.impressions - a.impressions);
  return { days: d, sources };
}

// Ad attribution report — joins engagement (PPVs) and commerce (installs)
// data by (Source Type, Campaign) so paid-ad performance can be measured
// end-to-end: source → page visit → install.
//
// Apple's "Source Type" values:
//   - App Store search    — organic search OR Apple Search Ads (distinguished
//                           by the Campaign column being non-empty for ads)
//   - App Store browse    — organic browsing
//   - App referrer        — deep link from another app
//   - Web referrer        — external URL (includes web ads with attribution)
//   - Unavailable         — Apple couldn't attribute
//
// Only First-time downloads count as install-per-source (Restore is same
// user reinstalling, doesn't reflect ad effectiveness).
async function getAdAttribution({ connectionId, days = 14 }) {
  const [engagement, commerce] = await Promise.all([
    loadCategoryRows({ connectionId, category: 'APP_STORE_ENGAGEMENT', days }),
    loadCategoryRows({ connectionId, category: 'COMMERCE', days }),
  ]);
  const d = engagement.days;
  // Row-level event-date cutoff (matches what getInstallFunnel does). Apple's
  // cached report instances contain rows spanning multiple event dates — an
  // instance from processing_date=09-30 can hold rows for 09-22..09-29. Without
  // this filter, Ad Attribution totals balloon past the App Store tile which
  // DOES filter by event date, and user-facing numbers stop corresponding.
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - d);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const inWindow = (r) => {
    const dateKey = String(r?.Date || '').slice(0, 10);
    return dateKey && dateKey >= cutoffIso;
  };

  // Aggregate PPVs by (sourceType, campaign) — this is the "visited store
  // page" side of the funnel.
  const engagementByKey = new Map();
  for (const inst of engagement.rows) {
    for (const r of inst.rows || []) {
      if (!inWindow(r)) continue;
      const sourceType = String(r['Source Type'] || 'Unknown').trim() || 'Unknown';
      const campaign = String(r['Campaign'] || '').trim() || '(none)';
      const key = `${sourceType}|${campaign}`;
      const b = engagementByKey.get(key) || { impressions: 0, productPageViews: 0 };
      if (r.Event !== undefined) {
        const c = toInt(r.Counts);
        if (IMPRESSION_EVENTS.has(r.Event)) b.impressions += c;
        else if (PAGE_VIEW_EVENTS.has(r.Event) && PAGE_VIEW_PAGE_TYPES.has(r['Page Type'])) {
          b.productPageViews += c;
        }
      } else {
        b.impressions += toInt(r['Impressions']);
        b.productPageViews += toInt(r['Product Page Views']);
      }
      engagementByKey.set(key, b);
    }
  }

  // Aggregate installs (First-time downloads only) by (sourceType, campaign).
  const installsByKey = new Map();
  for (const inst of commerce.rows) {
    for (const r of inst.rows || []) {
      if (!inWindow(r)) continue;
      const downloadType = String(r['Download Type'] || '').trim();
      if (downloadType !== 'First-time download') continue;
      const sourceType = String(r['Source Type'] || 'Unknown').trim() || 'Unknown';
      const campaign = String(r['Campaign'] || '').trim() || '(none)';
      const key = `${sourceType}|${campaign}`;
      installsByKey.set(key, (installsByKey.get(key) || 0) + toInt(r.Counts));
    }
  }

  // Merge — one row per (sourceType, campaign) with all metrics.
  const allKeys = new Set([...engagementByKey.keys(), ...installsByKey.keys()]);
  const rows = [];
  for (const key of allKeys) {
    const [sourceType, campaign] = key.split('|');
    const eng = engagementByKey.get(key) || { impressions: 0, productPageViews: 0 };
    const installs = installsByKey.get(key) || 0;
    const conversionRate = eng.productPageViews > 0 ? installs / eng.productPageViews : null;
    rows.push({
      sourceType,
      campaign,
      // Distinguish paid campaigns from organic — anything with a real
      // campaign string is a tagged marketing effort; "(none)" is organic.
      isPaid: campaign !== '(none)',
      impressions: eng.impressions,
      productPageViews: eng.productPageViews,
      installs,
      conversionRate,
    });
  }

  // Sort: paid rows first (by installs desc), then organic (by installs desc).
  rows.sort((a, b) => {
    if (a.isPaid !== b.isPaid) return a.isPaid ? -1 : 1;
    return b.installs - a.installs;
  });

  // Totals for the section header.
  const totals = rows.reduce((acc, r) => ({
    impressions: acc.impressions + r.impressions,
    productPageViews: acc.productPageViews + r.productPageViews,
    installs: acc.installs + r.installs,
  }), { impressions: 0, productPageViews: 0, installs: 0 });
  const paidTotals = rows.filter(r => r.isPaid).reduce((acc, r) => ({
    productPageViews: acc.productPageViews + r.productPageViews,
    installs: acc.installs + r.installs,
  }), { productPageViews: 0, installs: 0 });

  return { days: d, rows, totals, paidTotals };
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

// -----------------------------------------------------------------------
// Meta Ads overlay — "what from Sources is Meta Ads?"
// -----------------------------------------------------------------------
// Apple's Source Type taxonomy only knows "App referrer" / "Web referrer" —
// it doesn't tell us WHICH app or site did the referring. Meta Ads' own
// Marketing API, meanwhile, knows exactly which campaigns promoted which
// app and how many installs each drove. We cross-reference by:
//
//   1. Load the user's Meta owner token + selected ad accounts.
//   2. Walk adsets, keep only those whose promoted_object.object_store_url
//      contains the Apple appId of THIS ASC connection.
//   3. Sum the daily insights (app_install + mobile_app_install +
//      omni_app_install) over the same date window.
//
// Returns null when the user has no Meta connection, or when no campaigns
// are promoting this specific app. The route surfaces that as an empty
// panel with a hint, not an error.
async function getMetaAdsOverlayForApp(userId, { appleAppId, days = 14 } = {}) {
  if (!userId || !appleAppId) return null;

  const token = await connections.getMetaOwnerToken(userId);
  if (!token?.accessToken) return { connected: false, reason: 'meta_not_connected' };

  const sel = await connections.getMetaAdAccountSelection(userId);
  if (!sel.adAccountIds.length) return { connected: true, reason: 'no_ad_accounts_selected' };

  // Normalize days for Meta's time_range cap (90 days hard limit on
  // some endpoints; getInsights handles up to Meta's limit internally).
  const daysClamped = Math.max(1, Math.min(90, parseInt(days, 10) || 14));

  const perAccount = [];
  let totalInstalls = 0, totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalAppStoreVisits = 0;
  const campaigns = [];

  for (const acct of sel.adAccountIds) {
    try {
      // Load adsets to find which ones promote this specific iOS app.
      const adsets = await metaAds.getAdSets({
        accessToken: token.accessToken, adAccountId: acct, days: daysClamped,
      });
      const matchingAdsets = adsets.filter(a =>
        String(a.promotedObject?.object_store_url || '').includes(appleAppId)
      );
      const matchingCampaignIds = new Set(matchingAdsets.map(a => a.campaignId).filter(Boolean));
      if (matchingCampaignIds.size === 0) {
        perAccount.push({ adAccountId: acct, campaigns: 0, installs: 0, spend: 0, appStoreVisits: 0 });
        continue;
      }

      // Insights for matching campaigns only.
      const insights = await metaAds.getInsights({
        accessToken: token.accessToken, node: acct, level: 'campaign', days: daysClamped,
      });
      const matched = insights.rows.filter(r => matchingCampaignIds.has(r.campaignId));

      let acctInstalls = 0, acctSpend = 0, acctImpr = 0, acctClicks = 0, acctVisits = 0;
      for (const r of matched) {
        const a = r.actionsByType || {};
        const inst = (a.app_install || 0) + (a.mobile_app_install || 0) + (a.omni_app_install || 0);
        // Meta's app_store_visit = the user clicked the ad and landed on
        // the App Store page. This is the direct analog to Apple's
        // "App referrer" PPVs — comparing the two tells you how much of
        // that App referrer bucket Meta is actually driving.
        const visits = a.app_store_visit || 0;
        acctInstalls += inst;
        acctSpend += Number(r.spend || 0);
        acctImpr += Number(r.impressions || 0);
        acctClicks += Number(r.clicks || 0);
        acctVisits += visits;
        campaigns.push({
          campaignId: r.campaignId,
          campaignName: r.campaignName,
          installs: inst,
          appStoreVisits: visits,
          spend: Number(r.spend || 0),
          impressions: Number(r.impressions || 0),
          clicks: Number(r.clicks || 0),
        });
      }
      totalInstalls += acctInstalls;
      totalSpend += acctSpend;
      totalImpressions += acctImpr;
      totalClicks += acctClicks;
      totalAppStoreVisits += acctVisits;
      perAccount.push({
        adAccountId: acct,
        campaigns: matchingCampaignIds.size,
        installs: acctInstalls,
        appStoreVisits: acctVisits,
        spend: acctSpend,
      });
    } catch (err) {
      logger.warn('asc_analytics.meta_overlay.account_failed', {
        userId, adAccountId: acct, error: err.message,
      });
      perAccount.push({ adAccountId: acct, error: err.message });
    }
  }

  return {
    connected: true,
    days: daysClamped,
    totals: {
      installs: totalInstalls,
      appStoreVisits: totalAppStoreVisits,
      spend: Number(totalSpend.toFixed(2)),
      impressions: totalImpressions,
      clicks: totalClicks,
      costPerInstall: totalInstalls > 0 ? Number((totalSpend / totalInstalls).toFixed(2)) : null,
    },
    perAccount,
    campaigns: campaigns.sort((a, b) => b.installs - a.installs).slice(0, 10),
  };
}

module.exports = {
  bootstrap,
  walk,
  getInstallFunnel,
  getInstallsBySource,
  getAdAttribution,
  getStatus,
  getMetaAdsOverlayForApp,
  _internal: { loadCategoryRows, toInt, CATEGORIES },
};
