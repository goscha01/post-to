// Blog CRUD routes for the in-app editor.
//   GET    /api/blogs                 → list (optional ?connectionId, ?status, ?limit)
//   GET    /api/blogs/:id             → single blog
//   PATCH  /api/blogs/:id             → update title/slug/meta/markdown/status
//   DELETE /api/blogs/:id             → delete
//
// Generation lives on POST /api/ai/articles — this router only manages
// existing rows.

const express = require('express');
const multer = require('multer');
const { body, param, query, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const blogDomainsService = require('../services/blogDomainsService');
const blogPublisherS3 = require('../services/blogPublisherS3');
const blogDeployTrigger = require('../services/blogDeployTrigger');
const blogHeroImageService = require('../services/blogHeroImageService');
const stockImageService = require('../services/stockImageService');

const router = express.Router();

// Multer config for hero image uploads — same pattern as posts.js. In-memory
// buffer, image-only, 10MB cap.
const heroUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);

const PUBLIC_FIELDS = [
  'id',
  'user_id',
  'connection_id',
  'business_profile_id',
  'business_name',
  'business_type',
  'service',
  'city',
  'keyword',
  'title',
  'slug',
  'meta_description',
  'markdown',
  'suggested_excerpt',
  'suggested_social_post',
  'status',
  'published_at',
  'hero_image',
  'created_at',
  'updated_at',
].join(', ');

// ============================================================================
// Blog domains (custom subdomains that serve published articles)
// Mounted BEFORE the /:id routes so /domains isn't shadowed by UUID matching.
// ============================================================================

router.get('/domains', async (req, res) => {
  try {
    const rows = await blogDomainsService.listForUser(req.user.userId);
    res.json({ domains: rows, cnameTarget: blogDomainsService.BLOG_CNAME_TARGET });
  } catch (err) {
    logger.error('blogs.domains.list_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to list blog domains' });
  }
});

router.post(
  '/domains',
  [
    body('hostname').isString().isLength({ min: 4, max: 253 }),
    body('siteName').optional().isString().isLength({ max: 255 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    try {
      const row = await blogDomainsService.createDomain({
        userId: req.user.userId,
        hostname: req.body.hostname,
        siteName: req.body.siteName,
      });
      res.status(201).json({ domain: row, cnameTarget: blogDomainsService.BLOG_CNAME_TARGET });
    } catch (err) {
      logger.error('blogs.domains.create_failed', { error: err.message });
      res.status(err.status || 500).json({ error: err.message || 'Failed to create blog domain' });
    }
  }
);

router.post('/domains/:id/verify', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const row = await blogDomainsService.verifyDomain({ userId: req.user.userId, id: req.params.id });
    res.json({ domain: row });
  } catch (err) {
    logger.warn('blogs.domains.verify_failed', { error: err.message, id: req.params.id });
    // Include `domain` in the 400 response so frontend can update the row
    // with the corrected per-domain cname_target Railway returned to us.
    res.status(err.status || 500).json({
      error: err.message || 'Verification failed',
      details: err.details,
      domain: err.domain,
    });
  }
});

router.delete('/domains/:id', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    await blogDomainsService.deleteDomain({ userId: req.user.userId, id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    logger.error('blogs.domains.delete_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to delete blog domain' });
  }
});

// Re-scrape the linked main site for theme signals (primary color, fonts,
// logo). Used to backfill existing domains + let users refresh after a
// redesign.
router.post('/domains/:id/refresh-theme', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const row = await blogDomainsService.refreshTheme({ userId: req.user.userId, id: req.params.id });
    res.json({ domain: row });
  } catch (err) {
    logger.error('blogs.domains.refresh_theme_failed', { error: err.message, id: req.params.id });
    res.status(err.status || 500).json({ error: err.message || 'Failed to refresh theme' });
  }
});

