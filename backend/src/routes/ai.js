// AI generation routes.
//   POST /api/ai/articles      → generate blog article draft
//   POST /api/ai/review-post   → generate social/GMB post draft from review input
//
// Both routes require user auth (authMiddleware). They do NOT require business
// auth, because article generation has nothing to do with GMB access and the
// review-post route can accept review fields directly.

const express = require('express');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const aiContent = require('../services/aiContentService');
const aiJobs = require('../services/aiJobsService');
const connectionsService = require('../services/connectionsService');
const driveRouter = require('./drive'); // for driveFileIdFromUrl + fetchDriveFileBytes helpers
const logger = require('../utils/logger');

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
          connection_id: connection?.id || null,
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

// ---------------------------------------------------------------------------
// Review-reply generation. Drafts an owner-to-customer reply for GBP.
// No DB persistence for the draft itself — the ai_jobs row logs the run
// (tokens, cost, prompt); the reply text is returned once and thrown away
// if the user doesn't post it via the existing GMB reply endpoint.
// ---------------------------------------------------------------------------
async function generateReviewReplyHandler(req, res, options = {}) {
  const userId = req.user.userId;
  const kind = 'review_reply_generation';

  const used = await aiJobs.countTodayByKind(userId, kind);
  const cap = aiJobs.dailyCapFor(kind);
  if (used >= cap) {
    return res.status(429).json({
      error: 'Daily AI review-reply generation limit reached',
      used,
      cap
    });
  }

  const input = {
    businessName: req.body.businessName || 'the business',
    businessType: req.body.businessType || 'local service business',
    city: req.body.city || '',
    reviewText: req.body.reviewText || '',
    reviewRating: req.body.reviewRating ?? null,
    reviewerName: req.body.reviewerName || '',
    tone: req.body.tone || 'warm, professional, personal',
    existingReply: req.body.existingReply || ''
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
    const result = await aiContent.generateReviewReply(input);
    const ai = result.data;

    await aiJobs.completeJob(job.id, {
      prompt: result.prompt,
      outputJson: ai,
      model: result.model,
      usage: result.usage,
      costUsd: result.costUsd,
      resultTable: null,
      resultId: null
    });

    return res.status(200).json({
      jobId: job.id,
      reply: ai.reply,
      model: result.model,
      usage: result.usage,
      costUsd: result.costUsd
    });
  } catch (err) {
    console.error('review-reply generation failed:', err.message);
    await aiJobs.failJob(job.id, err.message);
    return res.status(502).json({ error: 'AI review-reply generation failed', message: err.message, jobId: job.id });
  }
}

router.post(
  '/review-reply',
  [
    body('reviewText').optional().isString().isLength({ max: 8000 }),
    body('reviewRating').optional().isInt({ min: 1, max: 5 }),
    body('reviewerName').optional().isString().isLength({ max: 255 }),
    body('businessName').optional().isString().isLength({ max: 255 }),
    body('businessType').optional().isString().isLength({ max: 255 }),
    body('city').optional().isString().isLength({ max: 255 }),
    body('tone').optional().isString().isLength({ max: 255 }),
    body('existingReply').optional().isString().isLength({ max: 8000 }),
    body('reviewId').optional().isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }
    return generateReviewReplyHandler(req, res);
  }
);

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

// ---------------------------------------------------------------------------
// Post-from-image generation (vision)
// ---------------------------------------------------------------------------
// POST /api/ai/post-from-image
//   Body: {
//     imageUrls: string[]        // Drive URLs (drive.google.com/uc?...) or public
//     businessName?, businessType?, city?, tone?, additionalContext?,
//     postType?: 'UPDATE'|'OFFER'|'EVENT',
//     includeCallToAction?: bool, ctaType?: string,
//   }
//   Returns: { text: string, jobId: string, imageDescription: string }
//
// For Drive URLs we fetch via OAuth and inline as base64 so the user
// doesn't need to share files publicly. Non-Drive URLs are passed through
// to the model as-is (image_url form).
async function fetchImagePart({ userId, url }) {
  const fileId = driveRouter.driveFileIdFromUrl?.(url);
  if (fileId) {
    const attempt = await driveRouter.fetchDriveFileBytes({
      userId,
      fileId,
      fallbackToken: null,
    });
    if (!attempt.ok) return null;
    const buf = Buffer.from(attempt.result.data);
    const mimeType = attempt.result.headers?.['content-type']?.split(';')[0] || 'image/jpeg';
    return { base64: buf.toString('base64'), mimeType };
  }
  // Public URL — hand to the model directly. Reject anything that
  // clearly isn't http(s) to avoid data: URL abuse.
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { url };
  } catch {
    return null;
  }
}

