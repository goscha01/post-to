// Google Analytics 4 read-only service.
//
// Two Google APIs are used:
//   - Admin API (analyticsadmin v1beta) → list properties for property discovery
//   - Data  API (analyticsdata  v1beta) → runReport for all dashboard queries
//
// Auth model: reuses the OAuth refresh token stored on users.business_profiles
// (same Google account that granted GMB access; analytics.readonly was added to
// BUSINESS_SCOPES so a single consent covers both). Callers pass a live access
// token; the businessTokens helper handles proactive/reactive refresh.
//
// Shape of returned rows is deliberately generic (source/medium/campaign/…)
// so a future Google Ads integration can join against them without a data
// model change: e.g. adsCampaign.utm_campaign → ga4Report.rows[].dimensions.
//
// All methods are read-only. No writes to any GA4 resource.

const { google } = require('googleapis');
const logger = require('../utils/logger');

// ---------- OAuth client factory ----------

function oauthClientFor(accessToken) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials({ access_token: accessToken });
  return client;
}

// ---------- Property discovery (Admin API) ----------

// Lists every GA4 property the authed Google account can read. We walk
// accountSummaries so we get the account → property tree in one pass.
async function listProperties(accessToken) {
  const auth = oauthClientFor(accessToken);
  const admin = google.analyticsadmin({ version: 'v1beta', auth });

  const out = [];
  let pageToken;
  do {
    const { data } = await admin.accountSummaries.list({ pageSize: 200, pageToken });
    (data.accountSummaries || []).forEach(acct => {
      (acct.propertySummaries || []).forEach(prop => {
        // property = "properties/123456789" → strip prefix for storage
        const propertyId = String(prop.property || '').replace(/^properties\//, '');
        out.push({
          propertyId,
          displayName: prop.displayName || propertyId,
          propertyType: prop.propertyType || null,
          parent: prop.parent || null,
          accountId: String(acct.account || '').replace(/^accounts\//, ''),
          accountName: acct.displayName || null,
        });
      });
    });
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);

  return out;
}

// ---------- Date range helpers ----------

function dateRangeFromDays(days) {
  const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  return [{ startDate: `${n}daysAgo`, endDate: 'today' }];
}

// ---------- Data API report runner ----------

async function runReport(accessToken, propertyId, body) {
  const auth = oauthClientFor(accessToken);
  const data = google.analyticsdata({ version: 'v1beta', auth });
  const { data: response } = await data.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: body,
  });
  return response;
}

// Turn a GA4 runReport response into a rows-of-objects shape keyed by
// dimension / metric names — the callers don't want to index by column
// position.
function shapeReport(response) {
  const dimHeaders = (response.dimensionHeaders || []).map(h => h.name);
  const metHeaders = (response.metricHeaders || []).map(h => h.name);
  const rows = (response.rows || []).map(r => {
    const out = {};
    (r.dimensionValues || []).forEach((v, i) => { out[dimHeaders[i]] = v.value ?? null; });
    (r.metricValues || []).forEach((v, i) => {
      const raw = v.value;
      const num = raw == null ? null : Number(raw);
      out[metHeaders[i]] = Number.isFinite(num) ? num : raw;
    });
    return out;
  });
  return {
    rows,
    rowCount: response.rowCount || rows.length,
    dimensionHeaders: dimHeaders,
    metricHeaders: metHeaders,
    totals: (response.totals || []).map(t => ({
      metrics: (t.metricValues || []).map((v, i) => ({ name: metHeaders[i], value: v.value })),
    })),
  };
}

// ---------- Dashboard reports ----------

// Events that identify a currently-paid user in ProofPix:
//   - purchase: server-side event from the Apple Server Notifications V2 webhook
//     (proof-pix-proxy) — fires only for confirmed paid periods, never trials
//   - subscription_active: client-side event that fires on any cold start when
//     the app sees an active entitlement (paid or trial-with-conversion)
// activeUsers with a dimensionFilter on eventName IN these values returns the
// distinct-user count who fired *any* of them in the period — i.e. our paid MAU.
const PAID_USER_EVENTS = ['purchase', 'subscription_active'];

