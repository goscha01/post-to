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
// Flat 6-step funnel from install → paid using dedicated events the mobile
// app explicitly fires (first_open, onboarding_completed, paywall_view,
// plan_selected, purchase_started, purchase). All 6 are standard events — no
// custom dimension needed, strict ordering works out of the box.
//
// SCREEN-VIEW STEPS REMOVED (2026-10-08): the 3 within-onboarding screen
// steps (first_load, onboarding_welcome, onboarding_user_info) used to live
// here, filtered on screen_view by screen_name. They always returned 0
// because GA4 treats `screen_name` as a RESERVED parameter on the reserved
// `screen_view` event — the Firebase SDK routes it to the automatic
// screen-tracking slot, NOT to customEvent:screen_name. Zero events ever
// matched the filter, which collapsed the strict ordered funnel at step 2
// and cascaded zeros into every step after.
//
// To re-enable screen-level steps (post mobile-app release):
//   1. Ship logScreenView() in proof-pix-native/src/utils/analytics.js with
//      `nav_screen: screenName` as a THIRD param alongside screen_name/
//      screen_class. `nav_screen` is not reserved, so GA4 stores it in
//      customEvent:nav_screen as expected.
//   2. Re-register the custom dim as `nav_screen` on the connected GA4
//      property (already pre-registered via AUTO_REGISTER_CUSTOM_DIMS so
//      new events start populating immediately when the app release ships).
//   3. Uncomment the three screen steps below, change screenName:
//      'first_load' → navScreen: 'first_load' (and update stepFilter /
//      screenViewFilter to use eventParameterName: 'nav_screen').
const IN_APP_FUNNEL_STEPS = [
  { key: 'first_open',      label: 'First open',       eventName: 'first_open' },
  // { key: 'first_load',           label: 'First load',       eventName: 'screen_view', screenName: 'first_load' },
  // { key: 'onboarding_welcome',   label: 'Welcome',          eventName: 'screen_view', screenName: 'onboarding_welcome' },
  // { key: 'onboarding_user_info', label: 'User info (name focus)', eventName: 'screen_view', screenName: 'onboarding_user_info' },
  { key: 'onboarding_done', label: 'Onboarding done',  eventName: 'onboarding_completed' },
  { key: 'paywall',         label: 'Saw paywall',      eventName: 'paywall_view' },
  { key: 'plan_selected',   label: 'Selected a plan',  eventName: 'plan_selected' },
  { key: 'purchase_start',  label: 'Started purchase', eventName: 'purchase_started' },
  { key: 'paid',            label: 'Paid',             eventName: 'purchase' },
];

function eventNameFilter(eventName) {
  return { funnelEventFilter: { eventName } };
}

// Builds a funnel step filter for a screen_view event with a specific
// screen name. Reads the value from the `nav_screen` custom event parameter
// (NOT `screen_name` — that one is reserved by GA4 on reserved events like
// screen_view; passing it to logEvent routes the value into the automatic
// screen-tracking slot which is not queryable at property scope on hybrid
// web+app properties).
//
// Mobile-app contract: logScreenView() must pass `nav_screen` alongside
// `screen_name` (see proof-pix-native/src/utils/analytics.js). The
// `nav_screen` custom dim is auto-registered on property connect via
// AUTO_REGISTER_CUSTOM_DIMS. If the dim isn't registered, GA4 400s with
// "Field eventParameterName:nav_screen is not a valid field".
function screenViewFilter(screenName) {
  return {
    funnelEventFilter: {
      eventName: 'screen_view',
      funnelParameterFilterExpression: {
        funnelParameterFilter: {
          eventParameterName: 'nav_screen',
          stringFilter: { matchType: 'EXACT', value: screenName },
        },
      },
    },
  };
}

