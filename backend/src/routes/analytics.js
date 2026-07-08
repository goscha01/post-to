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
const { getAllBusinessTokens, refreshOneToken } = require('../utils/businessTokens');
const logger = require('../utils/logger');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);
router.use(requireBusinessAuth);

// Given a saved GA4 property (connected_accounts row), find the OAuth token
// for the Google account that actually owns it. Falls back to req.businessToken
// (the middleware default) if the property has no owner recorded — happens for
// rows saved before multi-account support landed.
async function tokenForProperty(req, propertyId) {
  const { data: rows } = await supabase
    .from('connected_accounts')
    .select('metadata')
    .eq('user_id', req.user.userId)
    .eq('provider', 'google_analytics')
    .eq('external_id', `ga4:${propertyId}`)
    .limit(1);
  const ownerGoogleId = rows && rows[0]?.metadata?.owner_google_id;
  if (!ownerGoogleId) return req.businessToken;

  const tokens = await getAllBusinessTokens(req.user.userId);
  const match = tokens.find(t => t.google_id === ownerGoogleId);
  return match?.access_token || req.businessToken;
}

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
      // Route the report call to whichever Google account owns this property.
      // Multi-account: user may have connected two Google accounts, each owning
      // different GA4 properties. req.businessToken alone would only work for
      // properties owned by the most-recently-connected account.
      const token = await tokenForProperty(req, propertyId);
      const t0 = Date.now();
      const result = await serviceFn(token, propertyId, days);
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
    // Fan out across every connected Google account. Each token can see a
    // different set of GA4 properties (its own analytics access). We tag each
    // returned property with owner_google_id + owner_email so the caller can
    // save + route later reports to the right token.
    const tokens = await getAllBusinessTokens(req.user.userId);
    // Fallback: no tokens in business_profiles[] yet — use req.businessToken
    // (older users may not have the multi-profile shape yet).
    const effectiveTokens = tokens.length > 0 ? tokens : [{
      access_token: req.businessToken,
      email: null,
      google_id: null,
    }];

    const results = await Promise.allSettled(
      effectiveTokens.map(async t => {
        const props = await analytics.listProperties(t.access_token);
        return props.map(p => ({
          ...p,
          ownerGoogleId: t.google_id || null,
          ownerEmail: t.email || null,
        }));
      })
    );

    const merged = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        merged.push(...r.value);
      } else {
        errors.push({
          ownerEmail: effectiveTokens[i].email,
          status: r.reason?.response?.status || null,
          message: r.reason?.message || 'unknown',
        });
      }
    });

    // Dedupe on propertyId — same property could theoretically be visible to
    // two connected accounts (rare, but harmless dedupe).
    const seen = new Set();
    const deduped = merged.filter(p => {
      if (seen.has(p.propertyId)) return false;
      seen.add(p.propertyId);
      return true;
    });

    logger.info('analytics.properties.list_ok', {
      userId: req.user.userId,
      count: deduped.length,
      accounts_tried: effectiveTokens.length,
      accounts_failed: errors.length,
    });

    // If EVERY account failed with 403, surface needsReauth. If some worked and
    // some 403'd, that's normal (an account might not have analytics.readonly).
    if (errors.length === effectiveTokens.length && errors.every(e => e.status === 403)) {
      return res.status(403).json({
        error: 'None of the connected Google accounts granted analytics.readonly',
        needsReauth: true,
        errors,
      });
    }

    res.json({ properties: deduped, errors: errors.length ? errors : undefined });
  } catch (err) {
    const norm = analytics.normalizeApiError(err, {
      endpoint: 'properties.list',
      userId: req.user.userId,
    });
    res.status(norm.status || 500).json({ error: norm.message });
  }
});

router.post('/properties', express.json(), async (req, res) => {
  try {
    const { propertyId, displayName, accountId, ownerGoogleId, ownerEmail } = req.body || {};
    if (!propertyId) {
      return res.status(400).json({ error: 'propertyId required' });
    }
    const row = await connections.upsertGoogleAnalytics({
      userId: req.user.userId,
      propertyId: String(propertyId).trim(),
      displayName: displayName || `GA4 Property ${propertyId}`,
      accountId: accountId ? String(accountId).trim() : null,
      ownerGoogleId: ownerGoogleId || null,
      ownerEmail: ownerEmail || null,
    });
    logger.info('analytics.property.connected', {
      userId: req.user.userId,
      propertyId,
      connectionId: row.id,
      ownerGoogleId: ownerGoogleId || null,
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

// Convenience: list the Google accounts currently connected on the user's
// business_profiles. Useful for the frontend to show "Connect another Google
// account" and to display owner emails on the property picker.
router.get('/accounts', async (req, res) => {
  try {
    const tokens = await getAllBusinessTokens(req.user.userId);
    res.json({
      accounts: tokens.map(t => ({
        googleId: t.google_id,
        email: t.email,
        hasRefreshToken: !!t.refresh_token,
      })),
    });
  } catch (err) {
    logger.error('analytics.accounts.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to list accounts' });
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
          ownerGoogleId: r.metadata?.owner_google_id || null,
          ownerEmail: r.metadata?.owner_email || null,
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
