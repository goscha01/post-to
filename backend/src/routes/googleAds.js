// Google Ads read-only endpoints.
//
// Auth stack (same as /api/analytics):
//   - authMiddleware       → user JWT (populates req.user.userId)
//   - requireBusinessAuth  → Google Ads reuses the same OAuth grant as GMB +
//                            GA4 (adwords scope added to BUSINESS_SCOPES).
//                            Middleware handles proactive refresh + populates
//                            req.businessToken / req.businessRefreshToken.
//
// Endpoints:
//   GET  /api/google-ads/_diagnose                     — check adwords scope on current token
//   GET  /api/google-ads/customers                     — list accessible Google Ads customers
//   POST /api/google-ads/customers                     — save picked customer to connected_accounts
//   GET  /api/google-ads/connected                     — list this user's connected Ads customers
//   GET  /api/google-ads/campaigns?customerId&days
//   GET  /api/google-ads/adgroups?customerId&days
//   GET  /api/google-ads/keywords?customerId&days
//   GET  /api/google-ads/search-terms?customerId&days
//   GET  /api/google-ads/ads?customerId&days
//   GET  /api/google-ads/assets?customerId&days
//   GET  /api/google-ads/recommendations?customerId    (no days — always current)
//   GET  /api/google-ads/conversions?customerId&days
//   GET  /api/google-ads/devices?customerId&days
//   GET  /api/google-ads/locations?customerId&days
//   GET  /api/google-ads/day-hour?customerId&days
//   GET  /api/google-ads/audience?customerId&days
//   GET  /api/google-ads/auction-insights?customerId&days
//   GET  /api/google-ads/quality?customerId&days
//   GET  /api/google-ads/change-history?customerId&days
//   GET  /api/google-ads/diagnostics?customerId&days   — aggregated issue punch list
//
// customerId can be passed as ?customerId=1234567890 (no dashes) or resolved
// from ?connectionId=<uuid> (points at a connected_accounts row). Falls back
// to the user's most recently connected Ads customer.
//
// READ-ONLY. No mutate endpoints, ever. If you find yourself adding one,
// re-read the task spec — this is a diagnostics tool.

const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const ads = require('../services/googleAdsService');
const connections = require('../services/connectionsService');
const { getAllBusinessTokens } = require('../utils/businessTokens');
const logger = require('../utils/logger');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);
router.use(requireBusinessAuth);

// ---------- Token routing ----------
//
// Given a saved Google Ads customer, find the OAuth token for the Google
// account that owns it. Falls back to req.businessToken when metadata has no
// owner recorded (rows saved before multi-account support).
async function tokenForCustomer(req, customerId) {
  const { data: rows } = await supabase
    .from('connected_accounts')
    .select('metadata')
    .eq('user_id', req.user.userId)
    .eq('provider', 'google_ads')
    .eq('external_id', `ads:${customerId}`)
    .limit(1);
  const meta = rows && rows[0]?.metadata;
  const ownerGoogleId = meta?.owner_google_id;

  let accessToken = req.businessToken;
  if (ownerGoogleId) {
    const tokens = await getAllBusinessTokens(req.user.userId);
    const match = tokens.find(t => t.google_id === ownerGoogleId);
    if (match?.access_token) accessToken = match.access_token;
  }
  return {
    accessToken,
    loginCustomerId: meta?.manager_customer_id || null,
  };
}

