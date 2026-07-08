// Google Analytics 4 read-only endpoints.
//
// Auth stack:
//   - authMiddleware       → user JWT (populates req.user.userId)
//   - requireBusinessAuth  → GA4 tokens live on the same OAuth grant as GMB
//                            (analytics.readonly is included in BUSINESS_SCOPES).
//                            The middleware handles proactive refresh + populates
//                            req.businessToken / req.businessRefreshToken.
//
// Endpoints:
//   GET  /api/analytics/properties                     — list GA4 properties on the Google account
//   POST /api/analytics/properties                     — save selected property to connected_accounts
//   GET  /api/analytics/connected                      — list this user's connected GA4 properties
//   GET  /api/analytics/overview?propertyId&days       — headline metrics
//   GET  /api/analytics/traffic?propertyId&days        — source/medium/campaign table
//   GET  /api/analytics/landing-pages?propertyId&days  — landing page table
//   GET  /api/analytics/events?propertyId&days         — event report + highlighted key events
//   GET  /api/analytics/campaigns?propertyId&days      — utm_campaign table
//   GET  /api/analytics/devices?propertyId&days        — device breakdown (mobile/desktop/tablet)
//   GET  /api/analytics/geography?propertyId&days      — country/region/city table
//
// propertyId can be passed as query string (?propertyId=123) or resolved from
// a connectionId (?connectionId=<uuid> pointing at a connected_accounts row).
// When neither is provided we fall back to the user's most recently connected
// GA4 property.
//
// Foundation for future Google Ads integration:
//   - The shape of every response uses generic keys (source, medium, campaign,
//     sessions, users, conversions, revenue) so a future adsService can join
//     against these rows on (campaign, source, medium) without a data model
//     change. When adding Google Ads later:
//       1. Add `adwords` scope to BUSINESS_SCOPES in routes/auth.js
//       2. Add /api/ads endpoints that return the same row shape
//       3. Frontend can merge tables client-side by matching keys

const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const analytics = require('../services/analyticsService');
const connections = require('../services/connectionsService');
const logger = require('../utils/logger');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);
router.use(requireBusinessAuth);

// ---------- Diagnostics ----------
//
// GET /api/analytics/_diagnose
// Introspects the current business access token via Google's tokeninfo endpoint
// and returns the exact scopes attached to it. Use this to verify whether a
// reconnect actually granted analytics.readonly. Not sensitive — only reports
// scope strings, no token material.
router.get('/_diagnose', async (req, res) => {
  try {
    const axios = require('axios');
    const { data } = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
      params: { access_token: req.businessToken },
      timeout: 8000,
      validateStatus: s => s < 500,
    });
    const grantedScopes = (data.scope || '').split(/\s+/).filter(Boolean);
    const hasAnalytics = grantedScopes.includes('https://www.googleapis.com/auth/analytics.readonly');
    const hasBusiness = grantedScopes.includes('https://www.googleapis.com/auth/business.manage');
    logger.info('analytics.diagnose', {
      userId: req.user.userId,
      granted_scopes: grantedScopes,
      hasAnalytics,
      hasBusiness,
    });
    res.json({
      grantedScopes,
      hasAnalyticsReadonly: hasAnalytics,
      hasBusinessManage: hasBusiness,
      audience: data.aud || null,
      expiresIn: data.expires_in || null,
      tokenInfoError: data.error || null,
      guidance: hasAnalytics ? null : {
        message: 'The current business OAuth token was not granted analytics.readonly.',
        possibleCauses: [
          'The scope is not listed in the Google Cloud OAuth Consent Screen (Console → APIs & Services → OAuth consent screen → Scopes).',
          'The Google Analytics Admin API or Analytics Data API is not enabled in the Google Cloud project (Console → APIs & Services → Enabled APIs).',
          'The user unchecked the Analytics permission on the consent screen.',
          'The user reconnected before the latest deploy went live.',
        ],
      },
    });
  } catch (err) {
    logger.error('analytics.diagnose.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to introspect token' });
  }
});

// ---------- helpers ----------

