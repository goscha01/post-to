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
const seoPipeline = require('../services/seo/articleSeoPipeline');
const seoAnalyzer = require('../services/seo/articleSeoAnalyzer');
const aiContent = require('../services/aiContentService');
const aiJobs = require('../services/aiJobsService');
const connectionsService = require('../services/connectionsService');
const publishDispatcher = require('../services/blogPublishDispatcher');

// Augment a blog row with hero_image_preview_url so the frontend can render
// a thumbnail before the customer's site build has published the image to
// its public /assets/blog/… path. Non-persisted; computed on read via a
// pre-signed S3 URL. Falls back to null if we can't generate one (e.g. no
// S3 domain configured yet).
async function withPreview(userId, blog) {
  if (!blog || !blog.hero_image) return blog;
  const url = await blogHeroImageService.getPreviewUrl({
    userId,
    heroImagePath: blog.hero_image,
  });
  return { ...blog, hero_image_preview_url: url };
}
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
  'hero_alt',
  'hero_image_source_id',
  'visual_search_query',
  'tags',
  'search_intent',
  'suggested_internal_links',
  'image_suggestions',
  'faq',
  'seo_metadata',
  'created_at',
  'updated_at',
].join(', ');

// Load the caller's connection so the analyzer knows which URLs count as
// internal. Silent-fail: an article can be analyzed even without a
// connection — we just skip the internal-link classification.
async function loadConnectionContext(userId, connectionId) {
  if (!connectionId) return { knownInternalUrls: [], internalHostnames: [] };
  try {
    const connection = await connectionsService.getForUser(userId, connectionId);
    if (!connection) return { knownInternalUrls: [], internalHostnames: [] };
    const meta = connection.metadata || {};
    const knownInternalUrls = Array.isArray(meta.internal_urls) ? meta.internal_urls
      : Array.isArray(meta.pages) ? meta.pages
      : Array.isArray(meta.sitemap_urls) ? meta.sitemap_urls
      : [];
    let internalHostnames = [];
    if (meta.url) {
      try {
        const host = new URL(meta.url).hostname.toLowerCase();
        internalHostnames = [host, host.replace(/^www\./, '')];
      } catch { /* ignore */ }
    }
    return { knownInternalUrls, internalHostnames };
  } catch {
    return { knownInternalUrls: [], internalHostnames: [] };
  }
}

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
    // Opportunistic SEO analysis: any read of a row without seo_metadata OR
    // with a stale analyzer_version recomputes on the fly. Analyzer is pure
    // JS and typically completes in a few ms; keeps the frontend simple.
    let blog = data;
    const cached = data.seo_metadata;
    const stale = !cached || cached.analyzerVersion !== seoAnalyzer.SEO_ANALYZER_VERSION;
    if (stale) {
      const ctx = await loadConnectionContext(req.user.userId, data.connection_id);
      const analysis = seoPipeline.analyzeExistingArticle({ article: data, ...ctx });
      // Persist so future reads are pure DB lookups. Best-effort — a save
      // failure doesn't affect the response.
      supabase.from('blog_articles').update({ seo_metadata: analysis })
        .eq('user_id', req.user.userId).eq('id', req.params.id)
        .then(() => {}, () => {});
      blog = { ...data, seo_metadata: analysis };
    }
    res.json({ blog: await withPreview(req.user.userId, blog) });
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
  heroAlt: 'hero_alt',
  keyword: 'keyword',
  tags: 'tags',
  searchIntent: 'search_intent',
  faq: 'faq',
  suggestedInternalLinks: 'suggested_internal_links',
  imageSuggestions: 'image_suggestions',
};

// Any of these editable fields invalidates the cached SEO analysis. When one
// is present in the PATCH we clear seo_metadata so the next GET / analyze
// call recomputes rather than trusting stale numbers.
const SEO_INVALIDATING_FIELDS = new Set([
  'title', 'slug', 'meta_description', 'markdown', 'keyword',
  'hero_image', 'hero_alt', 'tags', 'search_intent',
]);

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
    body('heroAlt').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('keyword').optional().isString().isLength({ max: 255 }),
    body('tags').optional().isArray({ max: 20 }),
    body('tags.*').optional().isString().isLength({ max: 60 }),
    body('searchIntent').optional({ nullable: true }).isString().isLength({ max: 64 }),
    body('faq').optional().isArray({ max: 20 }),
    body('suggestedInternalLinks').optional().isArray({ max: 20 }),
    body('imageSuggestions').optional().isArray({ max: 20 }),
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
    // Invalidate the cached SEO analysis when any analyzer-relevant field
    // changed. The next read (or explicit /seo-analyze) will recompute.
    const invalidates = Object.keys(patch).some((k) => SEO_INVALIDATING_FIELDS.has(k));
    if (invalidates) patch.seo_metadata = null;
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
      logger.info('blogs.updated', { userId: req.user.userId, blogId: req.params.id, fields: Object.keys(patch), seo_invalidated: invalidates });
      res.json({ blog: await withPreview(req.user.userId, data) });
    } catch (err) {
      logger.error('blogs.update_failed', { error: err.message });
      res.status(500).json({ error: 'Failed to update blog' });
    }
  }
);