async function getOverview(accessToken, propertyId, days) {
  const dateRanges = dateRangeFromDays(days);

  // Three parallel Data API calls. Kept separate because GA4 forbids mixing
  // dimensionFilter scopes (per-event filter would corrupt the base totals).
  //
  // The ordered funnel with drop-off lives in a separate endpoint
  // (getInAppFunnel → runFunnelReport). This overview keeps the scalar tiles
  // the UI shows above the funnel: totals, paid-user split, and activated
  // count (needed for the Lead → User / User → Paid rate tiles).
  const [overviewRes, paidUsersRes, activatedUsersRes] = await Promise.all([
    runReport(accessToken, propertyId, {
      dateRanges,
      metrics: [
        { name: 'activeUsers' },
        { name: 'newUsers' },
        { name: 'sessions' },
        { name: 'engagedSessions' },
        { name: 'averageSessionDuration' },
        { name: 'userEngagementDuration' },
        { name: 'engagementRate' },
        { name: 'conversions' },
        { name: 'totalRevenue' },
        { name: 'screenPageViews' },
      ],
    }),
    runReport(accessToken, propertyId, {
      dateRanges,
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: { values: PAID_USER_EVENTS },
        },
      },
    }),
    runReport(accessToken, propertyId, {
      dateRanges,
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { matchType: 'EXACT', value: 'first_photo_taken' },
        },
      },
    }),
  ]);

  const overviewTotals = (shapeReport(overviewRes).rows[0] || {});
  const paidUsers = Number(shapeReport(paidUsersRes).rows[0]?.activeUsers || 0);
  const activatedUsers = Number(shapeReport(activatedUsersRes).rows[0]?.activeUsers || 0);

  const totalUsers = Number(overviewTotals.activeUsers || 0);
  // Free = total − paid. Clamp to 0 so a race between the two independent
  // reports (rare — different sampling seeds) can't surface a negative count.
  const freeUsers = Math.max(0, totalUsers - paidUsers);

  // NOTE: When there are no dimensions GA4 returns a single row with all metrics.
  // Handle the empty-property case by defaulting each field to 0.
  return {
    users: totalUsers,
    newUsers: Number(overviewTotals.newUsers || 0),
    sessions: Number(overviewTotals.sessions || 0),
    engagedSessions: Number(overviewTotals.engagedSessions || 0),
    averageSessionDuration: Number(overviewTotals.averageSessionDuration || 0),
    averageEngagementTime: Number(overviewTotals.userEngagementDuration || 0),
    engagementRate: Number(overviewTotals.engagementRate || 0),
    conversions: Number(overviewTotals.conversions || 0),
    totalRevenue: Number(overviewTotals.totalRevenue || 0),
    pageViews: Number(overviewTotals.screenPageViews || 0),
    freeUsers,
    paidUsers,
    activatedUsers,
    // ProofPix-flavoured funnel rates:
    //   Lead → User  = activated / total users     (of everyone who opened, who tried it)
    //   User → Paid  = paid / activated             (of everyone who tried it, who paid)
    leadToUserRate: totalUsers > 0 ? activatedUsers / totalUsers : 0,
    userToPaidRate: activatedUsers > 0 ? paidUsers / activatedUsers : 0,
    rangeDays: Math.max(1, Math.min(365, parseInt(days, 10) || 30)),
  };
}

async function getTrafficSources(accessToken, propertyId, days) {
  const response = await runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
    dimensions: [
      { name: 'sessionSource' },
      { name: 'sessionMedium' },
      { name: 'sessionCampaignName' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'conversions' },
      { name: 'totalRevenue' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 100,
  });
  const shaped = shapeReport(response);
  return shaped.rows.map(r => ({
    source: r.sessionSource || '(direct)',
    medium: r.sessionMedium || '(none)',
    campaign: r.sessionCampaignName || '(not set)',
    sessions: Number(r.sessions || 0),
    users: Number(r.activeUsers || 0),
    conversions: Number(r.conversions || 0),
    revenue: Number(r.totalRevenue || 0),
  }));
}