// ---------- Diagnostics — scope introspection ----------
router.get('/_diagnose', async (req, res) => {
  try {
    const axios = require('axios');
    const { data } = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
      params: { access_token: req.businessToken },
      timeout: 8000,
      validateStatus: s => s < 500,
    });
    const grantedScopes = (data.scope || '').split(/\s+/).filter(Boolean);
    const hasAdwords = grantedScopes.includes('https://www.googleapis.com/auth/adwords');
    const hasDevToken = !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    logger.info('googleAds.diagnose', {
      userId: req.user.userId,
      granted_scopes: grantedScopes,
      hasAdwords,
      hasDeveloperToken: hasDevToken,
    });
    res.json({
      grantedScopes,
      hasAdwordsScope: hasAdwords,
      hasDeveloperToken: hasDevToken,
      audience: data.aud || null,
      expiresIn: data.expires_in || null,
      tokenInfoError: data.error || null,
      guidance: (!hasAdwords || !hasDevToken) ? {
        message: hasAdwords
          ? 'OAuth token has adwords scope but the server is missing GOOGLE_ADS_DEVELOPER_TOKEN.'
          : 'OAuth token does not include the adwords scope. Reconnect Google Business.',
        possibleCauses: [
          !hasAdwords && 'The adwords scope was not granted at consent time — reconnect once.',
          !hasDevToken && 'GOOGLE_ADS_DEVELOPER_TOKEN env var is not set on Railway.',
          'The Google Ads API is not enabled in the Google Cloud project.',
        ].filter(Boolean),
      } : null,
    });
  } catch (err) {
    logger.error('googleAds.diagnose.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to introspect token' });
  }
});

// ---------- Customer discovery + selection ----------

router.get('/customers', async (req, res) => {
  try {
    // Fan out across every connected Google account so a user with multiple
    // accounts sees the union of Ads customers they can access.
    const tokens = await getAllBusinessTokens(req.user.userId);
    const effectiveTokens = tokens.length > 0 ? tokens : [{
      access_token: req.businessToken,
      email: null,
      google_id: null,
    }];

    const results = await Promise.allSettled(
      effectiveTokens.map(async t => {
        const ownerEmail = t.email || null;
        const cids = await ads.listAccessibleCustomers(t.access_token, { ownerEmail });
        if (!cids.length) return [];
        const described = await ads.describeCustomers(t.access_token, cids, { ownerEmail });

        // If any accessible customer is a manager (MCC), enumerate the
        // customers under it — that's the only way sub-customers show up in
        // the picker for users whose only access is via a manager account.
        const managerCids = described.customers.filter(c => c.manager).map(c => c.customerId);
        const childCustomers = [];
        for (const managerCid of managerCids) {
          const children = await ads.enumerateManagerChildren(t.access_token, managerCid, { ownerEmail });
          for (const child of children) {
            // Skip the manager itself (customer_client includes level=0 = self)
            if (child.cid === managerCid) continue;
            childCustomers.push({
              customerId: child.cid,
              descriptiveName: child.descriptiveName,
              currencyCode: child.currencyCode,
              timeZone: child.timeZone,
              manager: child.manager,
              testAccount: false,
              autoTaggingEnabled: false,
              status: child.status,
              managerCustomerId: managerCid,
              ownerGoogleId: t.google_id || null,
              ownerEmail,
            });
          }
        }

        const directCustomers = described.customers.map(c => ({
          ...c,
          ownerGoogleId: t.google_id || null,
          ownerEmail,
        }));

        return [...directCustomers, ...childCustomers];
      })
    );

    const merged = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        merged.push(...r.value);
      } else {
        // Grab the full Google Ads error body — that's where DEVELOPER_TOKEN_NOT_APPROVED,
        // AUTHENTICATION_ERROR etc live. Without this, all 400s look identical.
        // Also capture the raw response.data body as a string so we can see
        // exactly what Google returned even when it isn't the expected
        // GoogleAdsFailure structure (some 400s from Ads API v20 return a
        // plain google.rpc.Status body with only code+message).
        const responseData = r.reason?.response?.data;
        const apiError = responseData?.error;
        const detail = apiError?.details?.[0]?.errors?.[0];
        let rawBody;
        try {
          rawBody = typeof responseData === 'string'
            ? responseData.slice(0, 800)
            : JSON.stringify(responseData || {}).slice(0, 800);
        } catch {
          rawBody = String(responseData).slice(0, 800);
        }
        errors.push({
          ownerEmail: effectiveTokens[i].email,
          status: r.reason?.response?.status || null,
          message: r.reason?.message || 'unknown',
          apiMessage: apiError?.message || null,
          apiStatus: apiError?.status || null,
          errorCode: detail?.errorCode ? JSON.stringify(detail.errorCode) : null,
          errorMessage: detail?.message || null,
          rawBody,
        });
      }
    });

    // Dedupe on customerId
    const seen = new Set();
    const deduped = merged.filter(c => {
      if (seen.has(c.customerId)) return false;
      seen.add(c.customerId);
      return true;
    });

    logger.info('googleAds.customers.list_ok', {
      userId: req.user.userId,
      count: deduped.length,
      accounts_tried: effectiveTokens.length,
      accounts_failed: errors.length,
      // Per-token detail — critical for diagnosing "connect ads didn't work".
      // Pass through every enriched field we captured above (apiMessage,
      // apiStatus, errorCode, errorMessage, rawBody) — earlier version of this
      // map picked only email/status/message which silently stripped the
      // Google-side error we actually need to see.
      failures: errors.map(e => ({
        email: e.ownerEmail,
        status: e.status,
        message: String(e.message || '').slice(0, 200),
        apiMessage: e.apiMessage,
        apiStatus: e.apiStatus,
        errorCode: e.errorCode,
        errorMessage: e.errorMessage,
        rawBody: e.rawBody,
      })),
    });

    if (errors.length === effectiveTokens.length && errors.every(e => e.status === 403 || e.status === 401)) {
      return res.status(403).json({
        error: 'None of the connected Google accounts granted adwords',
        needsReauth: true,
        errors,
      });
    }

    res.json({ customers: deduped, errors: errors.length ? errors : undefined });
  } catch (err) {
    const norm = ads.normalizeApiError(err, {
      endpoint: 'customers.list',
      userId: req.user.userId,
    });
    res.status(norm.status || 500).json({ error: norm.message, code: norm.code });
  }
});

