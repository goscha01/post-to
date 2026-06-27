// AI generation routes.
//   POST /api/ai/articles      → generate blog article draft
//   POST /api/ai/review-post   → generate social/GMB post draft from review input
//
// Both routes require user auth (authMiddleware). They do NOT require business
// auth, because article generation has nothing to do with GMB access and the
// review-post route can accept review fields directly.

const express = require('express');
const { body, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const aiContent = require('../services/aiContentService');
const aiJobs = require('../services/aiJobsService');
const connectionsService = require('../services/connectionsService');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// Article generation
// ---------------------------------------------------------------------------
router.post(
  '/articles',
  [
    body('businessName').optional().isString().isLength({ max: 255 }),
    body('businessType').optional().isString().isLength({ max: 255 }),
    body('service').optional().isString().isLength({ max: 255 }),
    body('city').optional().isString().isLength({ max: 255 }),
    body('keyword').isString().isLength({ min: 2, max: 255 }),
    body('tone').optional().isString().isLength({ max: 255 }),
    body('targetAudience').optional().isString().isLength({ max: 255 }),
    body('businessProfileId').optional().isUUID(),
    body('connectionId').optional().isUUID()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }

    const userId = req.user.userId;
    const kind = 'article_generation';

    // Cap check.
    const used = await aiJobs.countTodayByKind(userId, kind);
    const cap = aiJobs.dailyCapFor(kind);
    if (used >= cap) {
      return res.status(429).json({
        error: 'Daily AI article generation limit reached',
        used,
        cap
      });
    }

    // If a connectionId is provided, pull display_name + metadata as defaults.
    // Body values still win — connectionId only fills in what the caller omitted.
    let connection = null;
    if (req.body.connectionId) {
      connection = await connectionsService.getForUser(userId, req.body.connectionId);
      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }
    }

    const connBusinessName = connection?.display_name || null;
    const connDescription = connection?.metadata?.description || null;

    const input = {
      businessName: req.body.businessName || connBusinessName || 'Spotless Homes',
      businessType: req.body.businessType || (connDescription ? connDescription.slice(0, 200) : 'residential cleaning company'),
      service: req.body.service || 'recurring cleaning',
      city: req.body.city || 'Tampa',
      keyword: req.body.keyword,
      tone: req.body.tone || 'helpful, local, professional',
      targetAudience: req.body.targetAudience || 'homeowners and renters in Florida'
    };

    let job;
    try {
      job = await aiJobs.createJob({ userId, kind, model: process.env.AI_MODEL || null, inputJson: input });
    } catch (e) {
      console.error('createJob failed:', e.message);
      return res.status(500).json({ error: 'Could not create AI job' });
    }

    try {
      const result = await aiContent.generateArticle(input);
      const ai = result.data;

      const slug = slugify(ai.slug || ai.title);

      const { data: article, error: insertErr } = await supabase
        .from('blog_articles')
        .insert({
          user_id: userId,
          business_profile_id: req.body.businessProfileId || null,
          business_name: input.businessName,
          business_type: input.businessType,
          service: input.service,
          city: input.city,
          keyword: input.keyword,
          title: ai.title,
          slug,
          meta_description: ai.metaDescription,
          markdown: ai.markdown,
          suggested_excerpt: ai.suggestedExcerpt,
          suggested_social_post: ai.suggestedSocialPost,
          status: 'draft'
        })
        .select()
        .single();

      if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`);

      await aiJobs.completeJob(job.id, {
        prompt: result.prompt,
        outputJson: ai,
        model: result.model,
        usage: result.usage,
        costUsd: result.costUsd,
        resultTable: 'blog_articles',
        resultId: article.id
      });

      return res.status(201).json({
        id: article.id,
        jobId: job.id,
        title: article.title,
        slug: article.slug,
        metaDescription: article.meta_description,
        markdown: article.markdown,
        suggestedExcerpt: article.suggested_excerpt,
        suggestedSocialPost: article.suggested_social_post,
        status: article.status
      });
    } catch (err) {
      console.error('article generation failed:', err.message);
      await aiJobs.failJob(job.id, err.message);
      return res.status(502).json({ error: 'AI article generation failed', message: err.message, jobId: job.id });
    }
  }
);

// ---------------------------------------------------------------------------
// Review-post generation (input-based, no DB lookup required).
// For the reviewId-based variant, reviews.js calls generateReviewPostHandler.
// ---------------------------------------------------------------------------
async function generateReviewPostHandler(req, res, options = {}) {
  const userId = req.user.userId;
  const kind = 'review_post_generation';

  const used = await aiJobs.countTodayByKind(userId, kind);
  const cap = aiJobs.dailyCapFor(kind);
  if (used >= cap) {
    return res.status(429).json({
      error: 'Daily AI review-post generation limit reached',
      used,
      cap
    });
  }

  const input = {
    businessName: req.body.businessName || 'Spotless Homes',
    businessType: req.body.businessType || 'residential cleaning company',
    city: req.body.city || '',
    reviewText: req.body.reviewText || '',
    reviewRating: req.body.reviewRating ?? null,
    reviewerName: req.body.reviewerName || '',
    platform: req.body.platform || 'google',
    tone: req.body.tone || 'warm, grateful, professional'
  };

  const sourceType = options.sourceType || 'review';
  const sourceId = options.sourceId || req.body.reviewId || null;

  let job;
  try {
    job = await aiJobs.createJob({
      userId,
      kind,
      model: process.env.AI_MODEL || null,
      inputJson: { ...input, sourceType, sourceId }
    });
  } catch (e) {
    console.error('createJob failed:', e.message);
    return res.status(500).json({ error: 'Could not create AI job' });
  }

  try {
    const result = await aiContent.generateReviewPost(input);
    const ai = result.data;

    const { data: post, error: insertErr } = await supabase
      .from('ai_generated_posts')
      .insert({
        user_id: userId,
        source_type: sourceType,
        source_id: sourceId ? String(sourceId) : null,
        business_name: input.businessName,
        platform_target: 'gmb',
        caption: ai.caption,
        short_caption: ai.shortCaption,
        google_business_post: ai.googleBusinessPost,
        hashtags: ai.hashtags,
        status: 'draft'
      })
      .select()
      .single();

    if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`);

    await aiJobs.completeJob(job.id, {
      prompt: result.prompt,
      outputJson: ai,
      model: result.model,
      usage: result.usage,
      costUsd: result.costUsd,
      resultTable: 'ai_generated_posts',
      resultId: post.id
    });

    return res.status(201).json({
      id: post.id,
      jobId: job.id,
      caption: post.caption,
      shortCaption: post.short_caption,
      googleBusinessPost: post.google_business_post,
      hashtags: post.hashtags,
      status: post.status
    });
  } catch (err) {
    console.error('review-post generation failed:', err.message);
    await aiJobs.failJob(job.id, err.message);
    return res.status(502).json({ error: 'AI review-post generation failed', message: err.message, jobId: job.id });
  }
}

router.post(
  '/review-post',
  [
    body('reviewText').optional().isString().isLength({ max: 8000 }),
    body('reviewRating').optional().isInt({ min: 1, max: 5 }),
    body('reviewerName').optional().isString().isLength({ max: 255 }),
    body('businessName').optional().isString().isLength({ max: 255 }),
    body('businessType').optional().isString().isLength({ max: 255 }),
    body('city').optional().isString().isLength({ max: 255 }),
    body('platform').optional().isString().isLength({ max: 64 }),
    body('tone').optional().isString().isLength({ max: 255 }),
    body('reviewId').optional().isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    return generateReviewPostHandler(req, res);
  }
);

module.exports = router;
module.exports.generateReviewPostHandler = generateReviewPostHandler;