async function getLandingPages(accessToken, propertyId, days) {
  const response = await runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
    dimensions: [{ name: 'landingPage' }],
    metrics: [
      { name: 'sessions' },
      { name: 'engagementRate' },
      { name: 'userEngagementDuration' },
      { name: 'conversions' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 100,
  });
  const shaped = shapeReport(response);
  return shaped.rows.map(r => ({
    landingPage: r.landingPage || '(not set)',
    sessions: Number(r.sessions || 0),
    engagementRate: Number(r.engagementRate || 0),
    averageEngagementTime: Number(r.userEngagementDuration || 0),
    conversions: Number(r.conversions || 0),
  }));
}

async function getDevices(accessToken, propertyId, days) {
  const response = await runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
    dimensions: [{ name: 'deviceCategory' }],
    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'conversions' },
      { name: 'sessionConversionRate' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 20,
  });
  const shaped = shapeReport(response);
  return shaped.rows.map(r => ({
    device: r.deviceCategory || '(unknown)',
    sessions: Number(r.sessions || 0),
    users: Number(r.activeUsers || 0),
    conversions: Number(r.conversions || 0),
    conversionRate: Number(r.sessionConversionRate || 0),
  }));
}

async function getGeography(accessToken, propertyId, days) {
  const response = await runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
    dimensions: [
      { name: 'country' },
      { name: 'region' },
      { name: 'city' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'conversions' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 200,
  });
  const shaped = shapeReport(response);
  return shaped.rows.map(r => ({
    country: r.country || '(unknown)',
    region: r.region || '(unknown)',
    city: r.city || '(unknown)',
    sessions: Number(r.sessions || 0),
    users: Number(r.activeUsers || 0),
    conversions: Number(r.conversions || 0),
  }));
}

// Highlighted event names — surfaced in the UI's "key events" strip. Kept as a
// plain list so future events (bookings from other flows, etc.) can be added
// without a schema change.
const HIGHLIGHTED_EVENTS = new Set([
  'generate_lead',
  'booking_completed',
  'phone_click',
  'quote_requested',
]);

async function getEvents(accessToken, propertyId, days) {
  const response = await runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
    dimensions: [{ name: 'eventName' }],
    metrics: [
      { name: 'eventCount' },
      { name: 'activeUsers' },
    ],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 100,
  });
  const shaped = shapeReport(response);
  const rows = shaped.rows.map(r => ({
    eventName: r.eventName || '(not set)',
    eventCount: Number(r.eventCount || 0),
    users: Number(r.activeUsers || 0),
    highlighted: HIGHLIGHTED_EVENTS.has(r.eventName),
  }));
  const highlighted = rows.filter(r => r.highlighted);
  return { rows, highlighted };
}

