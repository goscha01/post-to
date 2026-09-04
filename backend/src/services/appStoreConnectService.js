// Apple App Store Connect API — read-only.
//
// Auth model is deliberately unlike anything else in Post-To: no OAuth, no
// refresh tokens. Apple gives you a permanent private key (.p8) + issuer_id
// + key_id triple, and you mint an ES256 JWT (20-minute max TTL) per
// request. The JWT is stateless — we sign one fresh each call rather than
// caching, because Apple invalidates keys we can't detect and the cost of
// signing is negligible (~1ms).
//
// Data lag: reviews are ~real-time. Sales reports are the previous
// UTC-calendar day's data, delivered ~09:00 UTC next morning. App Analytics
// (impressions, product-page views, install conversion rate, sources) is
// an ASYNC report flow and is intentionally NOT in this Phase 1 file —
// that goes in a later phase with a nightly cron + DB cache.
//
// Everything is read. No mutate. If you find yourself adding a POST/PATCH
// against /v1/apps/*/beta* or similar, stop — this file is diagnostics,
// mutations live in TestFlight / ASC UI where reviewers see them.

const axios = require('axios');
const jwt = require('jsonwebtoken');
const zlib = require('zlib');
const { promisify } = require('util');
const logger = require('../utils/logger');

const gunzip = promisify(zlib.gunzip);

const BASE_URL = 'https://api.appstoreconnect.apple.com';
const AUD = 'appstoreconnect-v1';
const TOKEN_TTL_SECONDS = 20 * 60;  // Apple max; below that gives no meaningful safety, above throws.

// Mint a fresh ES256 JWT. Apple rejects >20min TTL with 401. We use the
// full 20min so a single sign covers the full request retry window.
function signJwt({ issuerId, keyId, p8 }) {
  if (!issuerId || !keyId || !p8) {
    throw new Error('signJwt requires issuerId, keyId, and p8');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: issuerId,
      iat: nowSec,
      exp: nowSec + TOKEN_TTL_SECONDS,
      aud: AUD,
    },
    p8,
    {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: keyId, typ: 'JWT' },
    }
  );
}

// One thin GET helper — every read endpoint follows the same shape. Uses
// validateStatus: () => true so we can surface Apple's structured error
// bodies (e.g. { errors: [{ status:"401", title, detail }] }) instead of
// axios's opaque "status code 401".
async function apiGet(creds, path, { params, responseType = 'json' } = {}) {
  const token = signJwt(creds);
  const resp = await axios.get(`${BASE_URL}${path}`, {
    params,
    headers: { Authorization: `Bearer ${token}` },
    responseType,
    validateStatus: () => true,
    timeout: 30_000,
  });
  if (resp.status >= 400) {
    const detail = summarizeAppleError(resp);
    const err = new Error(`ASC ${resp.status}: ${detail}`);
    err.status = resp.status;
    err.appleErrors = resp.data?.errors || null;
    throw err;
  }
  return resp;
}

function summarizeAppleError(resp) {
  // For arraybuffer responses (sales reports), resp.data is a Buffer — we
  // have to decode it to UTF-8 and re-parse the JSON before we can walk
  // errors[]. Without this coercion, the log line was "{\"type\":\"Buffer\",
  // \"data\":[...]}" which hides Apple's actual complaint.
  let data = resp.data;
  if (Buffer.isBuffer(data) || data instanceof Uint8Array || (data && data.type === 'Buffer' && Array.isArray(data.data))) {
    try {
      const text = Buffer.isBuffer(data) || data instanceof Uint8Array
        ? Buffer.from(data).toString('utf8')
        : Buffer.from(data.data).toString('utf8');
      try { data = JSON.parse(text); }
      catch { return text.slice(0, 400); }
    } catch { /* fall through */ }
  }
  const errors = data?.errors;
  if (Array.isArray(errors) && errors.length) {
    const e = errors[0];
    const summary = [e.title, e.detail, e.code ? `(code: ${e.code})` : null]
      .filter(Boolean).join(' — ');
    return summary || 'unknown error';
  }
  if (typeof data === 'string') return data.slice(0, 400);
  try { return JSON.stringify(data).slice(0, 400); }
  catch { return '(no body)'; }
}

