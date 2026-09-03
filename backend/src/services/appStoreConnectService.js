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
  const errors = resp.data?.errors;
  if (Array.isArray(errors) && errors.length) {
    const e = errors[0];
    return [e.title, e.detail].filter(Boolean).join(' — ') || 'unknown error';
  }
  if (typeof resp.data === 'string') return resp.data.slice(0, 400);
  try { return JSON.stringify(resp.data).slice(0, 400); }
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

module.exports = {
  signJwt,
  listApps,
  getReviews,
  getSalesReport,
  getSalesReportRange,
  _internal: { parseSalesTsv, summarizeAppleError, BASE_URL },
};
