// Apple App Store Connect — read-only endpoints.
//
// Auth stack: authMiddleware only. No requireBusinessAuth — ASC has NO
// relation to the Google OAuth grant that populates req.businessToken.
// Each request loads the encrypted .p8 from connected_accounts, decrypts
// with cryptoBox, and mints a fresh 20-min JWT.
//
// Endpoints:
//   POST /api/asc/connect         → validate credentials, encrypt + save
//   GET  /api/asc/connected       → this user's saved ASC apps
//   GET  /api/asc/apps?connectionId  → refresh apps list from the API
//   GET  /api/asc/reviews?connectionId&limit&territory
//   GET  /api/asc/sales?connectionId&days     → daily sales rollup, newest first
//   GET  /api/asc/_diagnose?connectionId      → cred probe (does the JWT work)
//   DELETE /api/asc/:connectionId             → remove
//
// READ-ONLY. There is no mutate route — TestFlight / metadata / pricing all
// stay in the ASC UI.

const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { createClient } = require('@supabase/supabase-js');
const asc = require('../services/appStoreConnectService');
const ascAnalytics = require('../services/ascAnalyticsService');
const connections = require('../services/connectionsService');
const cryptoBox = require('../utils/cryptoBox');
const logger = require('../utils/logger');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

// Load the saved row (raw metadata — includes encrypted p8) and decrypt.
// Returns { creds: { p8, issuerId, keyId }, vendorNumber, appId, row } or null.
async function loadCreds(userId, connectionId) {
  const row = await connections.getRawForUser(userId, connectionId);
  if (!row || row.provider !== 'app_store_connect') return null;
  const meta = row.metadata || {};
  if (!meta.p8_encrypted || !meta.issuer_id || !meta.key_id) return null;
  const p8 = cryptoBox.decrypt(meta.p8_encrypted);
  return {
    creds: { p8, issuerId: meta.issuer_id, keyId: meta.key_id },
    vendorNumber: meta.vendor_number || null,
    appId: meta.app_id || null,
    row,
  };
}

function normalizeInput(raw) {
  return String(raw || '').trim();
}

// Users paste the .p8 file contents. Strip surrounding whitespace but
// preserve the internal newlines that PEM parsers need.
function normalizeP8(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('-----BEGIN')) {
    throw new Error('p8 must start with "-----BEGIN PRIVATE KEY-----" — paste the full file contents');
  }
  return s;
}

// -----------------------------------------------------------------------
// POST /connect — validate + save
// -----------------------------------------------------------------------
router.post('/connect', express.json({ limit: '1mb' }), async (req, res) => {
  const userId = req.user.userId;
  try {
    const issuerId = normalizeInput(req.body?.issuerId);
    const keyId = normalizeInput(req.body?.keyId);
    const vendorNumber = normalizeInput(req.body?.vendorNumber);
    const appId = normalizeInput(req.body?.appId);
    const p8 = normalizeP8(req.body?.p8);
    if (!issuerId || !keyId) {
      return res.status(400).json({ error: 'issuerId and keyId required' });
    }

    // Probe the credentials with a listApps call — if the JWT doesn't
    // validate or the key lacks read access, Apple 401s and we surface
    // the error before writing anything.
    let apps;
    try {
      apps = await asc.listApps({ issuerId, keyId, p8 });
    } catch (err) {
      logger.warn('asc.connect.probe_failed', {
        userId, issuerId, keyId, status: err.status || null, error: err.message,
      });
      return res.status(err.status || 400).json({
        error: err.message,
        appleErrors: err.appleErrors || null,
      });
    }

    if (appId && !apps.find(a => a.id === appId)) {
      return res.status(400).json({
        error: `App id ${appId} is not accessible by this key`,
        accessibleApps: apps.map(a => ({ id: a.id, bundleId: a.bundleId, name: a.name })),
      });
    }

    // Pick a display name: preferred app > first accessible app > "Apple App Store"
    const primaryApp = appId
      ? apps.find(a => a.id === appId)
      : (apps[0] || null);
    const displayName = primaryApp?.name || primaryApp?.bundleId || 'Apple App Store';

    const p8Encrypted = cryptoBox.encrypt(p8);
    const row = await connections.upsertAppStoreConnect({
      userId,
      issuerId,
      keyId,
      p8Encrypted,
      vendorNumber: vendorNumber || null,
      appId: primaryApp?.id || null,
      appBundleId: primaryApp?.bundleId || null,
      displayName,
    });

    logger.info('asc.connected', {
      userId, issuerId, keyId,
      appsCount: apps.length,
      connectionId: row.id,
      hasVendorNumber: !!vendorNumber,
    });

    res.status(201).json({
      connection: row,
      apps,
    });
  } catch (err) {
    logger.error('asc.connect.failed', { userId, error: err.message });
    res.status(500).json({ error: err.message || 'Failed to save ASC credentials' });
  }
});

