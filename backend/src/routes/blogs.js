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
  'created_at',
  'updated_at',
].join(', ');

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