// -----------------------------------------------------------------------
// Apps discovery — the "does this key work?" probe.
// -----------------------------------------------------------------------
// Returns the union of every app the API key can see. Also functions as
// our connect-time credential validation: if listApps() succeeds, the
// triple (p8, issuerId, keyId) is valid and has at minimum read access.
async function listApps(creds) {
  const resp = await apiGet(creds, '/v1/apps', {
    params: { limit: 200, 'fields[apps]': 'name,bundleId,sku,primaryLocale' },
  });
  const data = resp.data?.data || [];
  return data.map(row => ({
    id: row.id,
    name: row.attributes?.name || null,
    bundleId: row.attributes?.bundleId || null,
    sku: row.attributes?.sku || null,
    primaryLocale: row.attributes?.primaryLocale || null,
  }));
}

// -----------------------------------------------------------------------
// Customer reviews — synchronous, current data.
// -----------------------------------------------------------------------
// Apple returns reviews across every territory. We surface them raw; the
// caller (route or UI) can filter/aggregate. Sort=-createdDate = newest
// first, which is what a diagnostic UI wants.
async function getReviews(creds, { appId, limit = 50, territory = null } = {}) {
  if (!appId) throw new Error('appId required');
  const params = {
    limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
    sort: '-createdDate',
    'fields[customerReviews]': 'rating,title,body,reviewerNickname,createdDate,territory',
  };
  if (territory) params['filter[territory]'] = String(territory).toUpperCase().slice(0, 3);
  const resp = await apiGet(creds, `/v1/apps/${appId}/customerReviews`, { params });
  const rows = resp.data?.data || [];
  return rows.map(r => ({
    id: r.id,
    rating: r.attributes?.rating || null,
    title: r.attributes?.title || null,
    body: r.attributes?.body || null,
    reviewerNickname: r.attributes?.reviewerNickname || null,
    createdDate: r.attributes?.createdDate || null,
    territory: r.attributes?.territory || null,
  }));
}

// -----------------------------------------------------------------------
// Sales & Trends — one call per date, gzipped TSV response.
// -----------------------------------------------------------------------
// Apple charges no rate cost for these calls and each returns a full day's
// unit-level data. The response is a gzipped tab-separated blob (Apple's
// header: application/a-gzip); we gunzip and parse into row objects.
//
// vendorNumber is a numeric account ID separate from issuerId — find it at
// ASC → Payments & Financial Reports → Payments and Financial Reports (top
// left dropdown). Usually 8 digits starting with 8.
//
// For a date with no sales, Apple returns 404 with error code REPORT_MISSING.
// That's normal (weekend of a small app, or "yesterday hasn't been generated
// yet"); we swallow it and return null so the caller can distinguish "no data"
// from "auth error".
async function getSalesReport(creds, { vendorNumber, reportDate }) {
  if (!vendorNumber) throw new Error('vendorNumber required');
  if (!reportDate || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new Error('reportDate must be YYYY-MM-DD');
  }
  const params = {
    'filter[frequency]': 'DAILY',
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': String(vendorNumber),
    'filter[reportDate]': reportDate,
    'filter[version]': '1_1',
  };
  let resp;
  try {
    resp = await apiGet(creds, '/v1/salesReports', { params, responseType: 'arraybuffer' });
  } catch (err) {
    // Apple returns REPORT_MISSING when the requested day hasn't been
    // generated yet OR when there were literally zero sales. Treat as "no
    // data available for this date" rather than error.
    if (err.status === 404) return null;
    throw err;
  }
  const gz = Buffer.from(resp.data);
  const tsv = (await gunzip(gz)).toString('utf8');
  return parseSalesTsv(tsv, reportDate);
}

// Parse Apple's sales TSV. First row is header names; subsequent rows are
// records. We map only the fields the UI/tools care about; unknown fields
// are ignored so a future schema addition doesn't break us.
function parseSalesTsv(tsv, reportDate) {
  const lines = tsv.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return { reportDate, rows: [], totals: { units: 0 } };
  const header = lines[0].split('\t');
  const idx = name => header.indexOf(name);
  const iSku = idx('SKU');
  const iUnits = idx('Units');
  const iCountry = idx('Country Code');
  const iType = idx('Product Type Identifier');
  const iAppleId = idx('Apple Identifier');
  const iTitle = idx('Title');
  const iVersion = idx('Version');

  let totalUnits = 0;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const units = parseInt(cols[iUnits], 10) || 0;
    totalUnits += units;
    rows.push({
      sku: iSku >= 0 ? cols[iSku] : null,
      title: iTitle >= 0 ? cols[iTitle] : null,
      appleId: iAppleId >= 0 ? cols[iAppleId] : null,
      productType: iType >= 0 ? cols[iType] : null,   // 1 = free app, 1F = universal free, 7 = update, IA1 = in-app purchase, etc.
      country: iCountry >= 0 ? cols[iCountry] : null,
      units,
      version: iVersion >= 0 ? cols[iVersion] : null,
    });
  }
  return { reportDate, rows, totals: { units: totalUnits } };
}

