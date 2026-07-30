// Executes an automation_rule end-to-end.
//
// One entry point: `runRule(rule, { trigger })`. Used by both:
//   - workers/automationScheduler.js  (trigger='schedule')
//   - routes/automations.js#test-run  (trigger='test')
//
// Steps (per rule):
//   1. Insert an automation_runs row (status='running')
//   2. Pick topic (LLM or round-robin from rule.topics)
//   3. Generate content
//      - kind='blog' → aiContentService.generateArticle → blog_articles row
//      - kind='social_post' → aiContentService.generateReviewPost with a
//        promo-post prompt (we reuse the existing prompt with reviewText='')
//        so the LLM writes an evergreen social post rather than a review reply
//   4. Optionally generate/pick an image
//   5. If rule.auto_publish:
//      - kind='blog' → publish via blogPublisherS3 to each verified S3 domain
//      - kind='social_post' → publish to each configured target (GMB/FB/IG)
//   6. Update run row with results
//
// Errors in any single target are recorded but do not fail sibling targets.

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const aiContent = require('./aiContentService');
const aiImage = require('./aiImageService');
const aiJobs = require('./aiJobsService');
const automationsService = require('./automationsService');
const blogPublisherS3 = require('./blogPublisherS3');
const blogDeployTrigger = require('./blogDeployTrigger');
const blogDomainsService = require('./blogDomainsService');
const connectionsService = require('./connectionsService');
const meta = require('./metaService');
const { tryWithEachBusinessToken } = require('../utils/businessTokens');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const RUNS = 'automation_runs';

function slugify(s) {
  return String(s || '')
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
// Topic selection
// ---------------------------------------------------------------------------

async function pickTopic(rule) {
  if (rule.topic_source === 'topic_list' && Array.isArray(rule.topics) && rule.topics.length > 0) {
    const idx = ((rule.topic_cursor || 0) % rule.topics.length + rule.topics.length) % rule.topics.length;
    return { topic: rule.topics[idx], advanceCursor: true };
  }
  // ai_pick: ask the LLM to nominate one specific topic given the business
  // context. Cheap call — reuses the same OpenAI infra.
  const ctx = rule.business_context || {};
  const businessName = ctx.businessName || 'the business';
  const businessType = ctx.businessType || 'local service business';
  const city = ctx.city || '';
  const audience = ctx.targetAudience || 'homeowners and renters';

  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Return JSON only.' },
          { role: 'user', content: `Pick ONE concrete, non-generic topic idea for a ${rule.kind === 'blog' ? 'blog article' : 'social media post'} for ${businessName} (${businessType}${city ? `, ${city}` : ''}). Audience: ${audience}. Rotate through practical, seasonal, local-service angles — avoid the topic sounding like every other AI-generated post. Return JSON: {"topic":"...","keyword":"..."} where "topic" is a specific angle (a question, tip, or scenario) and "keyword" is a short SEO phrase.` },
        ],
        temperature: 0.85,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30_000,
      }
    );
    const content = resp.data?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    return { topic: parsed.topic || 'seasonal tips', keyword: parsed.keyword || parsed.topic, advanceCursor: false };
  } catch (e) {
    logger.warn('automation.topic_ai_pick_failed', { rule_id: rule.id, error: e.message });
    // Degenerate fallback so a transient OpenAI hiccup doesn't kill the run.
    return { topic: `${businessType} tips`, keyword: `${businessType} tips`, advanceCursor: false };
  }
}

// ---------------------------------------------------------------------------
// Blog path
// ---------------------------------------------------------------------------

