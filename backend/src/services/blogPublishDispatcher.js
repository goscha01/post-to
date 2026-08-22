// Blog publish dispatcher.
//
// Fans a single article out to N connected_accounts of the Publishing
// Platform providers (Webflow, Wix, BigCommerce, HubSpot, GoHighLevel, Duda,
// Webhook, RSS). Independent from the existing S3/hosted-domain publish in
// routes/blogs.js#publish — that pipeline stays untouched.
//
// Guarantees:
//   * Idempotent per (article, connection) — same call republishes the same
//     row instead of duplicating.
//   * Each provider is attempted in isolation; one failure does not block
//     the others.
//   * Sensitive credential access goes through connectionsService.getRawForUser
//     so the dispatcher never has to know about SENSITIVE_METADATA_KEYS.
//
// Retry: single-attempt today. The blog_publish_targets.attempts column and
// the retry endpoint (POST /blogs/:id/publish-targets/:targetId/retry) let a
// customer manually rerun after fixing whatever caused the failure. Automatic
// retry-with-backoff is a follow-up (nice to have but hazardous to build
// blind — customer webhooks that 500 the first time are frequently *never*
// going to succeed).

const { createClient } = require('@supabase/supabase-js');
const connectionsService = require('./connectionsService');
const publishing = require('./publishingPlatformService');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const TABLE = 'blog_publish_targets';

async function upsertTarget({ userId, articleId, connectionId, provider }) {
  const { data: existing } = await supabase
    .from(TABLE)
    .select('id, attempts')
    .eq('article_id', articleId)
    .eq('connection_id', connectionId)
    .maybeSingle();
  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ status: 'publishing', last_error: null, last_attempt_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      article_id: articleId,
      connection_id: connectionId,
      provider,
      status: 'publishing',
      attempts: 0,
      last_attempt_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function markPublished(targetId, { publishedUrl, externalId, meta }) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'published',
      published_url: publishedUrl || null,
      external_id: externalId || null,
      last_error: null,
      published_at: nowIso,
    })
    .eq('id', targetId);
  if (error) throw error;
  // If the publisher discovered stable metadata (Webflow collection_id,
  // HubSpot content_group_id, etc.), persist it on the connection so we
  // don't rediscover it on every publish.
  if (meta && Object.keys(meta).length) {
    // Fetch fresh row so we don't clobber concurrent metadata edits.
    const { data: target } = await supabase.from(TABLE).select('connection_id, user_id').eq('id', targetId).single();
    if (target) {
      const { data: conn } = await supabase
        .from('connected_accounts')
        .select('metadata')
        .eq('id', target.connection_id)
        .single();
      if (conn) {
        const nextMeta = { ...(conn.metadata || {}), ...meta };
        await supabase
          .from('connected_accounts')
          .update({ metadata: nextMeta })
          .eq('id', target.connection_id);
      }
    }
  }
}

async function markFailed(targetId, err) {
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: 'failed',
      last_error: (err?.message || 'unknown error').slice(0, 2000),
    })
    .eq('id', targetId);
  if (error) throw error;
}

// Bump the attempts counter regardless of outcome. Separate call so the
// counter increments even when the row was just inserted (initial attempt
// = 1) or when a follow-up retry succeeds.
async function bumpAttempts(targetId) {
  const { data: row } = await supabase.from(TABLE).select('attempts').eq('id', targetId).single();
  const next = (row?.attempts || 0) + 1;
  await supabase.from(TABLE).update({ attempts: next }).eq('id', targetId);
  return next;
}

// Load the article + all requested connections, publish to each in parallel,
// return per-target result. Errors on a single target don't fail the batch —
// the caller sees which succeeded and which didn't.
async function dispatch({ userId, articleId, connectionIds }) {
  if (!Array.isArray(connectionIds) || connectionIds.length === 0) {
    throw new Error('At least one connectionId required');
  }

  const { data: article, error: articleErr } = await supabase
    .from('blog_articles')
    .select('*')
    .eq('user_id', userId)
    .eq('id', articleId)
    .single();
  if (articleErr) throw articleErr;
  if (!article) throw new Error('Article not found');

  const results = await Promise.all(connectionIds.map(async (connectionId) => {
    let target;
    try {
      const connection = await connectionsService.getRawForUser(userId, connectionId);
      if (!connection) return { connectionId, ok: false, error: 'Connection not found' };
      target = await upsertTarget({ userId, articleId, connectionId, provider: connection.provider });
      await bumpAttempts(target.id);
      const result = await publishing.publishToProvider({ connection, article });
      await markPublished(target.id, result);
      logger.info('publish.target.ok', {
        userId, articleId, connectionId, provider: connection.provider,
        published_url: result.publishedUrl, external_id: result.externalId,
      });
      return { connectionId, ok: true, targetId: target.id, ...result };
    } catch (err) {
      if (target) {
        try { await markFailed(target.id, err); } catch (_) { /* best effort */ }
      }
      logger.warn('publish.target.failed', {
        userId, articleId, connectionId, status: err.status, code: err.code, error: err.message,
      });
      return { connectionId, ok: false, targetId: target?.id, error: err.message, code: err.code, status: err.status };
    }
  }));

  return { article_id: articleId, results };
}

// Rerun a single target — used by the "Retry" button on the article view.
async function retryTarget({ userId, targetId }) {
  const { data: target, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('id', targetId)
    .single();
  if (error) throw error;
  if (!target) throw new Error('Target not found');
  const { results } = await dispatch({
    userId,
    articleId: target.article_id,
    connectionIds: [target.connection_id],
  });
  return results[0];
}

// Load the per-target status list for an article — powers the "Published to"
// panel on the article view.
async function listForArticle({ userId, articleId }) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, connection_id, provider, status, published_url, external_id, attempts, last_error, last_attempt_at, published_at, created_at, updated_at')
    .eq('user_id', userId)
    .eq('article_id', articleId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

module.exports = {
  dispatch,
  retryTarget,
  listForArticle,
  _internal: { upsertTarget, markPublished, markFailed, bumpAttempts },
};
