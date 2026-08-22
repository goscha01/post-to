// Publishing Platform connect flows.
//
// One `connect<Provider>` per platform. Each verifies the supplied creds
// against the provider's own API (so users see immediate feedback instead of
// discovering their token was bad at first publish), then upserts a row into
// `connected_accounts`.
//
// Storage convention matches the existing openAiAdsService pattern: secrets
// live in `metadata.<field>` and are stripped by SENSITIVE_METADATA_KEYS in
// connectionsService before returning to the client. Server-side callers that
// need to actually publish should use connectionsService.getRawForUser.
//
// Verification is best-effort with a hard timeout. A verify failure is
// surfaced as a 4xx so the UI can show the right guidance ("wrong token",
// "wrong permission", "not a WP site").
//
// Not included yet: WordPress full connect (requires the plugin — Phase 2),
// Shopify (needs a registered app), Squarespace (needs a headless browser
// worker), Lovable (rides Webhook backend), Hosted Blog (needs subdomain
// routing).

const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const TABLE = 'connected_accounts';
const VERIFY_TIMEOUT_MS = 10000;

function makeError(status, code, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (extra) err.extra = extra;
  return err;
}

// Normalize a URL the way the website-connect flow does: default to https,
// strip trailing slash, drop hash. Returns null when the input can't be
// parsed as a URL.
function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch { return null; }
}

// Sensitive fields per provider — mirrored into connectionsService's
// SENSITIVE_METADATA_KEYS array so list/get responses strip them. Kept here
// too so tests and this file stay self-documenting.
const SENSITIVE_FIELDS = {
  webflow: ['api_token'],
  wix: ['api_key'],
  bigcommerce: ['access_token', 'webdav_pass'],
  hubspot: ['access_token'],
  gohighlevel: ['pit_token'],
  duda: ['api_pass'],
  webhook: ['bearer_token'],
  rss: ['feed_token'],
};

function stripSensitive(row, keys) {
  if (!row || !row.metadata) return row;
  const meta = { ...row.metadata };
  for (const k of keys) delete meta[k];
  return { ...row, metadata: meta };
}

// Upsert helper — dedupe by (user_id, provider, external_id). Same pattern
// as connectionsService.upsertOpenAiAds.
async function upsert({ userId, provider, externalId, displayName, metadata }) {
  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ display_name: displayName, metadata, status: 'active' })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      provider,
      display_name: displayName,
      external_id: externalId,
      metadata,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// -----------------------------------------------------------------