function stepFilter(step) {
  if (step.screenName) return screenViewFilter(step.screenName);
  return eventNameFilter(step.eventName);
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
        filterExpression: stepFilter(s),
      })),
    },
  };
  const url = `https://analyticsdata.googleapis.com/v1alpha/properties/${propertyId}:runFunnelReport`;

  // Also run the raw per-event distinct-users query in parallel, so the
  // frontend can show BOTH the sequential funnel count and the "did this
  // event ever fire, regardless of order" count. Diagnoses the common
  // situation where runFunnelReport shows 0 for step N but the event
  // is clearly firing — that means users hit the event out of order.
  const stepEventNames = [...new Set(IN_APP_FUNNEL_STEPS.map(s => s.eventName).filter(Boolean))];
  const rawEventsPromise = runReport(accessToken, propertyId, {
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
    logger.warn('analytics.funnel.raw_events_failed', { message: err.message });
    return null;
  });

  // Per-screen distinct users for the screen_view-based steps (currently
  // commented out of IN_APP_FUNNEL_STEPS — see the big comment above the
  // array for the reserved-param story). Queries `customEvent:nav_screen`,
  // which the mobile app populates alongside the reserved `screen_name` on
  // every logScreenView() call. No-ops when there are no screen-view steps,
  // which is the current prod state.
  const stepScreenNames = [...new Set(IN_APP_FUNNEL_STEPS.map(s => s.screenName).filter(Boolean))];
  const rawScreensPromise = stepScreenNames.length === 0 ? Promise.resolve(null) : runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
    dimensions: [{ name: 'customEvent:nav_screen' }],
    metrics: [{ name: 'activeUsers' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'screen_view' } } },
          { filter: { fieldName: 'customEvent:nav_screen', inListFilter: { values: stepScreenNames } } },
        ],
      },
    },
  }).catch(err => {
    // Non-fatal — most likely nav_screen not yet registered as custom dim
    // (happens on properties where mobile app hasn't shipped yet).
    logger.warn('analytics.funnel.raw_screens_failed', { message: err.message });
    return null;
  });

  const stepRawUsers = (step, byEvent, byScreen) => {
    if (step.screenName) return byScreen.get(step.screenName) ?? null;
    return byEvent.get(step.eventName) ?? null;
  };

  try {
    const [{ data: response }, rawEventsRes, rawScreensRes] = await Promise.all([
      auth.request({ url, method: 'POST', data: body }),
      rawEventsPromise,
      rawScreensPromise,
    ]);
    // funnelTable rows are one-per-step, in the same order as the steps we
    // submitted. GA4 prefixes the step name with "1. ", "2. " etc. in the
    // response, so matching by name silently returns 0 for every step. Use
    // row order — runFunnelReport guarantees it matches the request order.
    const rows = response?.funnelTable?.rows || [];
    if (rows.length !== IN_APP_FUNNEL_STEPS.length) {
      logger.warn('analytics.funnel.row_count_mismatch', {
        expected: IN_APP_FUNNEL_STEPS.length,
        got: rows.length,
      });
    }
    const rawByEvent = rawEventsRes
      ? new Map(shapeReport(rawEventsRes).rows.map(r => [r.eventName, Number(r.activeUsers || 0)]))
      : new Map();
    const rawByScreen = rawScreensRes
      ? new Map(shapeReport(rawScreensRes).rows.map(r => [r['customEvent:nav_screen'], Number(r.activeUsers || 0)]))
      : new Map();
    const funnel = IN_APP_FUNNEL_STEPS.map((s, idx) => ({
      key: s.key,
      label: s.label,
      users: Number(rows[idx]?.metricValues?.[0]?.value || 0),
      rawUsers: stepRawUsers(s, rawByEvent, rawByScreen),
      event: describeStep(s),
    }));
    return { funnel, source: 'runFunnelReport', rangeDays };
  } catch (err) {
    // v1alpha runFunnelReport can 4xx for various reasons (schema mismatch,
    // preview-API quirk, property tier, screen_name custom dim not yet
    // registered). Log + fall back to per-step distinct-user counts using
    // v1beta runReport. Fallback isn't a *true* ordered funnel — users
    // could skip a step and still be counted at a later one — but it beats
    // an empty section while the registration propagates.
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
    const [rawEventsRes, rawScreensRes] = await Promise.all([rawEventsPromise, rawScreensPromise]);
    const usersByEvent = rawEventsRes
      ? new Map(shapeReport(rawEventsRes).rows.map(r => [r.eventName, Number(r.activeUsers || 0)]))
      : new Map();
    const usersByScreen = rawScreensRes
      ? new Map(shapeReport(rawScreensRes).rows.map(r => [r['customEvent:nav_screen'], Number(r.activeUsers || 0)]))
      : new Map();
    const funnel = IN_APP_FUNNEL_STEPS.map(s => {
      const users = stepRawUsers(s, usersByEvent, usersByScreen) ?? 0;
      return { key: s.key, label: s.label, users, rawUsers: users, event: describeStep(s) };
    });
    return {
      funnel,
      source: 'v1beta_fallback',
      fallbackReason: errorMessage,
      rangeDays,
    };
  }
}