// On-demand SEO analysis endpoint.
//   POST /api/blogs/:id/seo-analyze
//
// Recomputes the analyzer from the CURRENT row fields. Persists the result
// into seo_metadata so subsequent reads can render immediately. Legacy rows
// without any seo_metadata behave identically here — no backfill needed.
router.post('/:id/seo-analyze', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { data: article, error: loadErr } = await supabase
      .from('blog_articles')
      .select(PUBLIC_FIELDS)
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id)
      .single();
    if (loadErr) {
      if (loadErr.code === 'PGRST116') return res.status(404).json({ error: 'Blog not found' });
      throw loadErr;
    }
    const ctx = await loadConnectionContext(req.user.userId, article.connection_id);
    const analysis = seoPipeline.analyzeExistingArticle({
      article,
      internalHostnames: ctx.internalHostnames,
      knownInternalUrls: ctx.knownInternalUrls,
    });
    const { data: updated, error: updateErr } = await supabase
      .from('blog_articles')
      .update({ seo_metadata: analysis })
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id)
      .select(PUBLIC_FIELDS)
      .single();
    if (updateErr) throw updateErr;
    res.json({ blog: await withPreview(req.user.userId, updated), seo: analysis });
  } catch (err) {
    logger.error('blogs.seo_analyze_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to analyze blog' });
  }
});

// Targeted "Fix with AI" — one check id at a time. Applies a narrow LLM
// transform, saves the resulting fields on the row, and returns the fresh
// SEO analysis. Non-destructive: title/meta/etc. get overwritten only if
// the model returns a different value; the previous value is left in the
// `previous` field in the response so the UI can offer undo.
// Batch SEO fix — user pressed "Fix all" in the drawer. Iterates every
// failing/warning check that has a repair-fixable evaluator and runs the
// same targeted seo-fix logic sequentially. Bounded: at most one repair per
// check, at most `MAX_BATCH_FIXES` total, so the whole call finishes in
// bounded time + cost. Persists per-check fixes so a mid-batch failure
// doesn't lose earlier progress.
const MAX_BATCH_FIXES = 8;