// Webflow — Bearer token, /v2/sites lists the sites the token can see.
// -----------------------------------------------------------------
async function connectWebflow({ userId, apiToken }) {
  const token = (apiToken || '').trim();
  if (!token) throw makeError(400, 'INVALID', 'Webflow API token required');
  let sites;
  try {
    const res = await axios.get('https://api.webflow.com/v2/sites', {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${token}`, 'accept-version': '2.0.0' },
    });
    sites = res.data?.sites || [];
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 ? 401 : 502,
      'VERIFY_FAILED',
      status === 401 ? 'Invalid Webflow API token' : `Webflow verification failed: ${err.message}`
    );
  }
  if (sites.length === 0) throw makeError(400, 'NO_SITES', 'Token has no accessible Webflow sites');
  const first = sites[0];
  const row = await upsert({
    userId,
    provider: 'webflow',
    externalId: `webflow:${first.id}`,
    displayName: first.displayName || first.shortName || `Webflow ${first.id.slice(0, 8)}`,
    metadata: {
      site_id: first.id,
      site_name: first.displayName || null,
      short_name: first.shortName || null,
      api_token: token,
      site_count: sites.length,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.webflow);
}

// -----------------------------------------------------------------
// Wix — API key header, site-scoped via wix-site-id header.
// -----------------------------------------------------------------
async function connectWix({ userId, siteId, apiKey }) {
  const sid = (siteId || '').trim();
  const key = (apiKey || '').trim();
  if (!sid) throw makeError(400, 'INVALID', 'Wix Site ID required');
  if (!key) throw makeError(400, 'INVALID', 'Wix API key required');
  try {
    await axios.get('https://www.wixapis.com/blog/v3/categories?paging.limit=1', {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: key, 'wix-site-id': sid },
    });
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 || status === 403 ? status : 502,
      'VERIFY_FAILED',
      status === 401 || status === 403
        ? 'Invalid Wix API key or missing Wix Blog permission'
        : `Wix verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'wix',
    externalId: `wix:${sid}`,
    displayName: `Wix Site ${sid.slice(0, 8)}`,
    metadata: {
      site_id: sid,
      api_key: key,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.wix);
}

// -----------------------------------------------------------------
// BigCommerce — X-Auth-Token, store-scoped by hash in the URL. Optional
// WebDAV creds for image uploads.
// -----------------------------------------------------------------
async function connectBigCommerce({ userId, storeHash, accessToken, webdavUrl, webdavUser, webdavPass, authorName }) {
  const hash = (storeHash || '').trim();
  const tok = (accessToken || '').trim();
  if (!hash) throw makeError(400, 'INVALID', 'Store hash required');
  if (!tok) throw makeError(400, 'INVALID', 'Access token required');
  try {
    await axios.get(
      `https://api.bigcommerce.com/stores/${encodeURIComponent(hash)}/v3/content/blog/posts?limit=1`,
      { timeout: VERIFY_TIMEOUT_MS, headers: { 'X-Auth-Token': tok, Accept: 'application/json' } }
    );
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 || status === 403 || status === 404 ? status : 502,
      'VERIFY_FAILED',
      status === 401 ? 'Invalid BigCommerce access token'
        : status === 403 ? 'Access token missing Content modify permission'
        : status === 404 ? 'Store hash not found'
        : `BigCommerce verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'bigcommerce',
    externalId: `bigcommerce:${hash}`,
    displayName: `BigCommerce ${hash}`,
    metadata: {
      store_hash: hash,
      access_token: tok,
      webdav_url: webdavUrl?.trim() || null,
      webdav_user: webdavUser?.trim() || null,
      webdav_pass: webdavPass?.trim() || null,
      author_name: authorName?.trim() || null,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.bigcommerce);
}

// -----------------------------------------------------------------
// HubSpot — Bearer PAT. Portal ID discovery via /account-info/v3/details.
// -----------------------------------------------------------------
async function connectHubSpot({ userId, accessToken }) {
  const tok = (accessToken || '').trim();
  if (!tok) throw makeError(400, 'INVALID', 'HubSpot access token required');
  let portalId;
  try {
    const res = await axios.get('https://api.hubapi.com/account-info/v3/details', {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${tok}` },
    });
    portalId = res.data?.portalId;
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 ? 401 : 502,
      'VERIFY_FAILED',
      status === 401 ? 'Invalid HubSpot access token'
        : `HubSpot verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'hubspot',
    externalId: `hubspot:${portalId || 'unknown'}`,
    displayName: portalId ? `HubSpot Portal ${portalId}` : 'HubSpot',
    metadata: {
      access_token: tok,
      portal_id: portalId || null,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.hubspot);
}

// -----------------------------------------------------------------
// GoHighLevel — Bearer Private Integration Token + Location ID. LC's docs
// require a Version: 2021-07-28 header.
// -----------------------------------------------------------------
async function connectGoHighLevel({ userId, token, locationId }) {
  const tok = (token || '').trim();
  const loc = (locationId || '').trim();
  if (!tok) throw makeError(400, 'INVALID', 'Private Integration Token required');
  if (!loc) throw makeError(400, 'INVALID', 'Location ID required');
  try {
    await axios.get(`https://services.leadconnectorhq.com/blogs/site?locationId=${encodeURIComponent(loc)}`, {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28', Accept: 'application/json' },
    });
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 || status === 403 ? status : 502,
      'VERIFY_FAILED',
      status === 401 || status === 403
        ? 'Invalid GoHighLevel token or wrong Location ID'
        : `GoHighLevel verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'gohighlevel',
    externalId: `ghl:${loc}`,
    displayName: `GoHighLevel ${loc}`,
    metadata: {
      pit_token: tok,
      location_id: loc,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.gohighlevel);
}

// -----------------------------------------------------------------
// Duda — HTTP Basic Auth (API user + pass). Requires Agency plan.
// -----------------------------------------------------------------
async function connectDuda({ userId, siteName, apiUser, apiPass }) {
  const site = (siteName || '').trim();
  const user = (apiUser || '').trim();
  const pass = (apiPass || '').trim();
  if (!site) throw makeError(400, 'INVALID', 'Site name required');
  if (!user) throw makeError(400, 'INVALID', 'API username required');
  if (!pass) throw makeError(400, 'INVALID', 'API password required');
  const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  let siteInfo = {};
  try {
    const res = await axios.get(`https://api.duda.co/api/sites/multiscreen/${encodeURIComponent(site)}`, {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    siteInfo = res.data || {};
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 || status === 403 || status === 404 ? status : 502,
      'VERIFY_FAILED',
      status === 401 || status === 403
        ? 'Invalid Duda API credentials'
        : status === 404 ? 'Duda site not found — check the site name'
        : `Duda verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'duda',
    externalId: `duda:${site}`,
    displayName: siteInfo.site_domain || siteInfo.default_domain || `Duda ${site.slice(0, 8)}`,
    metadata: {
      site_name: site,
      api_user: user,
      api_pass: pass,
      site_domain: siteInfo.site_domain || null,
      default_domain: siteInfo.default_domain || null,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.duda);
}

// -----------------------------------------------------------------
// Webhook — no external verify (customer endpoint may not exist yet, may
// reject GETs, or may need our exact format). Auto-generate the bearer token
// so the same value can be embedded in code samples and Lovable prompts.
// -----------------------------------------------------------------
function generateWebhookToken() {
  return 'aseo_wh_' + crypto.randomBytes(16).toString('hex');
}

async function connectWebhook({ userId, url }) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw makeError(400, 'INVALID', 'Valid webhook URL required');
  const bearerToken = generateWebhookToken();
  const hostname = new URL(normalized).hostname;
  const row = await upsert({
    userId,
    provider: 'webhook',
    externalId: `webhook:${normalized}`,
    displayName: `Webhook: ${hostname}`,
    metadata: {
      url: normalized,
      bearer_token: bearerToken,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.webhook);
}

// -----------------------------------------------------------------
// RSS/JSON Feeds — no external system. One row per user (external_id ties
// to the user). Actual feed serving lives in a public route (Phase 2).
// -----------------------------------------------------------------
async function connectRssFeeds({ userId }) {
  const feedToken = 'aseo_rss_' + crypto.randomBytes(16).toString('hex');
  const row = await upsert({
    userId,
    provider: 'rss',
    externalId: `rss:${userId}`,
    displayName: 'RSS & JSON Feeds',
    metadata: {
      feed_token: feedToken,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.rss);
}

// -----------------------------------------------------------------
// WordPress step 1 — probe /wp-json/ to confirm the URL is a WordPress
// site. Not a full connect; the wizard advances to step 2 (plugin install)
// on success. Full connect lands with the plugin (Phase 2).
// -----------------------------------------------------------------
async function verifyWordPress({ url }) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw makeError(400, 'INVALID', 'Valid URL required');
  let res;
  try {
    res = await axios.get(`${normalized}/wp-json/`, {
      timeout: VERIFY_TIMEOUT_MS,
      validateStatus: () => true,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw makeError(502, 'VERIFY_FAILED', `Could not reach ${normalized}: ${err.message}`);
  }
  if (res.status !== 200 || typeof res.data !== 'object' || !Array.isArray(res.data?.namespaces)) {
    throw makeError(400, 'NOT_WORDPRESS', 'This URL does not appear to be a WordPress site');
  }
  return {
    ok: true,
    url: normalized,
    siteName: res.data?.name || null,
    description: res.data?.description || null,
  };
}

module.exports = {
  connectWebflow,
  connectWix,
  connectBigCommerce,
  connectHubSpot,
  connectGoHighLevel,
  connectDuda,
  connectWebhook,
  connectRssFeeds,
  verifyWordPress,
  SENSITIVE_FIELDS,
  _internal: { normalizeUrl, upsert, stripSensitive, generateWebhookToken },
};