// Manual theme override. Accepts { primaryColor, fontFamily, fontsUrl,
// logoUrl }. Any field omitted is left as-is. Pass null / '' to clear a
// field (falls back to renderer default).
router.patch(
  '/domains/:id/theme',
  [
    param('id').isUUID(),
    body('primaryColor').optional({ nullable: true }).isString().isLength({ max: 32 }),
    body('fontFamily').optional({ nullable: true }).isString().isLength({ max: 128 }),
    body('fontsUrl').optional({ nullable: true }).isString().isLength({ max: 1024 }),
    body('logoUrl').optional({ nullable: true }).isString().isLength({ max: 1024 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    try {
      const row = await blogDomainsService.updateTheme({
        userId: req.user.userId,
        id: req.params.id,
        patch: req.body,
      });
      res.json({ domain: row });
    } catch (err) {
      logger.error('blogs.domains.update_theme_failed', { error: err.message, id: req.params.id });
      res.status(err.status || 500).json({ error: err.message || 'Failed to update theme' });
    }
  }
);

router.get(
  '/',
  [
    query('connectionId').optional().isUUID(),
    query('status').optional().isIn(['draft', 'published', 'failed']),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    try {
      let q = supabase
        .from('blog_articles')
        .select(PUBLIC_FIELDS)
        .eq('user_id', req.user.userId)
        .order('created_at', { ascending: false })
        .limit(req.query.limit || 100);
      if (req.query.connectionId) q = q.eq('connection_id', req.query.connectionId);
      if (req.query.status) q = q.eq('status', req.query.status);
      const { data, error } = await q;
      if (error) throw error;
      res.json({ blogs: data || [] });
    } catch (err) {
      logger.error('blogs.list_failed', { error: err.message });
      res.status(500).json({ error: 'Failed to list blogs' });
    }
  }
);

router.get('/:id', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { data, error } = await supabase
      .from('blog_articles')
      .select(PUBLIC_FIELDS)
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id)
      .single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Blog not found' });
      throw error;
    }
    res.json({ blog: data });
  } catch (err) {
    logger.error('blogs.get_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to load blog' });
  }
});

const EDITABLE_FIELDS_MAP = {
  title: 'title',
  slug: 'slug',
  metaDescription: 'meta_description',
  markdown: 'markdown',
  suggestedExcerpt: 'suggested_excerpt',
  suggestedSocialPost: 'suggested_social_post',
  status: 'status',
  heroImage: 'hero_image',
};

router.patch(
  '/:id',
  [
    param('id').isUUID(),
    body('title').optional().isString().isLength({ max: 1000 }),
    body('slug').optional().isString().isLength({ max: 512 }),
    body('metaDescription').optional().isString().isLength({ max: 2000 }),
    body('markdown').optional().isString().isLength({ max: 200000 }),
    body('suggestedExcerpt').optional().isString().isLength({ max: 4000 }),
    body('suggestedSocialPost').optional().isString().isLength({ max: 4000 }),
    body('status').optional().isIn(['draft', 'published', 'failed']),
    body('heroImage').optional({ nullable: true }).isString().isLength({ max: 1024 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    const patch = {};
    for (const [bodyKey, dbKey] of Object.entries(EDITABLE_FIELDS_MAP)) {
      if (Object.prototype.hasOwnProperty.call(req.body, bodyKey)) {
        patch[dbKey] = req.body[bodyKey];
      }
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No editable fields provided' });
    }
    try {
      const { data, error } = await supabase
        .from('blog_articles')
        .update(patch)
        .eq('user_id', req.user.userId)
        .eq('id', req.params.id)
        .select(PUBLIC_FIELDS)
        .single();
      if (error) {
        if (error.code === 'PGRST116') return res.status(404).json({ error: 'Blog not found' });
        throw error;
      }
      logger.info('blogs.updated', { userId: req.user.userId, blogId: req.params.id, fields: Object.keys(patch) });
      res.json({ blog: data });
    } catch (err) {
      logger.error('blogs.update_failed', { error: err.message });
      res.status(500).json({ error: 'Failed to update blog' });
    }
  }
);

// Publish routing:
//   publish_target = 's3' (default for customers who own their site)
//     → write markdown to the customer's S3 bucket via blogPublisherS3.
//       Article lives on their main domain (e.g. www.spotless.homes/blog/…)
//       after their site's build pipeline syncs from S3 and rebuilds.
//   publish_target = 'hosted' (or unset)
//     → legacy path: just flip status='published' and let post-to-blogs
//       Vercel render the article on the user's custom subdomain.
//
// Returns urls[] the customer can share, plus a `deployHint` when they need
// to manually rebuild their site to make the article public.
router.post('/:id/publish', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { data: blog, error: loadErr } = await supabase
      .from('blog_articles')
      .select(PUBLIC_FIELDS)
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id)
      .single();
    if (loadErr) {
      if (loadErr.code === 'PGRST116') return res.status(404).json({ error: 'Blog not found' });
      throw loadErr;
    }
    if (!blog.slug || !blog.title) {
      return res.status(400).json({ error: 'Blog needs a slug and title before publishing' });
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .from('blog_articles')
      .update({ status: 'published', published_at: now })
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id)
      .select(PUBLIC_FIELDS)
      .single();
    if (updateErr) throw updateErr;

    // Route by publish_target on each verified domain. A blog with N verified
    // domains can publish to N destinations in the same call.
    const domainsRaw = await Promise.all(
      // use getForUser to keep sensitive S3 secret available for the publish call
      (await blogDomainsService.listForUser(req.user.userId)).map(async d => {
        if (!(d.status === 'active' && d.metadata?.verified && d.metadata?.hostname)) return null;
        // Need raw metadata (including s3_access_key_secret) for S3 publish.
        return blogDomainsService.getForUser({ userId: req.user.userId, id: d.id });
      })
    );
    const verifiedDomains = domainsRaw.filter(Boolean);

    const urls = [];
    const deployHints = [];
    let hasS3 = false;
    for (const domain of verifiedDomains) {
      const target = domain.metadata?.publish_target || 'hosted';
      const host = domain.metadata?.hostname;
      if (target === 's3') {
        hasS3 = true;
        try {
          await blogPublisherS3.publish({ blog: updated, domain });
          const publicHost = (domain.metadata?.public_hostname
            || (host.startsWith('blog.') ? host.slice(5) : host));
          const wwwHost = publicHost.startsWith('www.') ? publicHost : `www.${publicHost}`;
          const pattern = domain.metadata?.public_url_pattern || `https://${wwwHost}/blog/{slug}`;
          urls.push(pattern.replace('{slug}', updated.slug));

          // Fire the configured deploy trigger (e.g. GitHub repository_dispatch).
          // Best-effort — publish already succeeded, so trigger failure just
          // means the customer will run their deploy manually.
          const dep = await blogDeployTrigger.trigger({ domain, blog: updated });
          if (dep.ok) {
            deployHints.push({
              host,
              hint: `Article uploaded to S3. Auto-deploy fired via ${dep.provider} — should be live within a couple minutes.`,
              autoDeployed: true,
            });
          } else {
            deployHints.push({
              host,
              hint: 'Article uploaded to S3. Run your site build to publish it live.',
              autoDeployed: false,
              reason: dep.reason || dep.error,
            });
          }
        } catch (e) {
          logger.error('blogs.publish.s3_failed', { userId: req.user.userId, host, error: e.message });
          deployHints.push({ host, hint: `S3 publish failed: ${e.message}` });
        }
      } else {
        // hosted (post-to-blogs Vercel subdomain renderer)
        urls.push(`https://${host}/${updated.slug}`);
      }
    }

    logger.info('blogs.published', {
      userId: req.user.userId,
      blogId: req.params.id,
      slug: updated.slug,
      domainCount: verifiedDomains.length,
      hasS3,
    });
    res.json({
      blog: updated,
      urls,
      hasVerifiedDomain: verifiedDomains.length > 0,
      deployHints,
    });
  } catch (err) {
    logger.error('blogs.publish_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to publish blog' });
  }
});