// -----------------------------------------------------------------------
// GET /connected — list this user's saved ASC connections
// -----------------------------------------------------------------------
router.get('/connected', async (req, res) => {
  try {
    const rows = await connections.listForUser(req.user.userId);
    res.json({
      connections: rows
        .filter(r => r.provider === 'app_store_connect')
        .map(r => ({
          connectionId: r.id,
          displayName: r.display_name,
          issuerId: r.metadata?.issuer_id || null,
          keyId: r.metadata?.key_id || null,
          appId: r.metadata?.app_id || null,
          appBundleId: r.metadata?.app_bundle_id || null,
          // Vendor number is a numeric account ID (not a credential like
          // the .p8). Returning it so the edit modal can show what's saved.
          vendorNumber: r.metadata?.vendor_number || null,
          hasVendorNumber: !!r.metadata?.vendor_number,
          status: r.status,
          connectedAt: r.metadata?.connected_at || r.created_at,
        })),
    });
  } catch (err) {
    logger.error('asc.connected.failed', { userId: req.user.userId, error: err.message });
    res.status(500).json({ error: 'Failed to list ASC connections' });
  }
});

// -----------------------------------------------------------------------
// GET /_diagnose — probe credentials
// -----------------------------------------------------------------------
router.get('/_diagnose', async (req, res) => {
  const userId = req.user.userId;
  try {
    const ctx = await loadCreds(userId, String(req.query.connectionId || ''));
    if (!ctx) return res.status(400).json({ error: 'connectionId required or not found' });
    const t0 = Date.now();
    const apps = await asc.listApps(ctx.creds);
    logger.info('asc.diagnose.ok', { userId, appsCount: apps.length, duration_ms: Date.now() - t0 });
    res.json({
      ok: true,
      appsCount: apps.length,
      hasVendorNumber: !!ctx.vendorNumber,
      apps: apps.map(a => ({ id: a.id, bundleId: a.bundleId, name: a.name })),
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      error: err.message,
      appleErrors: err.appleErrors || null,
    });
  }
});

// -----------------------------------------------------------------------
// GET /apps — refresh apps list from Apple
// -----------------------------------------------------------------------
router.get('/apps', async (req, res) => {
  const userId = req.user.userId;
  try {
    const ctx = await loadCreds(userId, String(req.query.connectionId || ''));
    if (!ctx) return res.status(400).json({ error: 'connectionId required or not found' });
    const t0 = Date.now();
    const apps = await asc.listApps(ctx.creds);
    logger.info('asc.apps.ok', { userId, appsCount: apps.length, duration_ms: Date.now() - t0 });
    res.json({ apps, primaryAppId: ctx.appId });
  } catch (err) {
    logger.warn('asc.apps.failed', { userId, error: err.message, status: err.status || null });
    res.status(err.status || 500).json({ error: err.message, appleErrors: err.appleErrors || null });
  }
});

// -----------------------------------------------------------------------
// GET /reviews — recent customer reviews for an app
// -----------------------------------------------------------------------
router.get('/reviews', async (req, res) => {
  const userId = req.user.userId;
  try {
    const ctx = await loadCreds(userId, String(req.query.connectionId || ''));
    if (!ctx) return res.status(400).json({ error: 'connectionId required or not found' });
    const appId = String(req.query.appId || ctx.appId || '').trim();
    if (!appId) return res.status(400).json({ error: 'appId required (or set a primary appId on the connection)' });
    const limit = req.query.limit;
    const territory = req.query.territory;
    const t0 = Date.now();
    const reviews = await asc.getReviews(ctx.creds, { appId, limit, territory });
    logger.info('asc.reviews.ok', { userId, appId, count: reviews.length, duration_ms: Date.now() - t0 });
    res.json({ appId, reviews });
  } catch (err) {
    logger.warn('asc.reviews.failed', { userId, error: err.message, status: err.status || null });
    res.status(err.status || 500).json({ error: err.message, appleErrors: err.appleErrors || null });
  }
});

