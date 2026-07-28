// Social publishing endpoints — thin router over metaService.
//   POST /api/social/facebook/publish     — { connectionId, message, imageUrl?, link? }
//   POST /api/social/instagram/publish    — { connectionId, caption, imageUrl }
//   GET  /api/social/_diagnose            — sanity check: creds present + one token debug
//
// authMiddleware only — no requireBusinessAuth needed. The Page Access Token
// lives on the connected_accounts row (metadata.page_access_token), fetched
// via getRawForUser so the sensitive-field stripper doesn't hide it.

const express = require('express');
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/authMiddleware');
const connections = require('../services/connectionsService');
const meta = require('../services/metaService');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authMiddleware);

router.get('/_diagnose', async (req, res) => {
  const hasAppId = !!process.env.META_APP_ID;
  const hasAppSecret = !!process.env.META_APP_SECRET;
  const hasRedirect = !!process.env.META_REDIRECT_URI;
  const ok = hasAppId && hasAppSecret && hasRedirect;
  res.json({
    ok,
    env: {
      META_APP_ID: hasAppId,
      META_APP_SECRET: hasAppSecret,
      META_REDIRECT_URI: hasRedirect,
    },
    graph_version: meta._internal.GRAPH_VERSION,
  });
});

// Recent posts feeds. Response shape matches the fields the frontend
// Posts.js post card already expects (id, content, media[], createdAt) so no
// per-provider branching is needed in the renderer.
router.get('/facebook/pages/:connectionId/posts', async (req, res) => {
  try {
    const row = await connections.getRawForUser(req.user.userId, req.params.connectionId);
    if (!row) return res.status(404).json({ error: 'Connection not found' });
    if (row.provider !== 'facebook') return res.status(400).json({ error: 'Not a Facebook connection' });
    const pageId = row.metadata?.page_id;
    const pageAccessToken = row.metadata?.page_access_token;
    if (!pageId || !pageAccessToken) return res.status(400).json({ error: 'Reconnect Facebook' });

    const limit = Math.min(Math.max(1, parseInt(req.query.limit || '10', 10)), 50);
    const posts = await meta.getRecentFacebookPosts({ pageId, pageAccessToken, limit });
    res.json({ posts });
  } catch (err) {
    const n = meta.normalizeApiError(err);
    logger.warn('social.facebook.posts_failed', {
      user_id: req.user.userId,
      connection_id: req.params.connectionId,
      error: n.message,
      code: n.code,
      needsReauth: n.needsReauth,
    });
    res.status(n.status).json({ error: n.message, code: n.code, needsReauth: n.needsReauth });
  }
});

router.get('/instagram/:connectionId/media', async (req, res) => {
  try {
    const row = await connections.getRawForUser(req.user.userId, req.params.connectionId);
    if (!row) return res.status(404).json({ error: 'Connection not found' });
    if (row.provider !== 'instagram') return res.status(400).json({ error: 'Not an Instagram connection' });
    const igBusinessId = row.metadata?.ig_business_id;
    const pageAccessToken = row.metadata?.page_access_token;
    if (!igBusinessId || !pageAccessToken) return res.status(400).json({ error: 'Reconnect Facebook' });

    const limit = Math.min(Math.max(1, parseInt(req.query.limit || '10', 10)), 50);
    const posts = await meta.getRecentInstagramMedia({ igBusinessId, pageAccessToken, limit });
    res.json({ posts });
  } catch (err) {
    const n = meta.normalizeApiError(err);
    logger.warn('social.instagram.media_failed', {
      user_id: req.user.userId,
      connection_id: req.params.connectionId,
      error: n.message,
      code: n.code,
      needsReauth: n.needsReauth,
    });
    res.status(n.status).json({ error: n.message, code: n.code, needsReauth: n.needsReauth });
  }
});

router.post(
  '/facebook/publish',
  [
    body('connectionId').isString().isUUID(),
    body('message').optional({ nullable: true }).isString().isLength({ max: 63206 }),
    body('imageUrl').optional({ nullable: true }).isURL({ protocols: ['http', 'https'], require_protocol: true }),
    body('link').optional({ nullable: true }).isURL({ protocols: ['http', 'https'], require_protocol: true }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errors.array() });

    try {
      const { connectionId, message, imageUrl, link } = req.body;
      const row = await connections.getRawForUser(req.user.userId, connectionId);
      if (!row) return res.status(404).json({ error: 'Connection not found' });
      if (row.provider !== 'facebook') return res.status(400).json({ error: 'Not a Facebook connection' });

      const pageId = row.metadata?.page_id;
      const pageAccessToken = row.metadata?.page_access_token;
      if (!pageId || !pageAccessToken) {
        return res.status(400).json({ error: 'Connection is missing Page ID or access token — reconnect Facebook' });
      }
      if (!message && !imageUrl && !link) {
        return res.status(400).json({ error: 'One of message, imageUrl, or link is required' });
      }

      const result = await meta.publishFacebookPost({ pageId, pageAccessToken, message, imageUrl, link });
      logger.info('social.facebook.published', {
        user_id: req.user.userId,
        connection_id: connectionId,
        page_id: pageId,
        has_image: !!imageUrl,
        has_link: !!link,
        result_id: result.id,
      });
      res.status(201).json({ ok: true, result });
    } catch (err) {
      const n = meta.normalizeApiError(err);
      logger.error('social.facebook.publish_failed', {
        user_id: req.user.userId,
        error: n.message,
        code: n.code,
        subcode: n.subcode,
        needsReauth: n.needsReauth,
      });
      res.status(n.status).json({ error: n.message, code: n.code, needsReauth: n.needsReauth });
    }
  }
);

router.post(
  '/instagram/publish',
  [
    body('connectionId').isString().isUUID(),
    body('caption').optional({ nullable: true }).isString().isLength({ max: 2200 }),
    body('imageUrl').isURL({ protocols: ['https'], require_protocol: true })
      .withMessage('imageUrl must be a public HTTPS URL — Meta fetches the image from this URL'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errors.array() });

    try {
      const { connectionId, caption, imageUrl } = req.body;
      const row = await connections.getRawForUser(req.user.userId, connectionId);
      if (!row) return res.status(404).json({ error: 'Connection not found' });
      if (row.provider !== 'instagram') return res.status(400).json({ error: 'Not an Instagram connection' });

      const igBusinessId = row.metadata?.ig_business_id;
      const pageAccessToken = row.metadata?.page_access_token;
      if (!igBusinessId || !pageAccessToken) {
        return res.status(400).json({ error: 'Connection is missing IG business ID or Page token — reconnect Facebook' });
      }

      const result = await meta.publishInstagramPost({ igBusinessId, pageAccessToken, caption, imageUrl });
      logger.info('social.instagram.published', {
        user_id: req.user.userId,
        connection_id: connectionId,
        ig_business_id: igBusinessId,
        result_id: result.id,
        creation_id: result.creation_id,
      });
      res.status(201).json({ ok: true, result });
    } catch (err) {
      const n = meta.normalizeApiError(err);
      logger.error('social.instagram.publish_failed', {
        user_id: req.user.userId,
        error: n.message,
        code: n.code,
        subcode: n.subcode,
        needsReauth: n.needsReauth,
      });
      res.status(n.status).json({ error: n.message, code: n.code, needsReauth: n.needsReauth });
    }
  }
);

module.exports = router;
