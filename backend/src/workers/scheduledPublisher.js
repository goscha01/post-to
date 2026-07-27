// Scheduled-post publisher.
//
// Polls scheduled_posts every 60s. For each row where scheduled_time <= now()
// and status = 'scheduled':
//   1. Claim the row with a conditional UPDATE (status -> 'processing') so
//      multiple instances can't double-post. Losers get 0 rows back and skip.
//   2. Post to GMB via the user's OAuth token (multi-token fanout via
//      tryWithEachBusinessToken).
//   3. On success: status -> 'posted' + insert a matching social_media_posts
//      row so it shows up on the Published side of the calendar.
//   4. On failure: status -> 'failed' + error message. No automatic retry —
//      the user can reschedule manually from the UI.

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { tryWithEachBusinessToken } = require('../utils/businessTokens');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const POLL_INTERVAL_MS = Number(process.env.SCHEDULED_PUBLISHER_INTERVAL_MS) || 60_000;
const BATCH_SIZE = Number(process.env.SCHEDULED_PUBLISHER_BATCH) || 10;
// Small drift window for time comparisons — accommodates clock skew.
const CLAIM_LOOKBACK_SECONDS = 30;

function mapPostTypeToTopicType(postType) {
  switch ((postType || '').toUpperCase()) {
    case 'EVENT':
      return 'EVENT';
    case 'OFFER':
      return 'OFFER';
    case 'UPDATE':
    default:
      return 'STANDARD';
  }
}

async function findDueScheduledPosts() {
  const nowIso = new Date(Date.now() + CLAIM_LOOKBACK_SECONDS * 1000).toISOString();
  const { data, error } = await supabase
    .from('scheduled_posts')
    .select('id, user_id, content, media, platforms, scheduled_time, gmb_account_id, location_id, post_type, call_to_action, attempts')
    .eq('status', 'scheduled')
    .lte('scheduled_time', nowIso)
    .order('scheduled_time', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    logger.warn('scheduled_publisher.query_error', { error: error.message });
    return [];
  }
  return data || [];
}

// Conditional claim — returns the fully-updated row if we won the race,
// null if another worker already took it.
async function claimRow(id) {
  const { data, error } = await supabase
    .from('scheduled_posts')
    .update({
      status: 'processing',
      last_attempt_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'scheduled')
    .select()
    .single();
  if (error || !data) return null;
  return data;
}

async function releaseFailed(id, message) {
  await supabase
    .from('scheduled_posts')
    .update({ status: 'failed', error: (message || '').slice(0, 500) })
    .eq('id', id);
}

async function markPosted(id, gmbPostId, gmbResponse) {
  await supabase
    .from('scheduled_posts')
    .update({
      status: 'posted',
      posted_at: new Date().toISOString(),
      results: [{ platform: 'google', postId: gmbPostId, success: true, response: gmbResponse }],
    })
    .eq('id', id);
}

async function mirrorToSocialMediaPosts(row, gmbPostId) {
  try {
    const platform = (Array.isArray(row.platforms) && row.platforms[0]) || 'google';
    const mediaUrls = Array.isArray(row.media)
      ? row.media.map((m) => (typeof m === 'string' ? m : m?.sourceUrl || m?.url)).filter(Boolean)
      : [];
    await supabase.from('social_media_posts').insert({
      user_id: row.user_id,
      gmb_account_id: row.gmb_account_id,
      location_id: row.location_id,
      platform,
      post_id: gmbPostId,
      content: row.content,
      media_urls: mediaUrls,
      media_data: [],
      published_at: new Date().toISOString(),
      status: 'published',
    });
  } catch (err) {
    // Non-fatal — the scheduled_posts row is authoritative anyway.
    logger.warn('scheduled_publisher.mirror_error', {
      scheduled_id: row.id,
      user_id: row.user_id,
      error: err?.message,
    });
  }
}

async function publishOne(row) {
  const media = Array.isArray(row.media)
    ? row.media
        .map((m) => {
          if (!m) return null;
          const url = typeof m === 'string' ? m : m.sourceUrl || m.url;
          if (!url) return null;
          return { mediaFormat: (typeof m === 'object' && m.mediaFormat) || 'PHOTO', sourceUrl: url };
        })
        .filter(Boolean)
    : [];

  const gmbBody = {
    languageCode: 'en-US',
    summary: row.content,
    topicType: mapPostTypeToTopicType(row.post_type),
    ...(media.length ? { media } : {}),
    ...(row.call_to_action && row.call_to_action.actionType && row.call_to_action.url
      ? { callToAction: { actionType: row.call_to_action.actionType, url: row.call_to_action.url } }
      : {}),
  };

  const url = `https://mybusiness.googleapis.com/v4/accounts/${row.gmb_account_id}/locations/${row.location_id}/localPosts`;

  const attempt = await tryWithEachBusinessToken(row.user_id, null, async (accessToken) => {
    const resp = await axios.post(url, gmbBody, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
    return resp.data;
  });

  if (!attempt.ok) {
    throw attempt.error || new Error('All OAuth tokens failed to publish');
  }
  const gmbResponse = attempt.result;
  const gmbPostId = gmbResponse?.name ? gmbResponse.name.split('/').pop() : null;
  return { gmbPostId, gmbResponse };
}

async function tick() {
  let due = [];
  try {
    due = await findDueScheduledPosts();
  } catch (err) {
    logger.warn('scheduled_publisher.tick_query_error', { error: err?.message });
    return;
  }
  if (due.length === 0) return;

  logger.info('scheduled_publisher.tick', { due_count: due.length });

  for (const row of due) {
    const claimed = await claimRow(row.id);
    if (!claimed) continue; // another worker won

    // Bump attempts. Kept separate from the claim to avoid a read-modify-write
    // race on the counter — we don't care about strict monotonicity here.
    await supabase
      .from('scheduled_posts')
      .update({ attempts: (row.attempts || 0) + 1 })
      .eq('id', row.id);

    try {
      const { gmbPostId, gmbResponse } = await publishOne(claimed);
      await markPosted(row.id, gmbPostId, gmbResponse);
      if (gmbPostId) await mirrorToSocialMediaPosts(claimed, gmbPostId);
      logger.info('scheduled_publisher.published', {
        scheduled_id: row.id,
        user_id: row.user_id,
        gmb_post_id: gmbPostId,
        location_id: row.location_id,
      });
    } catch (err) {
      const message = err?.response?.data?.error?.message || err?.message || 'unknown error';
      await releaseFailed(row.id, message);
      logger.error('scheduled_publisher.failed', {
        scheduled_id: row.id,
        user_id: row.user_id,
        location_id: row.location_id,
        error: message,
        status: err?.response?.status,
      });
    }
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  // Fire once on boot after a short delay so we don't compete with server
  // startup traffic; then poll at the configured interval.
  setTimeout(() => {
    tick().catch((e) => logger.warn('scheduled_publisher.tick_error', { error: e?.message }));
    setInterval(() => {
      tick().catch((e) => logger.warn('scheduled_publisher.tick_error', { error: e?.message }));
    }, POLL_INTERVAL_MS);
  }, 5_000);
  logger.info('scheduled_publisher.started', { interval_ms: POLL_INTERVAL_MS, batch_size: BATCH_SIZE });
}

module.exports = { start, tick };