// -----------------------------------------------------------------------
// GET /sales — daily sales rollup
// -----------------------------------------------------------------------
router.get('/sales', async (req, res) => {
  const userId = req.user.userId;
  try {
    const ctx = await loadCreds(userId, String(req.query.connectionId || ''));
    if (!ctx) return res.status(400).json({ error: 'connectionId required or not found' });
    if (!ctx.vendorNumber) {
      return res.status(400).json({
        error: 'This connection has no vendor number. Set it in the ASC connection form (Payments & Financial Reports → Payments and Financial Reports → the numeric ID in the top-left dropdown).',
        code: 'VENDOR_NUMBER_MISSING',
      });
    }
    const days = req.query.days;
    const t0 = Date.now();
    const reports = await asc.getSalesReportRange(ctx.creds, {
      vendorNumber: ctx.vendorNumber,
      days,
    });
    logger.info('asc.sales.ok', {
      userId, days: Number(days) || 7,
      reportsFetched: reports.length,
      duration_ms: Date.now() - t0,
    });
    res.json({
      days: Number(days) || 7,
      vendorNumber: ctx.vendorNumber,
      reports,
    });
  } catch (err) {
    logger.warn('asc.sales.failed', { userId, error: err.message, status: err.status || null });
    res.status(err.status || 500).json({ error: err.message, appleErrors: err.appleErrors || null });
  }
});

// -----------------------------------------------------------------------
// App Analytics — async report flow (Phase 2)
// -----------------------------------------------------------------------
//
// POST /analytics/bootstrap  — one-time per connection. Tells Apple to start
//                              generating daily reports. Idempotent.
// GET  /analytics/status     — report request id + last cron check + row count
// POST /analytics/walk       — manual trigger (cron does this hourly)
// GET  /analytics/funnel?days   — install funnel from cache
// GET  /analytics/sources?days  — installs by source from cache
//
// The bootstrap POST is user-triggered; the walk is server-triggered by the
// ascAnalyticsScheduler worker. The funnel/sources endpoints read from
// asc_analytics_cache — no Apple calls at request time.

router.post('/analytics/bootstrap', express.json(), async (req, res) => {
  const userId = req.user.userId;
  try {
    const connectionId = String(req.body?.connectionId || req.query.connectionId || '');
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    const result = await ascAnalytics.bootstrap(userId, connectionId);
    res.json(result);
  } catch (err) {
    logger.warn('asc_analytics.bootstrap.failed', {
      userId, error: err.message, status: err.status || null,
    });
    res.status(err.status || 500).json({ error: err.message, appleErrors: err.appleErrors || null });
  }
});

