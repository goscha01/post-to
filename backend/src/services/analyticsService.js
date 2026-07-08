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

async function getOverview(accessToken, propertyId, days) {
  const response = await runReport(accessToken, propertyId, {
    dateRanges: dateRangeFromDays(days),
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
  });
  const shaped = shapeReport(response);
  const totals = (shaped.rows[0] || {});
  // NOTE: When there are no dimensions GA4 returns a single row with all metrics.
  // Handle the empty-property case by defaulting each field to 0.
  return {
    users: Number(totals.activeUsers || 0),
    newUsers: Number(totals.newUsers || 0),
    sessions: Number(totals.sessions || 0),
    engagedSessions: Number(totals.engagedSessions || 0),
    averageSessionDuration: Number(totals.averageSessionDuration || 0),
    averageEngagementTime: Number(totals.userEngagementDuration || 0),
    engagementRate: Number(totals.engagementRate || 0),
    conversions: Number(totals.conversions || 0),
    totalRevenue: Number(totals.totalRevenue || 0),
    pageViews: Number(totals.screenPageViews || 0),
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
function normalizeApiError(err, context) {
  const status =
    err?.response?.status ||
    err?.code ||
    err?.status ||
    null;
  const message = err?.response?.data?.error?.message || err?.message || 'analytics_api_error';
  logger.error('analytics.api_error', {
    ...(context || {}),
    status,
    message,
  });
  const out = new Error(message);
  out.status = typeof status === 'number' ? status : 500;
  return out;
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
  normalizeApiError,
  // exposed for tests
  _internal: { runReport, shapeReport, dateRangeFromDays, HIGHLIGHTED_EVENTS },
};