// ---------- Ordered funnel (GA4 Data API v1alpha runFunnelReport) ----------
//
// The stable v1beta Data API only supports flat reports, not funnels. Ordered
// drop-off (each step requires the user to have completed all prior steps)
// requires the v1alpha endpoint `properties.runFunnelReport`, which the
// googleapis npm package doesn't yet expose (128.0.0 as of writing). We hit
// the REST endpoint directly via the OAuth2 client's `.request()` — same
// auth, no SDK dep.
//
// ProofPix's canonical acquisition funnel, defined entirely with event-name
// filters. runFunnelReport rejects both `screen_name` (event parameter) and
// `screenName` (built-in dimension) — its whitelist of fields allowed inside
// funnel steps is narrow. Fortunately, ProofPix fires dedicated events at
// each stage of the flow, so we can build a proper ordered funnel without
// touching screens at all.
//
// Per-onboarding-screen drop-off would require registering `screen_name` as
// a custom event-scoped dimension in GA4 Admin (which unlocks the
// `customEvent:screen_name` field for funnel filters). Kept as a future
// enhancement — not needed for the top-line lead → paid picture.
// Ordering reflects ProofPix's actual paid flow, verified against real
// per-event distinct-user counts (see 2026-09-29 debug session):
//   - onboarding_started was dropped: 25 users completed onboarding but 0
//     fired 'started', meaning the app skips WelcomeSetupScreen for most
//     users. Including it black-holed every downstream step.
//   - first_photo_taken was dropped from the strict paid funnel: paywall_view
//     (16) > first_photo_taken (7), so the paywall is shown DURING onboarding
//     before users have a chance to take a photo. Activation is a parallel
//     signal, not a paid-funnel gate. Still visible in the Events section.
const IN_APP_FUNNEL_STEPS = [
  { key: 'first_open',       label: 'First open',       filter: eventNameFilter('first_open') },
  { key: 'onboarding_done',  label: 'Onboarding done',  filter: eventNameFilter('onboarding_completed') },
  { key: 'paywall',          label: 'Saw paywall',      filter: eventNameFilter('paywall_view') },
  { key: 'plan_selected',    label: 'Selected a plan',  filter: eventNameFilter('plan_selected') },
  { key: 'purchase_start',   label: 'Started purchase', filter: eventNameFilter('purchase_started') },
  { key: 'paid',             label: 'Paid',             filter: eventNameFilter('purchase') },
];

function eventNameFilter(eventName) {
  return { funnelEventFilter: { eventName } };
}

