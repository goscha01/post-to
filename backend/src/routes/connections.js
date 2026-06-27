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