router.post(
  '/post-from-image',
  [
    body('imageUrls').isArray({ min: 1, max: 4 }),
    body('imageUrls.*').isString().isLength({ min: 5, max: 2000 }),
    // optional({ nullable: true, checkFalsy: true }) — express-validator's
    // default optional() only skips `undefined`; the frontend sends `null`
    // for ctaType when no CTA is picked, which was tripping .isString()
    // and returning a bare 400 with no field-level hint.
    body('businessName').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 255 }),
    body('businessType').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 255 }),
    body('city').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 255 }),
    body('tone').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 255 }),
    body('additionalContext').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 1000 }),
    body('postType').optional({ nullable: true, checkFalsy: true }).isIn(['UPDATE', 'OFFER', 'EVENT']),
    body('includeCallToAction').optional({ nullable: true }).isBoolean(),
    body('ctaType').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 64 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Emit the exact validator failures so future 400s show which field
      // tripped the check. Without this the frontend just gets a generic
      // "Invalid input" with no way to diagnose.
      logger.warn('ai.post_from_image.validation_error', {
        user_id: req.user?.userId,
        errors: errors.array().slice(0, 10),
        image_url_count: Array.isArray(req.body?.imageUrls) ? req.body.imageUrls.length : null,
        image_url_lengths: Array.isArray(req.body?.imageUrls)
          ? req.body.imageUrls.map((u) => (typeof u === 'string' ? u.length : typeof u))
          : null,
        body_keys: req.body ? Object.keys(req.body) : null,
        post_type: req.body?.postType,
        include_cta: req.body?.includeCallToAction,
        cta_type: req.body?.ctaType,
      });
      return res.status(400).json({ error: 'Invalid input', details: errors.array() });
    }

    const userId = req.user.userId;
    const kind = 'post_from_image_generation';

    const used = await aiJobs.countTodayByKind(userId, kind);
    const cap = aiJobs.dailyCapFor(kind);
    if (used >= cap) {
      return res.status(429).json({
        error: 'Daily AI post-from-image limit reached',
        used,
        cap,
      });
    }

    // Fetch every image up front so a single failure doesn't waste the LLM
    // call. Skip images we can't fetch — but bail if none succeed.
    const images = [];
    for (const url of req.body.imageUrls) {
      try {
        const part = await fetchImagePart({ userId, url });
        if (part) images.push(part);
      } catch (e) {
        logger.warn('ai.post_from_image.fetch_error', {
          user_id: userId,
          url_prefix: url.slice(0, 60),
          error: e?.message,
        });
      }
    }
    if (images.length === 0) {
      return res.status(400).json({
        error: 'None of the provided images could be fetched — check Drive access or URL validity',
      });
    }

    const input = {
      businessName: req.body.businessName || 'the business',
      businessType: req.body.businessType || 'local service business',
      city: req.body.city || '',
      tone: req.body.tone || 'warm, professional, engaging',
      images,
      includeCallToAction: !!req.body.includeCallToAction,
      ctaType: req.body.ctaType || null,
      postType: req.body.postType || 'UPDATE',
      additionalContext: req.body.additionalContext || '',
    };

    // Persist a job row before the LLM call so failed / partial runs still
    // count against the daily cap (retry-abuse safety net — same pattern
    // used by /articles and /review-post).
    let job;
    try {
      job = await aiJobs.createJob({
        userId,
        kind,
        model: process.env.AI_MODEL || null,
        inputJson: {
          imageUrls: req.body.imageUrls,
          imageCount: images.length,
          businessName: input.businessName,
          businessType: input.businessType,
          city: input.city,
          tone: input.tone,
          postType: input.postType,
          includeCallToAction: input.includeCallToAction,
          ctaType: input.ctaType,
        },
      });
    } catch (e) {
      logger.error('ai.post_from_image.job_create_failed', { user_id: userId, error: e?.message });
      return res.status(500).json({ error: 'Failed to create AI job', details: e.message });
    }

    try {
      const result = await aiContent.generatePostFromImages(input);
      await aiJobs.completeJob(job.id, {
        prompt: result.prompt,
        outputJson: result.data,
        model: result.model,
        usage: result.usage,
        costUsd: result.costUsd,
      });
      logger.info('ai.post_from_image.ok', {
        user_id: userId,
        job_id: job.id,
        image_count: images.length,
        cost_usd: result.costUsd,
      });
      return res.json({
        text: result.data.text,
        imageDescription: result.data.imageDescription,
        jobId: job.id,
      });
    } catch (e) {
      await aiJobs.failJob(job.id, e?.message || 'unknown error');
      logger.error('ai.post_from_image.failed', {
        user_id: userId,
        job_id: job?.id,
        error: e?.message,
      });
      return res.status(500).json({ error: 'AI generation failed', details: e.message });
    }
  }
);

module.exports = router;
module.exports.generateReviewPostHandler = generateReviewPostHandler;
module.exports.generateReviewReplyHandler = generateReviewReplyHandler;