async function getInAppFunnel(accessToken, propertyId, days) {
  const rangeDays = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const auth = oauthClientFor(accessToken);
  const body = {
    dateRanges: dateRangeFromDays(days),
    funnel: {
      // isOpenFunnel=false → strict ordered funnel: step N users must have
      // fired the events for steps 1..N-1 in order. This is what makes the
      // drop-off comparisons monotonic (never negative).
      isOpenFunnel: false,
      steps: IN_APP_FUNNEL_STEPS.map(s => ({
        name: s.label,
        filterExpression: s.filter,
      })),
    },
  };
  const url = `https://analyticsdata.googleapis.com/v1alpha/properties/${propertyId}:runFunnelReport`;

  // Also run the raw per-event distinct-users query in parallel, so the
  // frontend can show BOTH the sequential funnel count and the "did this
  // event ever fire, regardless of order" count. Diagnoses the common
  // situation where runFunnelReport shows 0 for step N but the event
  // is clearly firing — that means users hit the event out of order
  // (e.g. skipped onboarding_started, or fired paywall_view before
  // first_photo_taken).
  const stepEventNames = [...new Set(
    IN_APP_FUNNEL_STEPS.map(s => s.filter?.funnelEventFilter?.eventName).filter(Boolean)
  )];
  const rawUsersPromise = runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'activeUsers' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: stepEventNames },
      },
    },
  }).catch(err => {
    // Non-fatal — funnel still renders without the raw counts.
    logger.warn('analytics.funnel.raw_counts_failed', { message: err.message });
    return null;
  });

  try {
    const [{ data: response }, rawUsersRes] = await Promise.all([
      auth.request({ url, method: 'POST', data: body }),
      rawUsersPromise,
    ]);
    // funnelTable rows are one-per-step, in the same order as the steps we
    // submitted. GA4 prefixes the step name with "1. ", "2. " etc. in the
    // response, so matching by name silently returns 0 for every step. Use
    // row order — runFunnelReport guarantees it matches the request order.
    const rows = response?.funnelTable?.rows || [];
    if (rows.length !== IN_APP_FUNNEL_STEPS.length) {
      // Log so we notice if GA4 ever changes the response shape (e.g. adds
      // a "start audience" row). Non-fatal — we still map what we can.
      logger.warn('analytics.funnel.row_count_mismatch', {
        expected: IN_APP_FUNNEL_STEPS.length,
        got: rows.length,
      });
    }
    const rawByEvent = rawUsersRes
      ? new Map(shapeReport(rawUsersRes).rows.map(r => [r.eventName, Number(r.activeUsers || 0)]))
      : new Map();
    const funnel = IN_APP_FUNNEL_STEPS.map((s, idx) => {
      const evName = s.filter?.funnelEventFilter?.eventName;
      return {
        key: s.key,
        label: s.label,
        users: Number(rows[idx]?.metricValues?.[0]?.value || 0),
        rawUsers: evName ? (rawByEvent.get(evName) ?? null) : null,
        event: describeStepFilter(s.filter),
      };
    });
    return { funnel, source: 'runFunnelReport', rangeDays };
  } catch (err) {
    // v1alpha runFunnelReport can 4xx for various reasons (schema mismatch,
    // preview-API quirk, property tier). Log the raw response so we can see
    // what Google is objecting to, then fall back to per-step distinct-user
    // counts using v1beta runReport (proven stable). The fallback isn't a
    // *true* ordered funnel — users could skip a screen and still be counted
    // at a later step — but for ProofPix's linear onboarding it's a close
    // approximation and beats an empty section.
    const errorData = err?.response?.data;
    const errorMessage = errorData?.error?.message || err?.message || 'unknown';
    console.error('[analytics.funnel] runFunnelReport failed:', errorMessage, JSON.stringify(errorData || {}).slice(0, 600));
    logger.error('analytics.funnel.runFunnelReport_failed', {
      propertyId,
      days: rangeDays,
      status: err?.response?.status || err?.status,
      message: errorMessage,
      errorData: errorData || null,
    });
    // v1beta fallback: reuse the raw per-event counts we already queried
    // above (rawUsersPromise). No second call needed.
    const rawUsersRes = await rawUsersPromise;
    const usersByEvent = rawUsersRes
      ? new Map(shapeReport(rawUsersRes).rows.map(r => [r.eventName, Number(r.activeUsers || 0)]))
      : new Map();
    const funnel = IN_APP_FUNNEL_STEPS.map(s => {
      const evName = s.filter?.funnelEventFilter?.eventName;
      const users = evName ? (usersByEvent.get(evName) || 0) : 0;
      // In fallback mode users and rawUsers are the same (both from the
      // per-event query). Set explicitly so the frontend renders uniformly.
      return { key: s.key, label: s.label, users, rawUsers: users, event: describeStepFilter(s.filter) };
    });
    return {
      funnel,
      source: 'v1beta_fallback',
      fallbackReason: errorMessage,
      rangeDays,
    };
  }
}

// Reverse the filter object back into a human-readable "source event" tag for
// the UI tooltip. Kept dumb — just introspects the two structures we build
// above (event-name filter vs. screenName field filter).
function describeStepFilter(filter) {
  if (filter?.funnelEventFilter?.eventName) {
    return filter.funnelEventFilter.eventName;
  }
  return '(unknown)';
}