// Fan out an "article no longer exists" event to every S3-publishing domain:
//   1. Delete posts/<date>-<slug>.md so the customer's next build won't
//      include it
//   2. Delete the hero image (if any) so orphan bytes don't accumulate
//   3. Fire deploy trigger so the customer's site actually rebuilds and
//      the article disappears from the live site (otherwise it stays live
//      until an unrelated build fires)
//
// Best-effort — any per-domain failure is logged, doesn't fail the caller.
// Callers pass the blog row (post-DB-change) so we know slug + hero_image.
async function fanoutRemoval({ userId, blog }) {
  const results = [];
  const domains = await blogDomainsService.listForUser(userId);
  for (const d of domains) {
    if (d.metadata?.publish_target !== 's3') continue;
    const raw = await blogDomainsService.getForUser({ userId, id: d.id }).catch(() => null);
    if (!raw) continue;

    try { await blogPublisherS3.unpublish({ blog, domain: raw }); }
    catch (e) { logger.warn('blogs.removal.md_delete_failed', { userId, domainId: d.id, error: e.message }); }

    // Delete hero image object too, if the row still points at one.
    if (blog.hero_image) {
      try {
        const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
        const client = new S3Client({
          region: raw.metadata.s3_region,
          credentials: {
            accessKeyId: raw.metadata.s3_access_key_id,
            secretAccessKey: raw.metadata.s3_access_key_secret,
          },
        });
        await client.send(new DeleteObjectCommand({
          Bucket: raw.metadata.s3_bucket,
          Key: blog.hero_image.replace(/^\/+/, ''),
        }));
      } catch (e) {
        logger.warn('blogs.removal.hero_delete_failed', { userId, domainId: d.id, error: e.message });
      }
    }

    const dep = await blogDeployTrigger.trigger({ domain: raw, blog });
    results.push({ host: raw.metadata?.hostname, autoDeployed: !!dep.ok, reason: dep.reason || dep.error });
  }
  return results;
}

