// Blog CRUD routes for the in-app editor.
//   GET    /api/blogs                 → list (optional ?connectionId, ?status, ?limit)
//   GET    /api/blogs/:id             → single blog
//   PATCH  /api/blogs/:id             → update title/slug/meta/markdown/status
//   DELETE /api/blogs/:id             → delete
//
// Generation lives on POST /api/ai/articles — this router only manages
// existing rows.

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const blogDomainsService = require('../services/blogDomainsService');
const blogPublisherS3 = require('../services/blogPublisherS3');
const blogDeployTrigger = require('../services/blogDeployTrigger');

const router = express.Router();

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

    // Remove from any S3 destinations too, so a rebuild doesn't republish
    // the unpublished article. Best-effort per domain — failures are logged
    // but don't fail the request.
    const domains = await blogDomainsService.listForUser(req.user.userId);
    for (const d of domains) {
      if (d.metadata?.publish_target !== 's3') continue;
      try {
        const raw = await blogDomainsService.getForUser({ userId: req.user.userId, id: d.id });
        await blogPublisherS3.unpublish({ blog: data, domain: raw });
      } catch (e) {
        logger.warn('blogs.unpublish.s3_cleanup_failed', { userId: req.user.userId, domainId: d.id, error: e.message });
      }
    }

    logger.info('blogs.unpublished', { userId: req.user.userId, blogId: req.params.id });
    res.json({ blog: data });
  } catch (err) {
    logger.error('blogs.unpublish_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to unpublish blog' });
  }
});

router.delete('/:id', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { error } = await supabase
      .from('blog_articles')
      .delete()
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id);
    if (error) throw error;
    logger.info('blogs.deleted', { userId: req.user.userId, blogId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    logger.error('blogs.delete_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to delete blog' });
  }
});

module.exports = router;
