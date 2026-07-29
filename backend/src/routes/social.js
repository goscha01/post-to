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
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const connections = require('../services/connectionsService');
const meta = require('../services/metaService');
const driveRouter = require('./drive');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const router = express.Router();
router.use(authMiddleware);

// Save the ORIGINAL source URL the user submitted alongside the
// provider-returned post ID. Copying that FB/IG post later can then
// re-publish using the Drive URL instead of Meta's fbcdn thumbnail.
// Non-fatal on error — the publish already succeeded.
async function rememberPublishedSource({ userId, provider, providerPostId, sourceUrl }) {
  if (!userId || !providerPostId || !sourceUrl) return;
  const driveFileId = driveRouter.driveFileIdFromUrl(sourceUrl) || null;
  try {
    const { error } = await supabase
      .from('published_media_source')
      .upsert(
        { user_id: userId, provider, provider_post_id: providerPostId, source_url: sourceUrl, drive_file_id: driveFileId },
        { onConflict: 'user_id,provider,provider_post_id' }
      );
    if (error) throw error;
    logger.info('social.source_saved', { user_id: userId, provider, provider_post_id: providerPostId, has_drive_file_id: !!driveFileId });
  } catch (err) {
    logger.warn('social.source_save_failed', { user_id: userId, provider, provider_post_id: providerPostId, error: err.message });
  }
}

// Attach _originalSourceUrl to each post so the frontend "Copy" flow can
// use the raw Drive URL instead of the fbcdn / cdninstagram thumbnail
// the platform returned.
async function attachOriginalSourceUrls({ userId, provider, posts }) {
  if (!posts || posts.length === 0) return posts;
  const ids = posts.map((p) => p.id).filter(Boolean);
  if (ids.length === 0) return posts;
  try {
    const { data, error } = await supabase
      .from('published_media_source')
      .select('provider_post_id, source_url')
      .eq('user_id', userId)
      .eq('provider', provider)
      .in('provider_post_id', ids);
    if (error) throw error;
    const byId = new Map((data || []).map((r) => [r.provider_post_id, r.source_url]));
    return posts.map((p) => (byId.has(p.id) ? { ...p, _originalSourceUrl: byId.get(p.id) } : p));
  } catch (err) {
    logger.warn('social.source_lookup_failed', { user_id: userId, provider, error: err.message });
    return posts;
  }
}

// If imageUrl is a Google Drive URL, rewrite it to our signed public
// proxy URL so Meta fetches the original bytes via our backend (OAuth-
// authenticated read of the Drive file). Sending Meta the raw Drive URL
// either gets them a login-page redirect (private file) or a preview
// thumbnail — that's what was making FB photos come out tiny.
function rewriteDriveImageUrl(rawUrl, req) {
  if (!rawUrl) {
    logger.info('social.rewrite.skipped', { user_id: req.user?.userId, reason: 'no_url' });
    return rawUrl;
  }
  const fileId = driveRouter.driveFileIdFromUrl(rawUrl);
  if (!fileId) {
    // Log the failed match so we can see what URL shape the frontend
    // is actually sending. Truncated so a data-url or malformed input
    // doesn't blow up the log line.
    logger.info('social.rewrite.no_match', {
      user_id: req.user?.userId,
      url_prefix: rawUrl.slice(0, 120),
      url_host: (() => { try { return new URL(rawUrl).hostname; } catch { return null; } })(),
      url_length: rawUrl.length,
    });
    return rawUrl;
  }
  const publicBaseUrl =
    process.env.PUBLIC_BACKEND_URL ||
    process.env.BACKEND_URL ||
    `https://${req.get('host')}`;
  const proxied = driveRouter.buildSignedDriveProxyUrl({
    userId: req.user?.userId,
    fileId,
    baseUrl: publicBaseUrl,
    ttlSeconds: 3600,
  });
  logger.info('social.rewrite.ok', {
    user_id: req.user?.userId,
    file_id: fileId,
    proxied_host: (() => { try { return new URL(proxied).hostname; } catch { return null; } })(),
  });
  return proxied;
}

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
    const enriched = await attachOriginalSourceUrls({ userId: req.user.userId, provider: 'facebook', posts });
    res.json({ posts: enriched });
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
    const enriched = await attachOriginalSourceUrls({ userId: req.user.userId, provider: 'instagram', posts });
    res.json({ posts: enriched });
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

      const rewrittenUrl = rewriteDriveImageUrl(imageUrl, req);
      const result = await meta.publishFacebookPost({
        pageId,
        pageAccessToken,
        message,
        imageUrl: rewrittenUrl,
        link,
      });
      logger.info('social.facebook.published', {
        user_id: req.user.userId,
        connection_id: connectionId,
        page_id: pageId,
        has_image: !!imageUrl,
        image_rewritten: rewrittenUrl !== imageUrl,
        has_link: !!link,
        result_id: result.id,
      });
      if (imageUrl && result?.id) {
        await rememberPublishedSource({
          userId: req.user.userId,
          provider: 'facebook',
          providerPostId: result.id,
          sourceUrl: imageUrl,
        });
      }
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

      const rewrittenUrl = rewriteDriveImageUrl(imageUrl, req);
      const result = await meta.publishInstagramPost({
        igBusinessId,
        pageAccessToken,
        caption,
        imageUrl: rewrittenUrl,
      });
      logger.info('social.instagram.published', {
        user_id: req.user.userId,
        connection_id: connectionId,
        ig_business_id: igBusinessId,
        image_rewritten: rewrittenUrl !== imageUrl,
        result_id: result.id,
        creation_id: result.creation_id,
      });
      if (imageUrl && result?.id) {
        await rememberPublishedSource({
          userId: req.user.userId,
          provider: 'instagram',
          providerPostId: result.id,
          sourceUrl: imageUrl,
        });
      }
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

// Delete a Facebook Page post. connectionId comes in the querystring so
// the same DELETE URL can carry the auth context without a request body.
// Instagram intentionally has NO delete endpoint: Meta Graph API does not
// support programmatic deletion of IG Business media — the docs are
// explicit, users must delete via the Instagram app. Any attempt to
// implement it would 400 on IG's side.
router.delete('/facebook/posts/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    const connectionId = req.query.connectionId;
    if (!postId || !connectionId) {
      return res.status(400).json({ error: 'postId and connectionId required' });
    }
    const row = await connections.getRawForUser(req.user.userId, connectionId);
    if (!row) return res.status(404).json({ error: 'Connection not found' });
    if (row.provider !== 'facebook') return res.status(400).json({ error: 'Not a Facebook connection' });
    const pageAccessToken = row.metadata?.page_access_token;
    if (!pageAccessToken) {
      return res.status(400).json({ error: 'Connection missing Page token — reconnect Facebook' });
    }
    const result = await meta.deleteFacebookPost({ postId, pageAccessToken });
    logger.info('social.facebook.deleted', {
      user_id: req.user.userId,
      connection_id: connectionId,
      post_id: postId,
      result_success: !!result?.success,
    });
    res.json({ ok: true, result });
  } catch (err) {
    const n = meta.normalizeApiError(err);
    logger.error('social.facebook.delete_failed', {
      user_id: req.user.userId,
      post_id: req.params.postId,
      error: n.message,
      code: n.code,
    });
    res.status(n.status).json({ error: n.message, code: n.code, needsReauth: n.needsReauth });
  }
});

module.exports = router;