router.post('/:id/unpublish', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { data, error } = await supabase
      .from('blog_articles')
      .update({ status: 'draft' })
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id)
      .select(PUBLIC_FIELDS)
      .single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Blog not found' });
      throw error;
    }

    const removals = await fanoutRemoval({ userId: req.user.userId, blog: data });
    logger.info('blogs.unpublished', { userId: req.user.userId, blogId: req.params.id, removedFrom: removals.length });
    res.json({ blog: data, removals });
  } catch (err) {
    logger.error('blogs.unpublish_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to unpublish blog' });
  }
});

router.delete('/:id', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    // Load the row first so fanoutRemoval knows slug + hero_image before we
    // drop the DB row.
    const { data: blog, error: loadErr } = await supabase
      .from('blog_articles')
      .select(PUBLIC_FIELDS)
      .eq('user_id', req.user.userId).eq('id', req.params.id).single();
    if (loadErr) {
      if (loadErr.code === 'PGRST116') return res.status(404).json({ error: 'Blog not found' });
      throw loadErr;
    }

    let removals = [];
    if (blog.status === 'published' || blog.hero_image) {
      // Only pay the fanout cost if there's something to remove out there.
      removals = await fanoutRemoval({ userId: req.user.userId, blog });
    }

    const { error } = await supabase
      .from('blog_articles')
      .delete()
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id);
    if (error) throw error;

    logger.info('blogs.deleted', { userId: req.user.userId, blogId: req.params.id, removedFrom: removals.length });
    res.json({ ok: true, removals });
  } catch (err) {
    logger.error('blogs.delete_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to delete blog' });
  }
});

// Hero image endpoints. Uploads land in the customer's S3 bucket under
// assets/blog/<slug>-hero.<ext>; the site's build syncs the assets/ prefix
// into public/assets/ so the image bundles into dist/ and ends up on their
// domain at /assets/blog/<slug>-hero.<ext>.
router.post(
  '/:id/hero-image',
  [param('id').isUUID()],
  heroUpload.single('image'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
    try {
      const updated = await blogHeroImageService.upload({
        userId: req.user.userId,
        blogId: req.params.id,
        file: req.file,
      });
      res.json({ blog: updated });
    } catch (err) {
      logger.error('blogs.hero_upload_failed', { error: err.message, id: req.params.id });
      res.status(err.status || 500).json({ error: err.message || 'Failed to upload hero image' });
    }
  }
);

router.delete('/:id/hero-image', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const updated = await blogHeroImageService.remove({
      userId: req.user.userId,
      blogId: req.params.id,
    });
    res.json({ blog: updated });
  } catch (err) {
    logger.error('blogs.hero_remove_failed', { error: err.message, id: req.params.id });
    res.status(err.status || 500).json({ error: err.message || 'Failed to remove hero image' });
  }
});

// Suggest hero-image candidates from Pexels. Query defaults to the blog's
// keyword (from GSC-driven generation) → title → user-supplied override
// via ?q=. Returns up to 9 landscape candidates the UI displays as a grid.
router.get('/:id/suggest-hero-images', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { data: blog, error: loadErr } = await supabase
      .from('blog_articles')
      .select('id, keyword, title')
      .eq('user_id', req.user.userId).eq('id', req.params.id).single();
    if (loadErr || !blog) return res.status(404).json({ error: 'Blog not found' });

    const query = String(req.query.q || blog.keyword || blog.title || '').trim();
    if (!query) return res.status(400).json({ error: 'No query available — pass ?q=…' });

    const photos = await stockImageService.searchPexels(query);
    res.json({ query, photos });
  } catch (err) {
    logger.warn('blogs.hero_suggest_failed', { error: err.message, id: req.params.id });
    res.status(err.status || 500).json({ error: err.message || 'Suggestion failed' });
  }
});

// Set the hero image from a picked candidate URL. Server-side downloads the
// image bytes (so the image lands on the customer's own S3 — no hotlinking)
// then goes through the same upload pipeline as a manual file upload.
router.post(
  '/:id/hero-image/from-url',
  [
    param('id').isUUID(),
    body('url').isString().isURL({ require_protocol: true }).isLength({ max: 2048 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    try {
      const { buffer, contentType, bytes } = await stockImageService.downloadImage(req.body.url);
      const updated = await blogHeroImageService.uploadFromBuffer({
        userId: req.user.userId,
        blogId: req.params.id,
        buffer,
        contentType,
        bytes,
      });
      res.json({ blog: updated });
    } catch (err) {
      logger.error('blogs.hero_from_url_failed', { error: err.message, id: req.params.id });
      res.status(err.status || 500).json({ error: err.message || 'Failed to download / upload' });
    }
  }
);

module.exports = router;