router.post('/customers', express.json(), async (req, res) => {
  try {
    const {
      customerId,
      descriptiveName,
      managerCustomerId,
      currencyCode,
      timeZone,
      ownerGoogleId,
      ownerEmail,
    } = req.body || {};
    if (!customerId) {
      return res.status(400).json({ error: 'customerId required' });
    }
    const row = await connections.upsertGoogleAds({
      userId: req.user.userId,
      customerId: String(customerId).replace(/[^0-9]/g, ''),
      descriptiveName: descriptiveName || `Google Ads ${customerId}`,
      managerCustomerId: managerCustomerId ? String(managerCustomerId).replace(/[^0-9]/g, '') : null,
      currencyCode: currencyCode || null,
      timeZone: timeZone || null,
      ownerGoogleId: ownerGoogleId || null,
      ownerEmail: ownerEmail || null,
    });
    logger.info('googleAds.customer.connected', {
      userId: req.user.userId,
      customerId,
      connectionId: row.id,
      ownerGoogleId: ownerGoogleId || null,
    });
    res.status(201).json({ connection: row });
  } catch (err) {
    logger.error('googleAds.customer.connect_failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to save customer' });
  }
});

router.get('/connected', async (req, res) => {
  try {
    const rows = await connections.listForUser(req.user.userId);
    res.json({
      customers: rows
        .filter(r => r.provider === 'google_ads')
        .map(r => ({
          connectionId: r.id,
          customerId: r.metadata?.customer_id,
          descriptiveName: r.display_name,
          managerCustomerId: r.metadata?.manager_customer_id || null,
          currencyCode: r.metadata?.currency_code || null,
          timeZone: r.metadata?.time_zone || null,
          ownerGoogleId: r.metadata?.owner_google_id || null,
          ownerEmail: r.metadata?.owner_email || null,
          status: r.status,
          connectedAt: r.metadata?.connected_at || r.created_at,
        })),
    });
  } catch (err) {
    logger.error('googleAds.connected.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: 'Failed to list connected customers' });
  }
});

// ---------- Helpers ----------

async function resolveCustomerId(req) {
  const explicit = String(req.query.customerId || '').replace(/[^0-9]/g, '');
  if (explicit) return explicit;

  const connectionId = (req.query.connectionId || '').toString().trim();
  if (connectionId) {
    const row = await connections.getForUser(req.user.userId, connectionId);
    if (row && row.provider === 'google_ads') {
      return row.metadata?.customer_id || null;
    }
  }

  const { data } = await supabase
    .from('connected_accounts')
    .select('metadata, created_at')
    .eq('user_id', req.user.userId)
    .eq('provider', 'google_ads')
    .order('created_at', { ascending: false })
    .limit(1);
  return data && data[0] ? data[0].metadata?.customer_id : null;
}

function parseDays(req, defaultDays = 30) {
  const raw = parseInt(req.query.days, 10);
  if (![7, 14, 30, 60, 90, 180, 365].includes(raw)) return defaultDays;
  return raw;
}

// Optional campaign filter — numeric CID only, sanitized. Reports that don't
// naturally have a campaign relationship (conversions, devices, day/hour)
// ignore this value on the service side.
function parseCampaignId(req) {
  const raw = String(req.query.campaignId || '').replace(/[^0-9]/g, '');
  return raw || null;
}

// Every report endpoint follows the same pattern: resolve customer, route to
// correct token, call service method, translate errors.
function reportHandler(serviceFn, name, { supportsDays = true } = {}) {
  return async (req, res) => {
    try {
      const customerId = await resolveCustomerId(req);
      if (!customerId) {
        return res.status(400).json({
          error: 'No Google Ads customer specified or connected',
          needsCustomerSelection: true,
        });
      }
      const days = supportsDays ? parseDays(req) : undefined;
      const campaignId = parseCampaignId(req);
      const { accessToken, loginCustomerId } = await tokenForCustomer(req, customerId);
      const opts = { loginCustomerId, campaignId };
      const t0 = Date.now();
      const result = supportsDays
        ? await serviceFn(accessToken, customerId, days, opts)
        : await serviceFn(accessToken, customerId, opts);
      logger.info(`googleAds.${name}.ok`, {
        userId: req.user.userId,
        customerId,
        days: days || null,
        campaignId: campaignId || null,
        rowCount: Array.isArray(result) ? result.length : null,
        duration_ms: Date.now() - t0,
      });
      const payload = { customerId, [name]: result };
      if (days) payload.days = days;
      if (campaignId) payload.campaignId = campaignId;
      res.json(payload);
    } catch (err) {
      const norm = ads.normalizeApiError(err, {
        endpoint: name,
        userId: req.user.userId,
      });
      res.status(norm.status || 500).json({ error: norm.message, code: norm.code });
    }
  };
}

// ---------- Report endpoints ----------

router.get('/campaigns',         reportHandler(ads.getCampaigns,        'campaigns'));
router.get('/adgroups',          reportHandler(ads.getAdGroups,         'adGroups'));
router.get('/keywords',          reportHandler(ads.getKeywords,         'keywords'));
router.get('/search-terms',      reportHandler(ads.getSearchTerms,      'searchTerms'));
router.get('/ads',               reportHandler(ads.getAds,              'ads'));
router.get('/assets',            reportHandler(ads.getAssets,           'assets'));
router.get('/recommendations',   reportHandler(ads.getRecommendations,  'recommendations', { supportsDays: false }));
router.get('/conversions',       reportHandler(ads.getConversions,      'conversions'));
router.get('/devices',           reportHandler(ads.getDevices,          'devices'));
router.get('/locations',         reportHandler(ads.getLocations,        'locations'));
router.get('/day-hour',          reportHandler(ads.getDayHour,          'dayHour'));
router.get('/audience',          reportHandler(ads.getAudience,         'audience'));
router.get('/auction-insights',  reportHandler(ads.getAuctionInsights,  'auctionInsights'));
router.get('/quality',           reportHandler(ads.getQuality,          'quality'));
router.get('/change-history',    reportHandler(ads.getChangeHistory,    'changeHistory'));
router.get('/diagnostics',       reportHandler(ads.getDiagnostics,      'diagnostics'));

module.exports = router;