// Resolve which GA4 property the caller wants a report for.
//   1. explicit ?propertyId=…  wins
//   2. ?connectionId=<uuid>    → look up the connected_accounts row
//   3. fallback to user's most recently connected GA4 property
async function resolvePropertyId(req) {
  const explicit = (req.query.propertyId || '').toString().trim();
  if (explicit) return explicit;

  const connectionId = (req.query.connectionId || '').toString().trim();
  if (connectionId) {
    const row = await connections.getForUser(req.user.userId, connectionId);
    if (row && row.provider === 'google_analytics') {
      return row.metadata?.property_id || null;
    }
  }

  // Fall back to most recent connected GA4 property.
  const { data } = await supabase
    .from('connected_accounts')
    .select('metadata, created_at')
    .eq('user_id', req.user.userId)
    .eq('provider', 'google_analytics')
    .order('created_at', { ascending: false })
    .limit(1);
  return data && data[0] ? data[0].metadata?.property_id : null;
}

function parseDays(req) {
  const raw = parseInt(req.query.days, 10);
  if (![7, 14, 30, 60, 90, 180, 365].includes(raw)) return 30;
  return raw;
}

// Every report endpoint follows this same pattern: resolve property, run the
// service method, translate errors. Keep it here so the individual endpoints
// stay one-liners.
function reportHandler(serviceFn, name) {
  return async (req, res) => {
    try {
      const propertyId = await resolvePropertyId(req);
      if (!propertyId) {
        return res.status(400).json({
          error: 'No GA4 property specified or connected',
          needsPropertySelection: true,
        });
      }
      const days = parseDays(req);
      const t0 = Date.now();
      const result = await serviceFn(req.businessToken, propertyId, days);
      logger.info(`analytics.${name}.ok`, {
        userId: req.user.userId,
        propertyId,
        days,
        duration_ms: Date.now() - t0,
      });
      res.json({ propertyId, days, [name]: result });
    } catch (err) {
      const norm = analytics.normalizeApiError(err, {
        endpoint: name,
        userId: req.user.userId,
      });
      res.status(norm.status || 500).json({ error: norm.message });
    }
  };
}

// ---------- Property discovery + selection ----------

router.get('/properties', async (req, res) => {
  try {
    const props = await analytics.listProperties(req.businessToken);
    logger.info('analytics.properties.list_ok', {
      userId: req.user.userId,
      count: props.length,
    });
    res.json({ properties: props });
  } catch (err) {
    const norm = analytics.normalizeApiError(err, {
      endpoint: 'properties.list',
      userId: req.user.userId,
    });
    // 403 usually means analytics.readonly wasn't granted on this OAuth
    // consent — the frontend can prompt the user to reconnect.
    if (norm.status === 403) {
      return res.status(403).json({
        error: norm.message,
        needsReauth: true,
      });
    }
    res.status(norm.status || 500).json({ error: norm.message });
  }
});

router.post('/properties', express.json(), async (req, res) => {
  try {
    const { propertyId, displayName, accountId } = req.body || {};
    if (!propertyId) {
      return res.status(400).json({ error: 'propertyId required' });
    }
    const row = await connections.upsertGoogleAnalytics({
      userId: req.user.userId,
      propertyId: String(propertyId).trim(),
      displayName: displayName || `GA4 Property ${propertyId}`,
      accountId: accountId ? String(accountId).trim() : null,
    });
    logger.info('analytics.property.connected', {
      userId: req.user.userId,
      propertyId,
      connectionId: row.id,
    });
    res.status(201).json({ connection: row });
  } catch (err) {
    logger.error('analytics.property.connect_failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to save property' });
  }
});

// Convenience: list the current user's connected GA4 properties in the
// analytics context (frontend property picker). Just a filtered mirror of
// /api/connections.
router.get('/connected', async (req, res) => {
  try {
    const rows = await connections.listForUser(req.user.userId);
    res.json({
      properties: rows
        .filter(r => r.provider === 'google_analytics')
        .map(r => ({
          connectionId: r.id,
          propertyId: r.metadata?.property_id,
          displayName: r.display_name,
          accountId: r.metadata?.account_id || null,
          status: r.status,
          connectedAt: r.metadata?.connected_at || r.created_at,
        })),
    });
  } catch (err) {
    logger.error('analytics.connected.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: 'Failed to list connected properties' });
  }
});

// ---------- Report endpoints ----------

router.get('/overview',      reportHandler(analytics.getOverview,       'overview'));
router.get('/traffic',       reportHandler(analytics.getTrafficSources, 'traffic'));
router.get('/landing-pages', reportHandler(analytics.getLandingPages,   'landingPages'));
router.get('/events',        reportHandler(analytics.getEvents,         'events'));
router.get('/campaigns',     reportHandler(analytics.getCampaigns,      'campaigns'));
router.get('/devices',       reportHandler(analytics.getDevices,        'devices'));
router.get('/geography',     reportHandler(analytics.getGeography,      'geography'));

module.exports = router;