router.post('/:id/seo-fix-all', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { data: article, error: loadErr } = await supabase
      .from('blog_articles')
      .select(PUBLIC_FIELDS)
      .eq('user_id', req.user.userId)
      .eq('id', req.params.id)
      .single();
    if (loadErr) {
      if (loadErr.code === 'PGRST116') return res.status(404).json({ error: 'Blog not found' });
      throw loadErr;
    }
    const ctx = await loadConnectionContext(req.user.userId, article.connection_id);
    let current = article;
    let analysis = seoPipeline.analyzeExistingArticle({ article: current, ...ctx });
    // Pick fixable checks: fails + warnings, excluding hero/image (can't fix
    // via LLM) and slug/tags (structural user choice). Ordered by weight desc
    // so critical items get the first fix budget.
    const excluded = new Set([
      'hero_image_present', 'hero_alt_present', 'hero_alt_quality',
      'image_alt_coverage', 'keyword_in_image_alt',
      'tags_configured', 'slug_seo_friendly', 'slug_present',
    ]);
    const targets = analysis.checks
      .filter((c) => (c.status === 'failed' || c.status === 'warning') && !excluded.has(c.id))
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, MAX_BATCH_FIXES);
    const applied = [];
    for (const check of targets) {
      // Skip if the check is already passing after prior fix in this loop.
      const now = analysis.checks.find((c) => c.id === check.id);
      if (!now || now.status === 'passed') continue;
      try {
        const targeted = { ...analysis, checks: [now] };
        const repair = await aiContent.repairArticle({
          previousJson: {
            title: current.title, slug: current.slug,
            metaDescription: current.meta_description, markdown: current.markdown,
            suggestedExcerpt: current.suggested_excerpt,
            suggestedSocialPost: current.suggested_social_post,
            tags: current.tags || [], searchIntent: current.search_intent || '',
            faq: current.faq || [], imageSuggestions: current.image_suggestions || [],
            suggestedInternalLinks: current.suggested_internal_links || [],
          },
          analysis: targeted,
          keyword: current.keyword,
          businessName: current.business_name,
          knownInternalUrls: ctx.knownInternalUrls,
        });
        const changed = {};
        for (const [k, dbKey] of Object.entries({
          title: 'title', slug: 'slug', metaDescription: 'meta_description',
          markdown: 'markdown', suggestedExcerpt: 'suggested_excerpt',
          suggestedSocialPost: 'suggested_social_post', tags: 'tags',
          searchIntent: 'search_intent', faq: 'faq',
          imageSuggestions: 'image_suggestions',
          suggestedInternalLinks: 'suggested_internal_links',
        })) {
          if (JSON.stringify(repair.data[k]) !== JSON.stringify(current[dbKey])) {
            changed[dbKey] = repair.data[k];
          }
        }
        if (Object.keys(changed).length > 0) {
          changed.seo_metadata = null;
          const { data: updated, error: updateErr } = await supabase
            .from('blog_articles').update(changed)
            .eq('user_id', req.user.userId).eq('id', req.params.id)
            .select(PUBLIC_FIELDS).single();
          if (updateErr) throw updateErr;
          current = updated;
          analysis = seoPipeline.analyzeExistingArticle({ article: current, ...ctx });
          applied.push({ checkId: check.id, changedFields: Object.keys(changed).filter((k) => k !== 'seo_metadata') });
        }
      } catch (e) {
        logger.warn('blogs.seo_fix_all.check_failed', { checkId: check.id, error: e.message });
      }
    }
    // Persist the final analysis one more time so the row's cached
    // seo_metadata reflects the end state.
    await supabase.from('blog_articles').update({ seo_metadata: analysis })
      .eq('user_id', req.user.userId).eq('id', req.params.id);
    logger.info('blogs.seo_fix_all.done', { blogId: req.params.id, applied: applied.length, targets: targets.length });
    res.json({ blog: await withPreview(req.user.userId, current), seo: analysis, applied });
  } catch (err) {
    logger.error('blogs.seo_fix_all_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to run batch SEO fix', message: err.message });
  }
});