async function runBlog(rule, { topic, keyword }) {
  const ctx = rule.business_context || {};
  const input = {
    businessName: ctx.businessName || 'the business',
    businessType: ctx.businessType || 'local service business',
    service: ctx.service || 'general service',
    city: ctx.city || '',
    keyword: keyword || topic,
    tone: ctx.tone || 'helpful, local, professional',
    targetAudience: ctx.targetAudience || 'homeowners and renters',
  };

  const job = await aiJobs.createJob({
    userId: rule.user_id,
    kind: 'article_generation',
    model: process.env.AI_MODEL || null,
    inputJson: { ...input, automation_rule_id: rule.id, topic },
  });

  let article;
  try {
    const result = await aiContent.generateArticle(input);
    const ai = result.data;
    const slug = slugify(ai.slug || ai.title);
    const { data: inserted, error: insertErr } = await supabase
      .from('blog_articles')
      .insert({
        user_id: rule.user_id,
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
        status: 'draft',
      })
      .select().single();
    if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`);
    article = inserted;

    await aiJobs.completeJob(job.id, {
      prompt: result.prompt,
      outputJson: ai,
      model: result.model,
      usage: result.usage,
      costUsd: result.costUsd,
      resultTable: 'blog_articles',
      resultId: article.id,
    });
  } catch (e) {
    await aiJobs.failJob(job.id, e.message);
    throw e;
  }

  const generatedIds = [{ table: 'blog_articles', id: article.id, title: article.title, slug: article.slug }];
  const publishResults = [];

  if (rule.auto_publish) {
    // Publish to every verified S3 domain. Mirrors routes/blogs.js#/:id/publish
    // but without the extra HTTP hop.
    const nowIso = new Date().toISOString();
    await supabase.from('blog_articles')
      .update({ status: 'published', published_at: nowIso })
      .eq('id', article.id).eq('user_id', rule.user_id);
    article.status = 'published';
    article.published_at = nowIso;

    const summaries = await blogDomainsService.listForUser(rule.user_id);
    for (const d of summaries) {
      if (!(d.status === 'active' && d.metadata?.verified && d.metadata?.publish_target === 's3')) continue;
      const raw = await blogDomainsService.getForUser({ userId: rule.user_id, id: d.id }).catch(() => null);
      if (!raw) { publishResults.push({ target: `blog:${d.id}`, ok: false, error: 'domain load failed' }); continue; }
      try {
        await blogPublisherS3.publish({ blog: article, domain: raw });
        const dep = await blogDeployTrigger.trigger({ domain: raw, blog: article });
        publishResults.push({
          target: `blog:${d.id}`,
          host: raw.metadata?.hostname,
          ok: true,
          autoDeployed: !!dep.ok,
          reason: dep.reason || dep.error || null,
        });
      } catch (e) {
        publishResults.push({ target: `blog:${d.id}`, host: raw.metadata?.hostname, ok: false, error: e.message });
      }
    }
  }

  return { generatedIds, publishResults, articleId: article.id, articleSlug: article.slug };
}

// ---------------------------------------------------------------------------
// Social post path
// ---------------------------------------------------------------------------

async function runSocialPost(rule, { topic }) {
  const ctx = rule.business_context || {};
  // Reuse the review-post prompt pattern to build an evergreen post grounded
  // in the topic (rather than a review). We synthesize a fake "reviewText"
  // from the topic so the existing prompt still works — cheaper than adding
  // a whole new prompt path.
  const input = {
    businessName: ctx.businessName || 'the business',
    businessType: ctx.businessType || 'local service business',
    city: ctx.city || '',
    reviewText: `Topic to write about: ${topic}. Do not quote or invent testimonials. Write it as an original post from the business, not a reply.`,
    reviewRating: null,
    reviewerName: '',
    tone: ctx.tone || 'warm, engaging, professional',
    platform: 'google',
  };

  const job = await aiJobs.createJob({
    userId: rule.user_id,
    kind: 'review_post_generation',
    model: process.env.AI_MODEL || null,
    inputJson: { ...input, automation_rule_id: rule.id, topic },
  });

  let generated;
  try {
    const result = await aiContent.generateReviewPost(input);
    generated = result.data;
    // Persist as an ai_generated_posts row for audit — same table Reviews uses.
    const { data: postRow } = await supabase
      .from('ai_generated_posts')
      .insert({
        user_id: rule.user_id,
        source_type: 'automation',
        source_id: rule.id,
        business_name: input.businessName,
        platform_target: 'gmb',
        caption: generated.caption,
        short_caption: generated.shortCaption,
        google_business_post: generated.googleBusinessPost,
        hashtags: generated.hashtags,
        status: 'draft',
      })
      .select().single();
    generated._id = postRow?.id;

    await aiJobs.completeJob(job.id, {
      prompt: result.prompt,
      outputJson: generated,
      model: result.model,
      usage: result.usage,
      costUsd: result.costUsd,
      resultTable: 'ai_generated_posts',
      resultId: postRow?.id,
    });
  } catch (e) {
    await aiJobs.failJob(job.id, e.message);
    throw e;
  }

  // Pick / generate an image URL.
  let imageUrl = null;
  if (rule.image_source === 'fixed' && rule.fixed_image_url) {
    imageUrl = rule.fixed_image_url;
  } else if (rule.image_source === 'ai_generate') {
    try {
      const img = await aiImage.generateAndHost({
        userId: rule.user_id,
        caption: generated.caption || generated.googleBusinessPost,
        businessType: ctx.businessType,
        promptTemplate: rule.image_prompt_template,
      });
      imageUrl = img.url;
    } catch (e) {
      logger.warn('automation.image_generate_failed', { rule_id: rule.id, error: e.message });
      // Fall through with imageUrl=null — text-only posts are still valid
      // for GMB + FB. IG will be skipped below (imageUrl required).
    }
  }

  const generatedIds = [{ table: 'ai_generated_posts', id: generated._id, caption: (generated.caption || '').slice(0, 200) }];
  const publishResults = [];

  if (rule.auto_publish) {
    for (const target of rule.targets || []) {
      try {
        if (target.type === 'gmb') {
          const res = await publishToGmb({ userId: rule.user_id, target, text: generated.googleBusinessPost || generated.caption, imageUrl });
          publishResults.push({ target: `gmb:${target.accountPath}`, label: target.label, ok: true, postId: res.postId });
        } else if (target.type === 'facebook') {
          const res = await publishToFacebook({ userId: rule.user_id, connectionId: target.connectionId, text: generated.caption, imageUrl });
          publishResults.push({ target: `fb:${target.connectionId}`, label: target.label, ok: true, postId: res.id });
        } else if (target.type === 'instagram') {
          if (!imageUrl) {
            publishResults.push({ target: `ig:${target.connectionId}`, label: target.label, ok: false, error: 'Instagram requires an image — set image_source' });
            continue;
          }
          const res = await publishToInstagram({ userId: rule.user_id, connectionId: target.connectionId, caption: generated.caption, imageUrl });
          publishResults.push({ target: `ig:${target.connectionId}`, label: target.label, ok: true, postId: res.id });
        } else {
          publishResults.push({ target: JSON.stringify(target), ok: false, error: `unknown target.type ${target?.type}` });
        }
      } catch (e) {
        publishResults.push({ target: `${target.type}:${target.connectionId || target.accountPath}`, label: target.label, ok: false, error: e.message });
      }
    }
  }

  return { generatedIds, publishResults, imageUrl };
}

// ---------------------------------------------------------------------------
// Publish helpers
// ---------------------------------------------------------------------------

async function publishToGmb({ userId, target, text, imageUrl }) {
  // target.accountPath = 'accounts/{accountId}/locations/{locationId}'
  const parts = String(target.accountPath || '').split('/');
  const accountId = parts[1];
  const locationId = parts[3];
  if (!accountId || !locationId) throw new Error('bad target.accountPath');

  const body = {
    languageCode: 'en-US',
    summary: text || '',
    topicType: 'STANDARD',
  };
  if (imageUrl) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }];

  const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`;
  const attempt = await tryWithEachBusinessToken(userId, null, async (accessToken) => {
    const resp = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 15_000,
    });
    return resp.data;
  });
  if (!attempt.ok) throw attempt.error || new Error('All OAuth tokens failed for GMB publish');
  const resp = attempt.result;
  const postId = resp?.name ? resp.name.split('/').pop() : null;
  return { postId, response: resp };
}