// -----------------------------------------------------------------------
// Aggregate helper — a range of daily sales reports for the UI dashboard.
// -----------------------------------------------------------------------
// Walks yesterday-N to yesterday and fetches each. Yesterday-not-yet-generated
// dates return null and are dropped. Runs sequentially — Apple has generous
// rate limits but concurrent calls with the same JWT sometimes hit anti-abuse
// throttling, and this endpoint is called from a user-triggered dashboard,
// not a hot path.
async function getSalesReportRange(creds, { vendorNumber, days = 7 }) {
  const daysClamped = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const results = [];
  for (let i = 0; i < daysClamped; i++) {
    const d = new Date(yesterday);
    d.setUTCDate(d.getUTCDate() - i);
    const reportDate = d.toISOString().slice(0, 10);
    const report = await getSalesReport(creds, { vendorNumber, reportDate }).catch(err => {
      logger.warn('asc.sales_report_failed', {
        reportDate, error: err.message, status: err.status || null,
      });
      return null;
    });
    if (report) results.push(report);
  }
  // Return newest-first so the UI can render "yesterday" at the top.
  return results;
}

// -----------------------------------------------------------------------
// App Analytics Reports API (async, 3-step)
// -----------------------------------------------------------------------
// Unlike Sales & Trends (single sync gzipped TSV), the rich App Analytics
// data (impressions, product page views, install sources, retention) lives
// behind Apple's Analytics Reports API. Flow:
//
//   1. createOngoingReportRequest(appId) — one-time per app. Apple starts
//      generating daily reports from that moment forward. Returns a request
//      id we persist to connected_accounts.metadata.analytics_report_request_id.
//   2. listReportsInRequest(requestId, [categories]) — list of report ids by
//      category (APP_STORE_ENGAGEMENT, APP_STORE_COMMERCE, APP_USAGE,
//      FRAMEWORK_USAGE). Reports themselves don't have data — they're
//      report "channels."
//   3. listInstancesForReport(reportId, {granularity, since}) — one instance
//      per (granularity × processingDate). This is where "yesterday's data"
//      shows up.
//   4. listSegmentsInInstance(instanceId) — S3-signed URLs to download.
//   5. downloadSegment(url) — HTTPS GET (NO JWT — the URL is pre-signed).
//      Returns gzipped CSV. gunzip + parseCsv gives us rows.
//
// The cron worker (workers/ascAnalyticsScheduler) walks all this every hour
// and stores rows in asc_analytics_cache. Tools + dashboards read from the
// cache, never from this API directly.
//
// Timing: Apple's SLA for a new ONGOING request is ~24h before the first
// daily instance appears. After that, each day's instance shows up ~09:00
// UTC the following day.