router.post(
  '/:id/seo-fix',
  [
    param('id').isUUID(),
    body('checkId').isString().isLength({ min: 1, max: 64 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    try {
      const { data: article, error: loadErr } = await supabase
        .from('blog_articles')
        .select(PUBLIC_FIELDS)
        .eq('user_id', req.user.userId)
        .eq('id', req.params.id)
        .single();
      if (loadErr) {
        if (loadErr.code === 'PGRST116') return res.status(404).json({ error: 'Blog not found' });
        throw loadErr;
      }
      const ctx = await loadConnectionContext(req.user.userId, article.connection_id);
      const analysis = seoPipeline.analyzeExistingArticle({ article, ...ctx });
      const kind = 'article_seo_fix';
      const job = await aiJobs.createJob({
        userId: req.user.userId,
        kind,
        model: process.env.AI_ARTICLE_MODEL || process.env.AI_MODEL || null,
        inputJson: { blogId: article.id, checkId: req.body.checkId },
      });
      try {
        const previousJson = {
          title: article.title,
          slug: article.slug,
          metaDescription: article.meta_description,
          markdown: article.markdown,
          suggestedExcerpt: article.suggested_excerpt,
          suggestedSocialPost: article.suggested_social_post,
          tags: article.tags || [],
          searchIntent: article.search_intent || '',
          faq: article.faq || [],
          imageSuggestions: article.image_suggestions || [],
          suggestedInternalLinks: article.suggested_internal_links || [],
        };
        // The repair prompt handles any subset of failures — narrow it to the
        // one check the user asked about, so only that field changes.
        const targeted = { ...analysis, checks: analysis.checks.filter((c) => c.id === req.body.checkId) };
        const repair = await aiContent.repairArticle({
          previousJson,
          analysis: targeted,
          keyword: article.keyword,
          businessName: article.business_name,
          knownInternalUrls: ctx.knownInternalUrls,
        });
        const changed = {};
        const previous = {};
        for (const [k, dbKey] of Object.entries({
          title: 'title', slug: 'slug', metaDescription: 'meta_description',
          markdown: 'markdown', suggestedExcerpt: 'suggested_excerpt',
          suggestedSocialPost: 'suggested_social_post', tags: 'tags',
          searchIntent: 'search_intent', faq: 'faq',
          imageSuggestions: 'image_suggestions',
          suggestedInternalLinks: 'suggested_internal_links',
        })) {
          if (JSON.stringify(repair.data[k]) !== JSON.stringify(previousJson[k])) {
            changed[dbKey] = repair.data[k];
            previous[dbKey] = previousJson[k];
          }
        }
        if (Object.keys(changed).length === 0) {
          await aiJobs.completeJob(job.id, {
            prompt: repair.prompt, outputJson: repair.data, model: repair.model,
            usage: repair.usage, costUsd: repair.costUsd,
          });
          return res.json({ blog: await withPreview(req.user.userId, article), seo: analysis, changed: {}, previous: {} });
        }
        // Save + re-analyze (invalidate cache).
        changed.seo_metadata = null;
        const { data: updated, error: updateErr } = await supabase
          .from('blog_articles')
          .update(changed)
          .eq('user_id', req.user.userId)
          .eq('id', req.params.id)
          .select(PUBLIC_FIELDS)
          .single();
        if (updateErr) throw updateErr;
        const newAnalysis = seoPipeline.analyzeExistingArticle({ article: updated, ...ctx });
        await supabase.from('blog_articles').update({ seo_metadata: newAnalysis })
          .eq('user_id', req.user.userId).eq('id', req.params.id);
        await aiJobs.completeJob(job.id, {
          prompt: repair.prompt, outputJson: repair.data, model: repair.model,
          usage: repair.usage, costUsd: repair.costUsd,
          resultTable: 'blog_articles', resultId: updated.id,
        });
        return res.json({
          blog: await withPreview(req.user.userId, { ...updated, seo_metadata: newAnalysis }),
          seo: newAnalysis,
          changed,
          previous,
        });
      } catch (err) {
        await aiJobs.failJob(job.id, err.message);
        throw err;
      }
    } catch (err) {
      logger.error('blogs.seo_fix_failed', { error: err.message, id: req.params.id, checkId: req.body.checkId });
      res.status(500).json({ error: 'Failed to apply SEO fix', message: err.message });
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
      blog: await withPreview(req.user.userId, updated),
      urls,
      hasVerifiedDomain: verifiedDomains.length > 0,
      deployHints,
    });
  } catch (err) {
    logger.error('blogs.publish_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to publish blog' });
  }
});

// ---------------------------------------------------------------------------
// Publishing Platform fan-out (Phase 2). Independent from the S3/hosted
// publish above — customers may push the same article to their WordPress /
// Webflow / Wix / etc. via connected_accounts. Each target tracked in
// blog_publish_targets, dispatched by services/blogPublishDispatcher.js.
// ---------------------------------------------------------------------------

router.post(
  '/:id/publish-to',
  [
    param('id').isUUID(),
    body('connectionIds').isArray({ min: 1 }),
    body('connectionIds.*').isUUID(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    try {
      const out = await publishDispatcher.dispatch({
        userId: req.user.userId,
        articleId: req.params.id,
        connectionIds: req.body.connectionIds,
      });
      const ok = out.results.filter(r => r.ok).length;
      const failed = out.results.length - ok;
      logger.info('blogs.publish_to.dispatched', { userId: req.user.userId, articleId: req.params.id, ok, failed });
      res.json(out);
    } catch (err) {
      logger.error('blogs.publish_to.failed', { error: err.message, id: req.params.id });
      res.status(500).json({ error: err.message || 'Failed to publish to targets' });
    }
  }
);

router.get('/:id/publish-targets', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const targets = await publishDispatcher.listForArticle({
      userId: req.user.userId,
      articleId: req.params.id,
    });
    res.json({ targets });
  } catch (err) {
    logger.error('blogs.publish_targets.list_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to list publish targets' });
  }
});

router.post(
  '/:id/publish-targets/:targetId/retry',
  [param('id').isUUID(), param('targetId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
    try {
      const result = await publishDispatcher.retryTarget({
        userId: req.user.userId,
        targetId: req.params.targetId,
      });
      res.json({ result });
    } catch (err) {
      logger.error('blogs.publish_target.retry_failed', { error: err.message });
      res.status(500).json({ error: err.message || 'Failed to retry publish' });
    }
  }
);

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
    res.json({ blog: await withPreview(req.user.userId, data), removals });
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
      res.json({ blog: await withPreview(req.user.userId, updated) });
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
    // updated.hero_image is null after remove — withPreview short-circuits.
    res.json({ blog: updated });
  } catch (err) {
    logger.error('blogs.hero_remove_failed', { error: err.message, id: req.params.id });
    res.status(err.status || 500).json({ error: err.message || 'Failed to remove hero image' });
  }
});