async function publishToFacebook({ userId, connectionId, text, imageUrl }) {
  const row = await connectionsService.getRawForUser(userId, connectionId);
  if (!row) throw new Error('connection not found');
  if (row.provider !== 'facebook') throw new Error('not a facebook connection');
  const pageId = row.metadata?.page_id;
  const pageAccessToken = row.metadata?.page_access_token;
  if (!pageId || !pageAccessToken) throw new Error('connection missing page id or token — reconnect');
  return meta.publishFacebookPost({ pageId, pageAccessToken, message: text || '', imageUrl });
}

async function publishToInstagram({ userId, connectionId, caption, imageUrl }) {
  const row = await connectionsService.getRawForUser(userId, connectionId);
  if (!row) throw new Error('connection not found');
  if (row.provider !== 'instagram') throw new Error('not an instagram connection');
  const igBusinessId = row.metadata?.ig_business_id;
  const pageAccessToken = row.metadata?.page_access_token;
  if (!igBusinessId || !pageAccessToken) throw new Error('connection missing IG id or token — reconnect');
  return meta.publishInstagramPost({ igBusinessId, pageAccessToken, caption: caption || '', imageUrl });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function runRule(rule, { trigger = 'schedule' } = {}) {
  const { data: run } = await supabase.from(RUNS).insert({
    rule_id: rule.id,
    user_id: rule.user_id,
    kind: rule.kind,
    status: 'running',
    trigger,
  }).select().single();

  const runId = run?.id;
  let outcome = { status: 'ok', generatedIds: [], publishResults: [], error: null, topic: null, imageUrl: null };

  try {
    const { topic, keyword, advanceCursor } = await pickTopic(rule);
    outcome.topic = topic;

    let result;
    if (rule.kind === 'blog') {
      result = await runBlog(rule, { topic, keyword });
    } else if (rule.kind === 'social_post') {
      result = await runSocialPost(rule, { topic });
    } else {
      throw new Error(`unknown rule.kind ${rule.kind}`);
    }

    outcome.generatedIds = result.generatedIds || [];
    outcome.publishResults = result.publishResults || [];
    outcome.imageUrl = result.imageUrl || null;

    const publishFails = outcome.publishResults.filter((r) => r.ok === false).length;
    const publishAttempts = outcome.publishResults.length;
    if (rule.auto_publish && publishAttempts > 0 && publishFails === publishAttempts) {
      outcome.status = 'failed';
    } else if (publishFails > 0) {
      outcome.status = 'partial';
    } else {
      outcome.status = 'ok';
    }

    // Advance topic cursor + next_run_at. Only advance topic on schedule
    // triggers so a "test run" doesn't consume a topic slot.
    if (trigger === 'schedule') {
      await automationsService.markRunComplete(rule.id, {
        advanceTopic: advanceCursor,
        cadence: rule.cadence,
      });
    }
  } catch (e) {
    outcome.status = 'failed';
    outcome.error = e.message;
    logger.error('automation.run_failed', { rule_id: rule.id, run_id: runId, error: e.message });
    if (trigger === 'schedule') {
      // Still stamp next_run_at so a broken rule keeps ticking until fixed
      // (rather than getting stuck and hammering `next_run_at <= now()`).
      await automationsService.markRunComplete(rule.id, { advanceTopic: false, cadence: rule.cadence }).catch(() => {});
    }
  }

  if (runId) {
    await supabase.from(RUNS).update({
      status: outcome.status,
      generated_ids: outcome.generatedIds,
      publish_results: outcome.publishResults,
      topic: outcome.topic,
      image_url: outcome.imageUrl,
      error: outcome.error,
      completed_at: new Date().toISOString(),
    }).eq('id', runId);
  }

  logger.info('automation.run_done', {
    rule_id: rule.id,
    run_id: runId,
    trigger,
    status: outcome.status,
    published_ok: outcome.publishResults.filter((r) => r.ok).length,
    published_fail: outcome.publishResults.filter((r) => r.ok === false).length,
  });
  return { runId, ...outcome };
}

module.exports = { runRule };