// Breakdown of plan_selected events by plan_id + billing_period. Powers the
// "which plan is being picked" sub-step under the Selected a plan funnel row.
//
// Depends on `plan_id` and `billing_period` being registered as event-scoped
// custom dimensions in GA4 Admin → Custom Definitions. Without registration
// GA4 returns 400 "Field customEvent:X is not a valid dimension" — we catch
// that so the funnel stays rendered and the frontend can show a hint.
async function getPlanSelectedBreakdown(accessToken, propertyId, days) {
  const rangeDays = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  try {
    const response = await runReport(accessToken, propertyId, {
      dateRanges: dateRangeFromDays(days),
      dimensions: [
        { name: 'customEvent:plan_id' },
        { name: 'customEvent:billing_period' },
      ],
      metrics: [{ name: 'activeUsers' }, { name: 'eventCount' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { matchType: 'EXACT', value: 'plan_selected' },
        },
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 30,
    });
    const shaped = shapeReport(response);
    return {
      rows: shaped.rows.map(r => ({
        plan: r['customEvent:plan_id'] || '(not set)',
        billingPeriod: r['customEvent:billing_period'] || '(not set)',
        users: Number(r.activeUsers || 0),
        eventCount: Number(r.eventCount || 0),
      })),
      rangeDays,
    };
  } catch (err) {
    // Custom dimensions not registered in GA4 Admin → return empty + error
    // so the frontend can render a "register these custom dims" hint.
    const message = err?.response?.data?.error?.message || err?.message || 'unknown';
    logger.warn('analytics.plan_selected_breakdown.failed', { propertyId, message });
    return { rows: [], error: message, rangeDays };
  }
}

// Distinct users per screen (via GA4's built-in `screenName` dimension).
// Used by the frontend to render screen-level sub-steps under each in-app
// funnel step — the classic "which onboarding screen do people leak on".
// Unordered by design: a user who fired screen_view for screen 3 without
// screen 2 still counts for screen 3, because GA4's runFunnelReport (the
// only source of ordered semantics) doesn't accept screenName as a filter.
// For ProofPix's linear onboarding this approximation is close to real
// drop-off but may show small non-monotonic dips when users skip a screen.
async function getScreenViews(accessToken, propertyId, days) {
  const response = await runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
    dimensions: [{ name: 'screenName' }],
    metrics: [{ name: 'activeUsers' }],
    orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
    limit: 200,
  });
  const shaped = shapeReport(response);
  return {
    screens: shaped.rows.map(r => ({
      screenName: r.screenName || '(not set)',
      users: Number(r.activeUsers || 0),
    })),
    rangeDays: Math.max(1, Math.min(365, parseInt(days, 10) || 30)),
  };
}

async function getCampaigns(accessToken, propertyId, days) {
  const response = await runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
    // sessionCampaignName reads utm_campaign as attributed to the session.
    dimensions: [
      { name: 'sessionCampaignName' },
      { name: 'sessionSource' },
      { name: 'sessionMedium' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'conversions' },
      { name: 'totalRevenue' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 100,
  });
  const shaped = shapeReport(response);
  return shaped.rows
    .map(r => ({
      campaign: r.sessionCampaignName || '(not set)',
      source: r.sessionSource || '(direct)',
      medium: r.sessionMedium || '(none)',
      sessions: Number(r.sessions || 0),
      users: Number(r.activeUsers || 0),
      conversions: Number(r.conversions || 0),
      revenue: Number(r.totalRevenue || 0),
    }))
    // Drop the giant "(not set)" bucket for the campaigns view — it's covered by
    // the traffic-sources view already, and dominates the sort otherwise.
    .filter(r => r.campaign && r.campaign !== '(not set)');
}

// Normalized error surface so route handlers can distinguish "no permission"
// (403) from "bad property id" (404) from generic failures. Caller logs the
// stack; we only log the message here for the Loki structured log line.
//
// Two flavors of 403 matter to callers:
//   - PROPERTY_PERMISSION_DENIED — the OAuth account is not a GA4 Viewer on
//     the property. Fix: add that Google account in GA4 Admin, or route the
//     call through a different connected Google account.
//   - SCOPE_MISSING             — analytics.readonly was not granted at
//     OAuth-consent time. Fix: reconnect Google (frontend "needsReauth" path).
function normalizeApiError(err, context) {
  const status =
    err?.response?.status ||
    err?.code ||
    err?.status ||
    null;
  const message = err?.response?.data?.error?.message || err?.message || 'analytics_api_error';
  const numericStatus = typeof status === 'number' ? status : parseInt(status, 10) || 500;
  const isPropertyPermission = numericStatus === 403 &&
    /sufficient permissions? for this property/i.test(message);
  const isScopeMissing = numericStatus === 403 &&
    /insufficient (authentication )?scopes?/i.test(message);

  logger.error('analytics.api_error', {
    ...(context || {}),
    status,
    message,
    code: isPropertyPermission
      ? 'PROPERTY_PERMISSION_DENIED'
      : isScopeMissing
        ? 'SCOPE_MISSING'
        : undefined,
  });
  const out = new Error(message);
  out.status = numericStatus;
  if (isPropertyPermission) out.code = 'PROPERTY_PERMISSION_DENIED';
  else if (isScopeMissing) out.code = 'SCOPE_MISSING';
  return out;
}