function describeStep(step) {
  if (step.screenName) return `screen_view[${step.screenName}]`;
  return step.eventName || '(unknown)';
}

// Breakdown of a given event by plan_id + billing_period. Powers the
// "which plan" sub-rows under the Selected a plan / Started purchase / Paid
// funnel steps.
//
// Depends on `plan_id` and `billing_period` being registered as event-scoped
// custom dimensions in GA4 Admin → Custom Definitions (handled automatically
// by AUTO_REGISTER_CUSTOM_DIMS on property connect). Without registration GA4
// returns 400 "Field customEvent:X is not a valid dimension" — we catch that
// so the funnel stays rendered and the frontend can show a hint.
//
// For purchase_started / purchase to produce a non-empty breakdown, the app
// must also attach `plan_id` and `billing_period` as event params when firing
// those events (plan_selected already does this). Until the app ships that
// change, these breakdowns will show "(not set)" rows.
async function getPlanBreakdownForEvent(accessToken, propertyId, days, eventName) {
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
          stringFilter: { matchType: 'EXACT', value: eventName },
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
    const message = err?.response?.data?.error?.message || err?.message || 'unknown';
    logger.warn('analytics.plan_breakdown.failed', { propertyId, eventName, message });
    return { rows: [], error: message, rangeDays };
  }
}

async function getPlanSelectedBreakdown(accessToken, propertyId, days) {
  return getPlanBreakdownForEvent(accessToken, propertyId, days, 'plan_selected');
}

async function getPurchaseStartedBreakdown(accessToken, propertyId, days) {
  return getPlanBreakdownForEvent(accessToken, propertyId, days, 'purchase_started');
}

