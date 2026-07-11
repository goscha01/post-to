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
const logger = require('../utils/logger');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
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
