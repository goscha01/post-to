// Unified "connected accounts" router.
//   GET    /api/connections                  → list current user's connected accounts (any provider)
//   POST   /api/connections/website          → { url } → scrape + upsert a website connection
//   DELETE /api/connections/:id              → disconnect a connected account
//
// google_business rows are written from the OAuth callback in routes/auth.js,
// not from this router — there's no plain "create google_business" endpoint
// because that requires the OAuth flow.

const express = require('express');
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/authMiddleware');
const connections = require('../services/connectionsService');
const publishing = require('../services/publishingPlatformService');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    // Self-heal: mirror any OAuth grants in users.business_profiles that
    // pre-date the upsertGoogleBusiness callback wire-up so the Connections
    // page shows every connected Google account, not just recent ones.
    try {
      await connections.reconcileGoogleBusiness(req.user.userId);
    } catch (e) {
      // Non-fatal — the list still returns whatever's already there.
    }
    // Self-heal: backfill picture_url on FB Page rows saved before the
    // picture field syntax was fixed (2026-07-28). Idempotent + cheap
    // (zero writes when every row already has a picture).
    try {
      await connections.reconcileFacebookPictures(req.user.userId);
    } catch (e) {
      // Non-fatal.
    }
    const rows = await connections.listForUser(req.user.userId);
    res.json({ connections: rows });
  } catch (err) {
    logger.error('connections.list_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to list connections' });
  }
});

router.post(
  '/website',
  [body('url').isString().isLength({ min: 3, max: 2048 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    try {
      const row = await connections.upsertWebsite({
        userId: req.user.userId,
        url: req.body.url,
      });
      logger.info('connections.website.connected', {
        userId: req.user.userId,
        connectionId: row.id,
        host: row.metadata?.host,
        fetch_ok: row.metadata?.fetch_ok,
      });
      res.status(201).json({ connection: row });
    } catch (err) {
      logger.error('connections.website.failed', { error: err.message });
      const status = err.message === 'Invalid URL' ? 400 : 500;
      res.status(status).json({ error: err.message || 'Failed to connect website' });
    }
  }
);

router.post(
  '/openai-ads',
  [
    body('apiKey').isString().isLength({ min: 8, max: 500 }),
    body('adAccountId').isString().isLength({ min: 3, max: 200 }),
    body('accountName').optional({ nullable: true }).isString().isLength({ max: 200 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    try {
      const row = await connections.upsertOpenAiAds({
        userId: req.user.userId,
        apiKey: req.body.apiKey,
        adAccountId: req.body.adAccountId,
        accountName: req.body.accountName,
      });
      logger.info('connections.openai_ads.connected', {
        userId: req.user.userId,
        connectionId: row.id,
        ad_account_id: row.metadata?.ad_account_id,
      });
      res.status(201).json({ connection: row });
    } catch (err) {
      logger.error('connections.openai_ads.failed', { error: err.message });
      const status = err.message === 'Invalid ad account ID' || err.message === 'API key required' ? 400 : 500;
      res.status(status).json({ error: err.message || 'Failed to connect OpenAI Ads' });
    }
  }
);

// ---------------------------------------------------------------------------
// Publishing Platform connect routes.
// One route per provider — each verifies creds against the provider's own
// API before upserting, so the UI gets immediate feedback on bad credentials
// or missing permissions. See services/publishingPlatformService.js.
// ---------------------------------------------------------------------------

// Small helper so the 9 routes below don't each repeat the same 15 lines of
// validation-error handling, service-error mapping, and structured logging.
function makePlatformRoute({ path, validators, provider, mapBody, extraLog }) {
  router.post(path, validators, async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    try {
      const fnName = 'connect' + provider;
      const row = await publishing[fnName]({ userId: req.user.userId, ...mapBody(req.body) });
      logger.info(`connections.${provider.toLowerCase()}.connected`, {
        userId: req.user.userId,
        connectionId: row.id,
        ...(extraLog ? extraLog(row) : {}),
      });
      res.status(201).json({ connection: row });
    } catch (err) {
      const status = err.status || 500;
      logger.warn(`connections.${provider.toLowerCase()}.failed`, {
        userId: req.user.userId,
        status,
        code: err.code,
        error: err.message,
      });
      res.status(status).json({ error: err.message, code: err.code });
    }
  });
}

makePlatformRoute({
  path: '/webflow',
  validators: [body('apiToken').isString().isLength({ min: 8, max: 500 })],
  provider: 'Webflow',
  mapBody: b => ({ apiToken: b.apiToken }),
  extraLog: r => ({ site_id: r.metadata?.site_id, site_count: r.metadata?.site_count }),
});

makePlatformRoute({
  path: '/wix',
  validators: [
    body('siteId').isString().isLength({ min: 8, max: 200 }),
    body('apiKey').isString().isLength({ min: 8, max: 2000 }),
  ],
  provider: 'Wix',
  mapBody: b => ({ siteId: b.siteId, apiKey: b.apiKey }),
  extraLog: r => ({ site_id: r.metadata?.site_id }),
});

makePlatformRoute({
  path: '/bigcommerce',
  validators: [
    body('storeHash').isString().isLength({ min: 4, max: 100 }),
    body('accessToken').isString().isLength({ min: 8, max: 500 }),
    body('webdavUrl').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 500 }),
    body('webdavUser').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 200 }),
    body('webdavPass').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 500 }),
    body('authorName').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 200 }),
  ],
  provider: 'BigCommerce',
  mapBody: b => ({
    storeHash: b.storeHash,
    accessToken: b.accessToken,
    webdavUrl: b.webdavUrl,
    webdavUser: b.webdavUser,
    webdavPass: b.webdavPass,
    authorName: b.authorName,
  }),
  extraLog: r => ({ store_hash: r.metadata?.store_hash }),
});