async function getPurchaseBreakdown(accessToken, propertyId, days) {
  return getPlanBreakdownForEvent(accessToken, propertyId, days, 'purchase');
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
  const rangeDays = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  // Three fallback strategies for reading screen names — GA4 exposes them
  // via different dimensions depending on how the app fires screen_view:
  //   1. unifiedScreenName — GA4's cross-platform name (web page or app screen)
  //   2. screenName        — built-in for app streams, populated from
  //                          firebase_screen event param
  //   3. customEvent:screen_name — raw event-parameter access, only works
  //                          if `screen_name` is registered as a custom
  //                          event dimension in GA4 Admin
  // Whichever yields the most non-"(not set)" rows wins. Filter to
  // eventName=screen_view so we're actually counting screen navigation,
  // not stray events that happened to carry a screen_name param.
  const attempts = [
    { dim: 'unifiedScreenName', label: 'unifiedScreenName' },
    { dim: 'screenName',        label: 'screenName' },
    { dim: 'customEvent:screen_name', label: 'customEvent:screen_name' },
  ];
  let winner = null;
  let winnerRows = [];
  for (const attempt of attempts) {
    try {
      const response = await runReport(accessToken, propertyId, {
        dateRanges: dateRangeFromDays(days),
        dimensions: [{ name: attempt.dim }],
        metrics: [{ name: 'activeUsers' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            stringFilter: { matchType: 'EXACT', value: 'screen_view' },
          },
        },
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 200,
      });
      const shaped = shapeReport(response);
      const rows = shaped.rows.map(r => ({
        screenName: r[attempt.dim] || '(not set)',
        users: Number(r.activeUsers || 0),
      }));
      // Score: number of rows with a real (non-"(not set)") screen name.
      const named = rows.filter(r => r.screenName !== '(not set)').length;
      if (!winner || named > winnerRows.filter(r => r.screenName !== '(not set)').length) {
        winner = attempt.label;
        winnerRows = rows;
      }
      // Short-circuit if we found a good dimension with lots of named rows.
      if (named >= 5) break;
    } catch (err) {
      // Custom-event dimension can 400 if not registered — skip and try next.
      logger.debug('analytics.screen_views.dimension_failed', {
        dim: attempt.dim,
        message: err?.response?.data?.error?.message || err?.message,
      });
    }
  }
  return {
    screens: winnerRows,
    dimensionUsed: winner,
    rangeDays,
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
// ---------- Auto-registered custom dimensions ----------
//
// Event parameters Post-to needs registered on every connected GA4 property
// to render per-parameter breakdowns in the dashboard. ensurePostToCustomDimensions
// below runs this list through createCustomDimension on property connect
// (idempotent — 409 ALREADY_EXISTS returns noop:true).
//
// Keep this list minimal — only add params the UI actively uses, otherwise
// users accumulate stale custom dims on their property.
const AUTO_REGISTER_CUSTOM_DIMS = [
  {
    parameterName: 'plan_id',
    displayName: 'Plan ID',
    scope: 'EVENT',
    description: 'Which plan tier the user selected (starter/pro/business/enterprise). Powers Post-to Analytics plan breakdown under the Selected a plan funnel step.',
  },
  {
    parameterName: 'billing_period',
    displayName: 'Billing Period',
    scope: 'EVENT',
    description: 'monthly / annual / seat — the billing cadence for the selected plan. Shown alongside Plan ID in the breakdown.',
  },
  {
    parameterName: 'screen_name',
    displayName: 'Screen Name',
    scope: 'EVENT',
    description: 'App screen name - required so the Post-to in-app funnel can filter screen_view steps by screen in GA4 runFunnelReport.',
  },
  {
    parameterName: 'nav_screen',
    displayName: 'Nav Screen',
    scope: 'EVENT',
    description: 'App screen name - non-reserved alternative to screen_name (which GA4 captures into a different slot on reserved screen_view events).',
  },
];

// Idempotent batch registration — safe to call every time a property is
// connected. Never throws: a single dimension failing (scope missing,
// unexpected 4xx) is logged and skipped so the enclosing connection save
// stays fast and reliable. Returns a per-dimension status array that
// callers can log or return in a response.
async function ensurePostToCustomDimensions(accessToken, propertyId) {
  const results = [];
  for (const dim of AUTO_REGISTER_CUSTOM_DIMS) {
    try {
      const res = await createCustomDimension(accessToken, propertyId, dim);
      const status = res.noop ? 'noop' : 'created';
      logger.info('analytics.ensure_custom_dimension', {
        propertyId,
        parameterName: dim.parameterName,
        status,
      });
      results.push({ parameterName: dim.parameterName, status });
    } catch (err) {
      const httpStatus = err?.response?.status || err?.status;
      const message = err?.response?.data?.error?.message || err?.message || 'unknown';
      const status = httpStatus === 403 ? 'scope_missing' : 'failed';
      logger.warn('analytics.ensure_custom_dimension', {
        propertyId,
        parameterName: dim.parameterName,
        status,
        httpStatus,
        message,
      });
      results.push({ parameterName: dim.parameterName, status, message });
    }
  }
  return results;
}

// ---------- Custom Dimensions (Admin API) ----------
//
// GA4 event parameters (e.g. `plan_id`, `billing_period`) must be registered
// as event-scoped custom dimensions before they're queryable by name via the
// Data API — unregistered parameters just return "(not set)". These two
// functions let the Campaign Assistant automate the registration instead of
// walking the user through GA4 Admin UI.
//
// API: properties.customDimensions.{create,list} (v1beta, stable).
// Requires OAuth scope `analytics.edit` (we request it alongside readonly).

async function listCustomDimensions(accessToken, propertyId) {
  const pid = String(propertyId || '').replace(/^properties\//, '').trim();
  if (!pid) throw new Error('propertyId required');
  const auth = oauthClientFor(accessToken);
  const admin = google.analyticsadmin({ version: 'v1beta', auth });
  const dims = [];
  let pageToken;
  do {
    const { data } = await admin.properties.customDimensions.list({
      parent: `properties/${pid}`,
      pageSize: 200,
      pageToken,
    });
    for (const d of data?.customDimensions || []) {
      dims.push({
        resourceName: d.name || null,
        displayName: d.displayName || null,
        parameterName: d.parameterName || null,
        scope: d.scope || null,
        description: d.description || null,
        disallowAdsPersonalization: !!d.disallowAdsPersonalization,
      });
    }
    pageToken = data?.nextPageToken || null;
  } while (pageToken);
  return { propertyId: pid, count: dims.length, customDimensions: dims };
}

// Create one event-scoped custom dimension. If a dimension with the same
// parameterName+scope already exists Apple… — er, Google — returns 409
// ALREADY_EXISTS; we treat that as a successful no-op so the Assistant can
// re-run the step safely.
async function createCustomDimension(accessToken, propertyId, { parameterName, displayName, description, scope = 'EVENT' }) {
  const pid = String(propertyId || '').replace(/^properties\//, '').trim();
  const param = String(parameterName || '').trim();
  const name = String(displayName || '').trim();
  if (!pid) throw new Error('propertyId required');
  if (!param) throw new Error('parameterName required');
  if (!name) throw new Error('displayName required');
  const auth = oauthClientFor(accessToken);
  const admin = google.analyticsadmin({ version: 'v1beta', auth });
  try {
    const { data } = await admin.properties.customDimensions.create({
      parent: `properties/${pid}`,
      requestBody: {
        parameterName: param,
        displayName: name,
        scope,
        ...(description ? { description } : {}),
      },
    });
    return {
      noop: false,
      resourceName: data?.name || null,
      displayName: data?.displayName || name,
      parameterName: data?.parameterName || param,
      scope: data?.scope || scope,
      propertyId: pid,
    };
  } catch (err) {
    const code = err?.code || err?.response?.status;
    const msg = err?.errors?.[0]?.message || err?.message || '';
    const isAlreadyExists = code === 409
      || /already exists|ALREADY_EXISTS/i.test(msg + ' ' + JSON.stringify(err?.response?.data || {}));
    if (isAlreadyExists) {
      return {
        noop: true,
        reason: `Custom dimension for "${param}" (scope=${scope}) already exists on this property`,
        parameterName: param,
        scope,
        propertyId: pid,
      };
    }
    throw err;
  }
}

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
  getPurchaseStartedBreakdown,
  getPurchaseBreakdown,
  markConversionEvent,
  listConversionEvents,
  listCustomDimensions,
  createCustomDimension,
  ensurePostToCustomDimensions,
  normalizeApiError,
  // exposed for tests
  _internal: { runReport, shapeReport, dateRangeFromDays, HIGHLIGHTED_EVENTS },
};