// ---------- Mutations (write) ----------
//
// Mark a GA4 event as a "key event" (formerly "conversion event"). This is
// the config change the AI keeps suggesting — e.g. "mark subscription_started
// as a conversion so Smart Bidding can optimize toward it".
//
// GA4 Admin API resource: properties.conversionEvents (still the stable
// name in v1beta as of 2026; v1alpha renamed it to keyEvents). Reversible
// via `.delete` on the returned resource name.
//
// Requires OAuth scope `analytics.edit`. Errors mapped to code
// SCOPE_MISSING when the caller's token doesn't have it.
async function markConversionEvent(accessToken, propertyId, eventName) {
  const pid = String(propertyId || '').replace(/^properties\//, '').trim();
  const evt = String(eventName || '').trim();
  if (!pid) throw new Error('propertyId required');
  if (!evt) throw new Error('eventName required');
  const auth = oauthClientFor(accessToken);
  const admin = google.analyticsadmin({ version: 'v1beta', auth });
  try {
    const { data } = await admin.properties.conversionEvents.create({
      parent: `properties/${pid}`,
      requestBody: { eventName: evt },
    });
    return {
      noop: false,
      resourceName: data?.name || null,
      eventName: data?.eventName || evt,
      propertyId: pid,
    };
  } catch (err) {
    // GA4 Admin API returns 409 ALREADY_EXISTS when the event is already a
    // conversion. Treat as a no-op — the target state is already met.
    const code = err?.code || err?.response?.status;
    const msg = err?.errors?.[0]?.message || err?.message || '';
    const isAlreadyExists = code === 409
      || /already exists|ALREADY_EXISTS/i.test(msg + ' ' + JSON.stringify(err?.response?.data || {}));
    if (isAlreadyExists) {
      return {
        noop: true,
        reason: `Event "${evt}" is already marked as a conversion on this property`,
        eventName: evt,
        propertyId: pid,
      };
    }
    throw err;
  }
}

// ---------- Reads (helpers for the campaign assistant) ----------
//
// List the property's current Key Events (conversion events). Used by the
// AI to check "is 'purchase' already a Key Event?" before either marking
// it or telling the user to click a Console button. Returns the raw
// resource names so the model can also cross-reference deletion targets.
async function listConversionEvents(accessToken, propertyId) {
  const pid = String(propertyId || '').replace(/^properties\//, '').trim();
  if (!pid) throw new Error('propertyId required');
  const auth = oauthClientFor(accessToken);
  const admin = google.analyticsadmin({ version: 'v1beta', auth });
  const events = [];
  let pageToken;
  do {
    const { data } = await admin.properties.conversionEvents.list({
      parent: `properties/${pid}`,
      pageSize: 200,
      pageToken,
    });
    for (const e of data?.conversionEvents || []) {
      events.push({
        resourceName: e.name || null,
        eventName: e.eventName || null,
        createTime: e.createTime || null,
        deletable: e.deletable !== false,
        custom: !!e.custom,
        countingMethod: e.countingMethod || null,
      });
    }
    pageToken = data?.nextPageToken || null;
  } while (pageToken);
  return { propertyId: pid, count: events.length, events };
}

module.exports = {
  listProperties,
  getOverview,
  getTrafficSources,
  getLandingPages,
  getDevices,
  getGeography,
  getEvents,
  getCampaigns,
  getInAppFunnel,
  getScreenViews,
  getPlanSelectedBreakdown,
  markConversionEvent,
  listConversionEvents,
  normalizeApiError,
  // exposed for tests
  _internal: { runReport, shapeReport, dateRangeFromDays, HIGHLIGHTED_EVENTS },
};