makePlatformRoute({
  path: '/hubspot',
  validators: [body('accessToken').isString().isLength({ min: 8, max: 500 })],
  provider: 'HubSpot',
  mapBody: b => ({ accessToken: b.accessToken }),
  extraLog: r => ({ portal_id: r.metadata?.portal_id }),
});

makePlatformRoute({
  path: '/gohighlevel',
  validators: [
    body('token').isString().isLength({ min: 8, max: 500 }),
    body('locationId').isString().isLength({ min: 4, max: 200 }),
  ],
  provider: 'GoHighLevel',
  mapBody: b => ({ token: b.token, locationId: b.locationId }),
  extraLog: r => ({ location_id: r.metadata?.location_id }),
});

makePlatformRoute({
  path: '/duda',
  validators: [
    body('siteName').isString().isLength({ min: 4, max: 200 }),
    body('apiUser').isString().isLength({ min: 2, max: 200 }),
    body('apiPass').isString().isLength({ min: 4, max: 500 }),
  ],
  provider: 'Duda',
  mapBody: b => ({ siteName: b.siteName, apiUser: b.apiUser, apiPass: b.apiPass }),
  extraLog: r => ({ site_name: r.metadata?.site_name, site_domain: r.metadata?.site_domain }),
});

makePlatformRoute({
  path: '/webhook',
  validators: [body('url').isString().isLength({ min: 8, max: 2048 })],
  provider: 'Webhook',
  mapBody: b => ({ url: b.url }),
  extraLog: r => ({ url: r.metadata?.url }),
});

// RSS/JSON Feeds — no body needed, one row per user. The POST is still a
// creation semantically ("please enable feeds for me").
router.post('/rss', async (req, res) => {
  try {
    const row = await publishing.connectRssFeeds({ userId: req.user.userId });
    logger.info('connections.rss.connected', { userId: req.user.userId, connectionId: row.id });
    res.status(201).json({ connection: row });
  } catch (err) {
    logger.warn('connections.rss.failed', { userId: req.user.userId, error: err.message });
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// WordPress step 1 — verify a URL is a WordPress site. Returns
// { ok, url, siteName } so the wizard can advance to step 2 (plugin install).
// Does NOT create a connected_accounts row; the full connect flow lives
// with the plugin (Phase 2).
router.post(
  '/wordpress/verify',
  [body('url').isString().isLength({ min: 3, max: 2048 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    try {
      const result = await publishing.verifyWordPress({ url: req.body.url });
      res.json(result);
    } catch (err) {
      logger.warn('connections.wordpress_verify.failed', { url: req.body.url, error: err.message });
      res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
  }
);

// Re-crawl a website connection's sitemap and refresh its internal_urls
// list. Used by the SEO pipeline as the whitelist for internal links so
// articles can reference the site's real pages instead of skipping links
// entirely.
router.post('/:id/refresh-urls', async (req, res) => {
  try {
    const result = await connections.refreshWebsiteUrls({ userId: req.user.userId, id: req.params.id });
    res.json({ ok: true, count: result.count });
  } catch (err) {
    logger.error('connections.refresh_urls_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: err.message || 'Failed to refresh URLs' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await connections.getForUser(req.user.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Connection not found' });
    await connections.deleteForUser(req.user.userId, req.params.id);
    logger.info('connections.deleted', {
      userId: req.user.userId,
      connectionId: req.params.id,
      provider: existing.provider,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error('connections.delete_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to delete connection' });
  }
});

module.exports = router;
