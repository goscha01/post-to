// OpenAI Ads (ads.openai.com) — thin read-only client for api.ads.openai.com/v1.
//
// Auth: Bearer <OPENAI_ADS_API_KEY>. Keys are scoped to a single ad account so
// there's no adaccount_id query param — the account is implicit in the key.
//
// API key resolution order:
//   1. `connectionId` (uuid of a connected_accounts row where provider='openai_ads')
//      → fetched via connectionsService.getRawForUser (which does NOT strip
//      api_key from metadata).
//   2. Fallback to process.env.OPENAI_ADS_API_KEY — dev shortcut for the
//      single-account case (before the user has clicked through the UI).
//
// Every "list" endpoint auto-paginates via has_more/last_id up to a safety
// cap to keep memory bounded.

const axios = require('axios');
const logger = require('../utils/logger');
const connectionsService = require('./connectionsService');

const API_BASE = process.env.OPENAI_ADS_API_BASE || 'https://api.ads.openai.com/v1';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_PAGES = 20;              // safety: 20 pages * 200 = 4000 rows max
const DEFAULT_PAGE_LIMIT = 200;

async function resolveApiKey({ userId, connectionId }) {
  if (connectionId) {
    const row = await connectionsService.getRawForUser(userId, connectionId);
    if (!row) throw makeError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
    if (row.provider !== 'openai_ads') {
      throw makeError(400, 'WRONG_PROVIDER', 'Connection is not an OpenAI Ads connection');
    }
    const key = row.metadata?.api_key;
    if (!key) throw makeError(400, 'API_KEY_MISSING', 'Stored connection has no api_key');
    return { apiKey: key, adAccountId: row.metadata?.ad_account_id || null, connection: row };
  }
  const envKey = process.env.OPENAI_ADS_API_KEY;
  if (envKey) return { apiKey: envKey, adAccountId: null, connection: null };
  throw makeError(400, 'API_KEY_MISSING', 'No OpenAI Ads connection selected and OPENAI_ADS_API_KEY env is not set');
}

function makeError(status, code, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (extra) err.extra = extra;
  return err;
}

function normalizeApiError(err) {
  if (err && err.status && err.code) return err; // already ours
  const status = err?.response?.status;
  const body = err?.response?.data;
  const upstreamMessage =
    body?.error?.message ||
    (typeof body?.error === 'string' ? body.error : null) ||
    body?.message ||
    err?.message ||
    'OpenAI Ads API request failed';
  const code =
    status === 401 ? 'UNAUTHORIZED' :
    status === 403 ? 'FORBIDDEN' :
    status === 404 ? 'NOT_FOUND' :
    status === 429 ? 'RATE_LIMITED' :
    'UPSTREAM_ERROR';
  return makeError(status || 500, code, upstreamMessage, { upstream: body });
}

function client(apiKey) {
  return axios.create({
    baseURL: API_BASE,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    validateStatus: s => s >= 200 && s < 300,
  });
}

async function fetchListAllPages(apiKey, path, extraParams = {}) {
  const http = client(apiKey);
  const all = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = { limit: DEFAULT_PAGE_LIMIT, ...extraParams };
    if (after) params.after = after;
    let res;
    try {
      res = await http.get(path, { params });
    } catch (err) {
      throw normalizeApiError(err);
    }
    const body = res.data || {};
    const rows = Array.isArray(body.data) ? body.data : [];
    all.push(...rows);
    if (!body.has_more || !body.last_id) break;
    after = body.last_id;
  }
  return all;
}

async function getCampaigns({ userId, connectionId }) {
  const { apiKey } = await resolveApiKey({ userId, connectionId });
  return fetchListAllPages(apiKey, '/campaigns');
}

async function getAdGroups({ userId, connectionId }) {
  const { apiKey } = await resolveApiKey({ userId, connectionId });
  return fetchListAllPages(apiKey, '/ad_groups');
}

async function getAds({ userId, connectionId }) {
  const { apiKey } = await resolveApiKey({ userId, connectionId });
  return fetchListAllPages(apiKey, '/ads');
}

// Build a time_ranges JSON payload for the insights API: a single date range
// covering the last `days` days (inclusive of today). Insights expect a JSON
// array serialized to a string in the query param.
function buildDateRangeParam(days) {
  const end = new Date();
  const start = new Date(end.getTime() - (Math.max(1, days) - 1) * 86400000);
  const fmt = d => d.toISOString().slice(0, 10);
  return JSON.stringify([{ date_range: { start: fmt(start), end: fmt(end) } }]);
}

async function getInsights({ userId, connectionId, scope = 'account', days = 30, granularity = 'daily', aggregationLevel = null, id = null }) {
  const { apiKey } = await resolveApiKey({ userId, connectionId });
  const params = {
    time_granularity: granularity,
    time_ranges: buildDateRangeParam(days),
  };
  if (aggregationLevel) params.aggregation_level = aggregationLevel;

  let path;
  switch (scope) {
    case 'account':
      path = '/ad_account/insights';
      break;
    case 'campaign':
      if (!id) throw makeError(400, 'ID_REQUIRED', 'campaign id required for scope=campaign');
      path = `/campaigns/${encodeURIComponent(id)}/insights`;
      break;
    case 'ad_group':
      if (!id) throw makeError(400, 'ID_REQUIRED', 'ad_group id required for scope=ad_group');
      path = `/ad_groups/${encodeURIComponent(id)}/insights`;
      break;
    case 'ad':
      if (!id) throw makeError(400, 'ID_REQUIRED', 'ad id required for scope=ad');
      path = `/ads/${encodeURIComponent(id)}/insights`;
      break;
    default:
      throw makeError(400, 'BAD_SCOPE', `Unknown scope: ${scope}`);
  }
  return fetchListAllPages(apiKey, path, params);
}

// Quick self-test: does the current api key authenticate against the API?
// Used by /diagnose to distinguish "no key" vs "key rejected".
async function diagnose({ userId, connectionId }) {
  const out = { hasKey: false, keyOk: null, adAccountId: null, error: null };
  try {
    const { apiKey, adAccountId } = await resolveApiKey({ userId, connectionId });
    out.hasKey = true;
    out.adAccountId = adAccountId;
    // Cheapest call: list campaigns with limit=1
    try {
      const res = await client(apiKey).get('/campaigns', { params: { limit: 1 } });
      out.keyOk = true;
      out.sampleObject = res.data?.object || null;
    } catch (err) {
      const e = normalizeApiError(err);
      out.keyOk = false;
      out.error = { status: e.status, code: e.code, message: e.message };
    }
  } catch (err) {
    out.error = { status: err.status || 500, code: err.code || 'UNKNOWN', message: err.message };
  }
  return out;
}

module.exports = {
  getCampaigns,
  getAdGroups,
  getAds,
  getInsights,
  diagnose,
  normalizeApiError,
  _internal: { resolveApiKey, buildDateRangeParam, fetchListAllPages },
};