async function createOngoingReportRequest(creds, { appId }) {
  if (!appId) throw new Error('appId required');
  const token = signJwt(creds);
  const resp = await axios.post(
    `${BASE_URL}/v1/analyticsReportRequests`,
    {
      data: {
        type: 'analyticsReportRequests',
        attributes: { accessType: 'ONGOING' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
      timeout: 30_000,
    }
  );
  if (resp.status >= 400) {
    const detail = summarizeAppleError(resp);
    const err = new Error(`ASC ${resp.status}: ${detail}`);
    err.status = resp.status;
    err.appleErrors = resp.data?.errors || null;
    // 409 Conflict is Apple's response when an ONGOING request already exists
    // for this (team, app, accessType). Treat as recoverable — the caller
    // should look up the existing request id via listOngoingReportRequests.
    err.isConflict = resp.status === 409;
    throw err;
  }
  return {
    id: resp.data?.data?.id,
    stoppedDueToInactivity: resp.data?.data?.attributes?.stoppedDueToInactivity || false,
  };
}

// If Apple 409'd on createOngoingReportRequest, use this to find the existing
// request for the same app. Filter by app id via /v1/apps/{id}/analyticsReportRequests.
async function findOngoingReportRequestForApp(creds, { appId }) {
  if (!appId) throw new Error('appId required');
  const resp = await apiGet(creds, `/v1/apps/${appId}/analyticsReportRequests`, {
    params: {
      'filter[accessType]': 'ONGOING',
      limit: 5,
    },
  });
  const rows = resp.data?.data || [];
  // Prefer the most recent non-stopped one.
  const active = rows.find(r => !r.attributes?.stoppedDueToInactivity);
  const chosen = active || rows[0] || null;
  if (!chosen) return null;
  return {
    id: chosen.id,
    stoppedDueToInactivity: chosen.attributes?.stoppedDueToInactivity || false,
  };
}

async function listReportsInRequest(creds, requestId, { categories } = {}) {
  if (!requestId) throw new Error('requestId required');
  const params = { limit: 200 };
  if (Array.isArray(categories) && categories.length) {
    params['filter[category]'] = categories.join(',');
  }
  const resp = await apiGet(creds, `/v1/analyticsReportRequests/${requestId}/reports`, { params });
  return (resp.data?.data || []).map(r => ({
    id: r.id,
    name: r.attributes?.name || null,
    category: r.attributes?.category || null,
  }));
}

async function listInstancesForReport(creds, reportId, { granularity = 'DAILY', processingDateFrom, limit = 200 } = {}) {
  if (!reportId) throw new Error('reportId required');
  const params = {
    'filter[granularity]': granularity,
    limit,
  };
  // Apple accepts filter[processingDate]=YYYY-MM-DD for exact date, no >= filter
  // in current API version — we fetch all recent instances and filter caller-side.
  if (processingDateFrom && /^\d{4}-\d{2}-\d{2}$/.test(processingDateFrom)) {
    params['filter[processingDate]'] = processingDateFrom;
  }
  const resp = await apiGet(creds, `/v1/analyticsReports/${reportId}/instances`, { params });
  return (resp.data?.data || []).map(r => ({
    id: r.id,
    processingDate: r.attributes?.processingDate || null,
    granularity: r.attributes?.granularity || null,
  }));
}

async function listSegmentsInInstance(creds, instanceId) {
  if (!instanceId) throw new Error('instanceId required');
  const resp = await apiGet(creds, `/v1/analyticsReportInstances/${instanceId}/segments`, {
    params: { limit: 50 },
  });
  return (resp.data?.data || []).map(s => ({
    url: s.attributes?.url || null,
    sizeInBytes: s.attributes?.sizeInBytes || 0,
    checksum: s.attributes?.checksum || null,
  }));
}

// Download and gunzip a single segment. Segment URLs are Apple-signed S3
// links — no JWT header needed (and adding one would break the signed
// request). Returns parsed rows.
async function downloadSegment(segment) {
  if (!segment?.url) throw new Error('segment.url required');
  const resp = await axios.get(segment.url, {
    responseType: 'arraybuffer',
    validateStatus: () => true,
    timeout: 60_000,
  });
  if (resp.status >= 400) {
    throw Object.assign(
      new Error(`Segment download ${resp.status}`),
      { status: resp.status }
    );
  }
  const gz = Buffer.from(resp.data);
  const csv = (await gunzip(gz)).toString('utf8');
  return parseAnalyticsCsv(csv);
}

// Apple's analytics CSVs are actually TAB-separated (despite the naming) —
// same format as sales reports. First row is header, subsequent rows are
// data. Rows can contain empty values; we preserve them as empty strings.
// Numeric coercion is left to the caller (per-report aggregation logic in
// ascAnalyticsService knows which columns are metrics vs dimensions).
function parseAnalyticsCsv(csvOrTsv) {
  const lines = csvOrTsv.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split('\t');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = cols[j] ?? '';
    }
    rows.push(obj);
  }
  return rows;
}

module.exports = {
  signJwt,
  listApps,
  getReviews,
  getSalesReport,
  getSalesReportRange,
  createOngoingReportRequest,
  findOngoingReportRequestForApp,
  listReportsInRequest,
  listInstancesForReport,
  listSegmentsInInstance,
  downloadSegment,
  _internal: { parseSalesTsv, parseAnalyticsCsv, summarizeAppleError, BASE_URL },
};