router.get('/analytics/status', async (req, res) => {
  const userId = req.user.userId;
  try {
    const connectionId = String(req.query.connectionId || '');
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    const status = await ascAnalytics.getStatus({ userId, connectionId });
    if (!status) return res.status(404).json({ error: 'Connection not found' });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual walk trigger — mostly useful for testing / on-demand refresh from
// the dashboard. Cron does this hourly automatically.
router.post('/analytics/walk', express.json(), async (req, res) => {
  const userId = req.user.userId;
  try {
    const connectionId = String(req.body?.connectionId || req.query.connectionId || '');
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    const summary = await ascAnalytics.walk(userId, connectionId);
    res.json(summary);
  } catch (err) {
    logger.warn('asc_analytics.walk.failed', {
      userId, error: err.message, status: err.status || null,
    });
    res.status(err.status || 500).json({ error: err.message, appleErrors: err.appleErrors || null });
  }
});

router.get('/analytics/funnel', async (req, res) => {
  const userId = req.user.userId;
  try {
    const connectionId = String(req.query.connectionId || '');
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    // Ownership check — getStatus validates the connection belongs to userId.
    const status = await ascAnalytics.getStatus({ userId, connectionId });
    if (!status) return res.status(404).json({ error: 'Connection not found' });
    const funnel = await ascAnalytics.getInstallFunnel({
      connectionId,
      days: req.query.days,
    });
    res.json(funnel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/sources', async (req, res) => {
  const userId = req.user.userId;
  try {
    const connectionId = String(req.query.connectionId || '');
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    const status = await ascAnalytics.getStatus({ userId, connectionId });
    if (!status) return res.status(404).json({ error: 'Connection not found' });
    const sources = await ascAnalytics.getInstallsBySource({
      connectionId,
      days: req.query.days,
    });
    res.json(sources);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// PATCH /:connectionId — update credentials in place (key rotation)
// -----------------------------------------------------------------------
// Use case: user generated a new API key with broader permissions (e.g.
// upgrading Developer → Admin so App Analytics + Sales & Trends work).
// Issuer ID is treated as immutable (identity of the connection); if you
// truly need a different issuer, delete and re-create.
//
// Accepts partial updates. If p8 is provided, keyId MUST be provided too
// (each .p8 file is bound to a specific key id). We validate the new creds
// by probing listApps before writing — bad keys 401 immediately, no
// half-written state.
router.patch('/:connectionId', express.json({ limit: '1mb' }), async (req, res) => {
  const userId = req.user.userId;
  try {
    const existing = await connections.getRawForUser(userId, req.params.connectionId);
    if (!existing || existing.provider !== 'app_store_connect') {
      return res.status(404).json({ error: 'ASC connection not found' });
    }
    const issuerId = existing.metadata.issuer_id;  // immutable via edit
    const keyIdIn = normalizeInput(req.body?.keyId);
    const vendorNumberIn = normalizeInput(req.body?.vendorNumber);
    const appIdIn = normalizeInput(req.body?.appId);
    const p8In = req.body?.p8;

    let p8Encrypted = null;   // null = keep existing
    let apps = null;
    let primaryApp = null;

    if (p8In) {
      if (!keyIdIn) {
        return res.status(400).json({ error: 'keyId is required when replacing the .p8 (each key file is bound to one key id)' });
      }
      const p8 = normalizeP8(p8In);
      // Probe with the NEW creds before writing anything.
      try {
        apps = await asc.listApps({ issuerId, keyId: keyIdIn, p8 });
      } catch (err) {
        logger.warn('asc.update.probe_failed', {
          userId, issuerId, keyId: keyIdIn,
          status: err.status || null, error: err.message,
        });
        return res.status(err.status || 400).json({
          error: err.message,
          appleErrors: err.appleErrors || null,
        });
      }
      p8Encrypted = cryptoBox.encrypt(p8);
    } else if (keyIdIn && keyIdIn !== existing.metadata.key_id) {
      return res.status(400).json({ error: 'Must provide a new .p8 when changing keyId' });
    }

    // Prefer the existing primary app id if it's still visible to the new key;
    // fall back to whatever the caller passed or the first app.
    if (apps) {
      const preferId = appIdIn || existing.metadata.app_id;
      primaryApp = apps.find(a => a.id === preferId) || apps[0] || null;
    }
    const displayName = primaryApp?.name || primaryApp?.bundleId || existing.display_name;

    const row = await connections.updateAppStoreConnect({
      userId,
      connectionId: req.params.connectionId,
      issuerId,
      keyId: keyIdIn || existing.metadata.key_id,
      p8Encrypted: p8Encrypted || undefined,       // undefined = keep existing
      vendorNumber: vendorNumberIn !== '' ? (vendorNumberIn || null) : existing.metadata.vendor_number,
      appId: primaryApp?.id || existing.metadata.app_id,
      appBundleId: primaryApp?.bundleId || existing.metadata.app_bundle_id,
      displayName,
    });

    logger.info('asc.updated', {
      userId,
      connectionId: row.id,
      rotatedKey: !!p8Encrypted,
      appsCount: apps ? apps.length : null,
    });

    res.json({ connection: row, apps });
  } catch (err) {
    logger.error('asc.update.failed', { userId, error: err.message });
    res.status(500).json({ error: err.message || 'Failed to update ASC credentials' });
  }
});

// -----------------------------------------------------------------------
// DELETE /:connectionId — remove an ASC connection
// -----------------------------------------------------------------------
router.delete('/:connectionId', async (req, res) => {
  const userId = req.user.userId;
  try {
    const ok = await connections.deleteForUser(userId, req.params.connectionId);
    if (!ok) return res.status(404).json({ error: 'Connection not found' });
    logger.info('asc.deleted', { userId, connectionId: req.params.connectionId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('asc.delete.failed', { userId, error: err.message });
    res.status(500).json({ error: err.message || 'Failed to delete' });
  }
});

module.exports = router;
