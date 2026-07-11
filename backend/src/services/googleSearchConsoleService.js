// Google Search Console (Webmasters v3) read-only service.
//
// Two API surfaces are used:
//   - sites.list                → list every site the token has access to
//   - searchanalytics.query     → top queries / pages / dates for a site
//
// Auth model mirrors analyticsService: reuses the OAuth refresh token stored
// on users.business_profiles (webmasters.readonly is in BUSINESS_SCOPES so a
// single Google consent covers GMB + GA4 + Ads + GSC). Callers pass a live
// access token; businessTokens handles refresh.

const { google } = require('googleapis');

function oauthClientFor(accessToken) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials({ access_token: accessToken });
  return client;
}

// List every GSC site the authed Google account can read. Each site has a
// `siteUrl` like "https://example.com/" or "sc-domain:example.com" and a
// permissionLevel (siteFullUser / siteOwner / siteRestrictedUser / siteUnverifiedUser).
async function listSites(accessToken) {
  const auth = oauthClientFor(accessToken);
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const { data } = await searchconsole.sites.list();
  return (data.siteEntry || []).map(s => ({
    siteUrl: s.siteUrl,
    permissionLevel: s.permissionLevel || null,
  }));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function dateRangeFromDays(days) {
  const n = Math.max(1, Math.min(365, parseInt(days, 10) || 7));
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - n);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

// Query top queries for a site over the last N days.
//   dimensions defaults to ['query']; pass ['page'] or ['query','page'] for
//   variations. rowLimit is clamped to [1, 250].
async function topQueries(accessToken, siteUrl, { days = 7, limit = 25, dimensions = ['query'] } = {}) {
  const auth = oauthClientFor(accessToken);
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const { startDate, endDate } = dateRangeFromDays(days);
  const rowLimit = Math.max(1, Math.min(250, parseInt(limit, 10) || 25));

  const { data } = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions,
      rowLimit,
    },
  });

  const rows = (data.rows || []).map(r => {
    const out = {};
    (dimensions || []).forEach((dim, i) => { out[dim] = r.keys?.[i] ?? null; });
    out.clicks = r.clicks ?? 0;
    out.impressions = r.impressions ?? 0;
    out.ctr = r.ctr ?? 0;
    out.position = r.position ?? null;
    return out;
  });

  // Sort by clicks desc so "top" is meaningful even if Google returned
  // by position or another default order.
  rows.sort((a, b) => (b.clicks || 0) - (a.clicks || 0) || (b.impressions || 0) - (a.impressions || 0));

  return {
    siteUrl,
    startDate,
    endDate,
    dimensions,
    rows,
  };
}

// Normalize Google's error shape into something we can serve back to the
// frontend + log usefully. Mirrors analyticsService.normalizeApiError.
function normalizeApiError(err, ctx = {}) {
  const status = err?.response?.status || err?.code || 500;
  const message =
    err?.response?.data?.error?.message ||
    err?.errors?.[0]?.message ||
    err?.message ||
    'Google Search Console API error';
  return { status: typeof status === 'number' ? status : 500, message, ctx };
}

module.exports = {
  listSites,
  topQueries,
  normalizeApiError,
};
