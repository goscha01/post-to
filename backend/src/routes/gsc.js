// Google Search Console read-only endpoints.
//
// Auth stack:
//   - authMiddleware       → user JWT (populates req.user.userId)
//   - requireBusinessAuth  → GSC tokens live on the same OAuth grant as GMB
//                            (webmasters.readonly is in BUSINESS_SCOPES). The
//                            middleware handles proactive refresh + populates
//                            req.businessToken.
//
// Endpoints:
//   GET  /api/gsc/sites                    — list GSC sites across every connected Google account
//   POST /api/gsc/sites                    — save a picked site as a connected_accounts row
//   GET  /api/gsc/connected                — list this user's connected GSC sites
//   GET  /api/gsc/queries?connectionId&days&limit
//                                          — top queries (keywords) for a saved connection
//
// The queries endpoint is what the Blogs page consumes to render the "Top
// keywords from Search Console" section with per-row Generate blog buttons.

const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const requireBusinessAuth = require('../middleware/businessAuth');
const gsc = require('../services/googleSearchConsoleService');
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

// Given a saved GSC site, find the OAuth token for the Google account that
// actually owns it. Falls back to req.businessToken when the row has no
// owner recorded.
async function tokenForSite(req, siteUrl) {
  const { data: rows } = await supabase
    .from('connected_accounts')
    .select('metadata')
    .eq('user_id', req.user.userId)
    .eq('provider', 'google_search_console')
    .eq('external_id', `gsc:${siteUrl}`)
    .limit(1);
  const ownerGoogleId = rows && rows[0]?.metadata?.owner_google_id;
  if (!ownerGoogleId) return req.businessToken;

  const tokens = await getAllBusinessTokens(req.user.userId);
  const match = tokens.find(t => t.google_id === ownerGoogleId);
  return match?.access_token || req.businessToken;
}

// ---------- Site discovery + selection ----------

router.get('/sites', async (req, res) => {
  try {
    // Fan out across every connected Google account. Each token can see a
    // different set of GSC sites. Tag each returned site with owner_google_id
    // + owner_email so the caller can save + route later queries to the right
    // token.
    const tokens = await getAllBusinessTokens(req.user.userId);
    const effectiveTokens = tokens.length > 0 ? tokens : [{
      access_token: req.businessToken,
      email: null,
      google_id: null,
    }];

    const results = await Promise.allSettled(
      effectiveTokens.map(async t => {
        const sites = await gsc.listSites(t.access_token);
        return sites.map(s => ({
          ...s,
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

    // Dedupe on siteUrl.
    const seen = new Set();
    const deduped = merged.filter(s => {
      if (seen.has(s.siteUrl)) return false;
      seen.add(s.siteUrl);
      return true;
    });

    logger.info('gsc.sites.list_ok', {
      userId: req.user.userId,
      count: deduped.length,
      accounts_tried: effectiveTokens.length,
      accounts_failed: errors.length,
    });

    if (errors.length === effectiveTokens.length && errors.every(e => e.status === 403)) {
      return res.status(403).json({
        error: 'None of the connected Google accounts granted webmasters.readonly',
        needsReauth: true,
        errors,
      });
    }

    res.json({ sites: deduped, errors: errors.length ? errors : undefined });
  } catch (err) {
    const norm = gsc.normalizeApiError(err, { endpoint: 'sites.list', userId: req.user.userId });
    logger.error('gsc.sites.list_failed', { error: norm.message, status: norm.status });
    res.status(norm.status || 500).json({ error: norm.message });
  }
});

router.post('/sites', express.json(), async (req, res) => {
  try {
    const { siteUrl, displayName, permissionLevel, ownerGoogleId, ownerEmail } = req.body || {};
    if (!siteUrl) return res.status(400).json({ error: 'siteUrl required' });
    const row = await connections.upsertGoogleSearchConsole({
      userId: req.user.userId,
      siteUrl: String(siteUrl).trim(),
      displayName: displayName || siteUrl,
      permissionLevel: permissionLevel || null,
      ownerGoogleId: ownerGoogleId || null,
      ownerEmail: ownerEmail || null,
    });
    logger.info('gsc.site.connected', {
      userId: req.user.userId,
      siteUrl,
      connectionId: row.id,
      ownerGoogleId: ownerGoogleId || null,
    });
    res.status(201).json({ connection: row });
  } catch (err) {
    logger.error('gsc.site.connect_failed', { userId: req.user.userId, error: err.message });
    res.status(500).json({ error: err.message || 'Failed to save site' });
  }
});

router.get('/connected', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', req.user.userId)
      .eq('provider', 'google_search_console')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ connections: data || [] });
  } catch (err) {
    logger.error('gsc.connected.list_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to list GSC connections' });
  }
});

// ---------- Top queries ----------

function parseDays(req) {
  const raw = parseInt(req.query.days, 10);
  if (![7, 14, 28, 30, 60, 90, 180].includes(raw)) return 7;
  return raw;
}

function parseLimit(req) {
  const raw = parseInt(req.query.limit, 10);
  if (!Number.isFinite(raw) || raw < 1) return 25;
  return Math.min(250, raw);
}

router.get('/queries', async (req, res) => {
  try {
    let siteUrl = req.query.siteUrl || null;

    // Resolve siteUrl from ?connectionId when the caller didn't pass one.
    if (!siteUrl && req.query.connectionId) {
      const row = await connections.getForUser(req.user.userId, req.query.connectionId);
      if (!row) return res.status(404).json({ error: 'Connection not found' });
      if (row.provider !== 'google_search_console') {
        return res.status(400).json({ error: 'Connection is not a Google Search Console connection' });
      }
      siteUrl = row.metadata?.site_url || row.external_id?.replace(/^gsc:/, '');
    }

    if (!siteUrl) {
      return res.status(400).json({
        error: 'No GSC site specified or connected',
        needsSiteSelection: true,
      });
    }

    const days = parseDays(req);
    const limit = parseLimit(req);

    const token = await tokenForSite(req, siteUrl);
    const t0 = Date.now();
    const result = await gsc.topQueries(token, siteUrl, { days, limit });

    logger.info('gsc.queries.ok', {
      userId: req.user.userId,
      siteUrl,
      days,
      limit,
      rows: result.rows.length,
      duration_ms: Date.now() - t0,
    });

    res.json(result);
  } catch (err) {
    const norm = gsc.normalizeApiError(err, {
      endpoint: 'queries',
      userId: req.user.userId,
    });
    logger.error('gsc.queries.failed', { error: norm.message, status: norm.status });
    res.status(norm.status || 500).json({ error: norm.message });
  }
});

module.exports = router;