// Suggest hero-image candidates from Pexels.
//
// Query resolution (first available wins):
//   1. explicit ?q= (user typed one in the UI's search box)
//   2. blog.visual_search_query (cached AI-generated visual terms — populated
//      lazily by this endpoint on first call for the article)
//   3. AI-generated on-the-fly using title + excerpt (cached back onto the row)
//   4. blog.keyword (SEO term — usually wrong for visual results but a safe
//      last resort)
//   5. blog.title
//
// Dedup: collects hero_image_source_id from every other blog_articles row
// for this user and passes them to searchPexels() as excludeIds. Photos the
// user has ever picked are filtered out of the results.
router.get('/:id/suggest-hero-images', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { data: blog, error: loadErr } = await supabase
      .from('blog_articles')
      .select('id, keyword, title, meta_description, suggested_excerpt, visual_search_query')
      .eq('user_id', req.user.userId).eq('id', req.params.id).single();
    if (loadErr || !blog) return res.status(404).json({ error: 'Blog not found' });

    let query = String(req.query.q || '').trim();
    let generated = false;

    if (!query) {
      // Prefer cached visual query on the row.
      if (blog.visual_search_query && blog.visual_search_query.trim()) {
        query = blog.visual_search_query.trim();
      } else {
        // Generate + cache. Falls back to keyword/title if OpenAI is
        // unavailable — better a mediocre search than a 500.
        const excerpt = blog.suggested_excerpt || blog.meta_description || '';
        const generatedQuery = await stockImageService.generateVisualQuery({
          title: blog.title || '',
          excerpt,
        });
        if (generatedQuery) {
          query = generatedQuery;
          generated = true;
          // Persist so we don't re-call OpenAI on every modal-open. Non-fatal
          // if the write fails (query still works for this call).
          await supabase.from('blog_articles')
            .update({ visual_search_query: generatedQuery })
            .eq('id', blog.id).eq('user_id', req.user.userId)
            .then(() => {}, () => {});
        } else {
          query = String(blog.keyword || blog.title || '').trim();
        }
      }
    }
    if (!query) return res.status(400).json({ error: 'No query available — pass ?q=…' });

    // Gather source_ids already used by this user's other articles, so we
    // don't recommend the same photo twice. Only rows that HAVE an id
    // (i.e. picked from a suggest flow) count — manual uploads don't need
    // deduping.
    const { data: usedRows } = await supabase.from('blog_articles')
      .select('hero_image_source_id')
      .eq('user_id', req.user.userId)
      .not('hero_image_source_id', 'is', null);
    const excludeIds = (usedRows || [])
      .map(r => r.hero_image_source_id)
      .filter(Boolean);

    const photos = await stockImageService.searchPexels(query, { excludeIds });
    res.json({ query, photos, generated, excludedCount: excludeIds.length });
  } catch (err) {
    logger.warn('blogs.hero_suggest_failed', { error: err.message, id: req.params.id });
    res.status(err.status || 500).json({ error: err.message || 'Suggestion failed' });
  }
});

// Set the hero image from a picked candidate URL. Server-side downloads the
// image bytes (so the image lands on the customer's own S3 — no hotlinking)
// then goes through the same upload pipeline as a manual file upload.
// Also persists sourceId (e.g. "pexels:12345") when provided so future
// suggest calls can dedupe it out of results.
router.post(
  '/:id/hero-image/from-url',
  [
    param('id').isUUID(),
    body('url').isString().isURL({ require_protocol: true }).isLength({ max: 2048 }),
    body('sourceId').optional().isString().isLength({ max: 128 }),
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
      // Non-fatal: dedup breaks a bit if this fails but the image itself is
      // already on S3 and the row's hero_image is set.
      if (req.body.sourceId) {
        await supabase.from('blog_articles')
          .update({ hero_image_source_id: req.body.sourceId })
          .eq('id', req.params.id).eq('user_id', req.user.userId)
          .then(() => {}, (e) => logger.warn('blogs.hero.source_id_save_failed', { error: e.message }));
      }
      res.json({ blog: await withPreview(req.user.userId, updated) });
    } catch (err) {
      logger.error('blogs.hero_from_url_failed', { error: err.message, id: req.params.id });
      res.status(err.status || 500).json({ error: err.message || 'Failed to download / upload' });
    }
  }
);

module.exports = router;
