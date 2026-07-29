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

// Reuse the immediate-publish path's Drive URL detection + signed proxy
// builder so scheduled posts get the same URL rewrites. Prior version sent
// raw drive.google.com URLs, which GMB cannot fetch — every scheduled
// post with Drive media 400'd at publish time.
function extractDriveFileIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let m = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  m = url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  return null;
}

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

// Defensive: normalize a tel: URL to a valid E.164 form so we don't POST
// bad numbers to GMB. Historical rows scheduled before the frontend
// learned to prepend +1 for bare 10-digit US numbers stored values like
// tel:+9049020402 which GMB would reject or route wrong.
function normalizeTelUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.toLowerCase().startsWith('tel:')) return url;
  const digitsAll = url.slice(4).replace(/[^\d+]/g, '');
  const bare = digitsAll.replace(/^\+/, '');
  if (bare.length === 10) return `tel:+1${bare}`; // 10 digits, no country code → assume US
  if (bare.length === 11 && bare.startsWith('1')) return `tel:+${bare}`; // 1XXXXXXXXXX → +1XXX...
  return `tel:+${bare}`; // trust whatever the caller passed
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
    // media_data column is optional in prod (add-image-storage.sql may
    // not be applied). Omit it so the insert doesn't 400 and drop the
    // mirrored calendar row.
    await supabase.from('social_media_posts').insert({
      user_id: row.user_id,
      gmb_account_id: row.gmb_account_id,
      location_id: row.location_id,
      platform,
      post_id: gmbPostId,
      content: row.content,
      media_urls: mediaUrls,
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
  // Rewrite Drive URLs to our signed proxy — same trick the immediate
  // publish path uses. Required late-bind of ./routes/drive because that
  // module pulls express and would introduce a cycle if required at top.
  const publicBaseUrl =
    process.env.PUBLIC_BACKEND_URL ||
    process.env.BACKEND_URL ||
    'https://self-post-production.up.railway.app';
  const { buildSignedDriveProxyUrl } = require('../routes/drive');

  let media = Array.isArray(row.media)
    ? row.media
        .map((m) => {
          if (!m) return null;
          const url = typeof m === 'string' ? m : m.sourceUrl || m.url;
          if (!url) return null;
          return { mediaFormat: (typeof m === 'object' && m.mediaFormat) || 'PHOTO', sourceUrl: url };
        })
        .filter(Boolean)
    : [];

  media = media.map((m) => {
    const fileId = extractDriveFileIdFromUrl(m.sourceUrl);
    if (!fileId) return m;
    const signed = buildSignedDriveProxyUrl({
      userId: row.user_id,
      fileId,
      baseUrl: publicBaseUrl,
      ttlSeconds: 3600,
    });
    return { ...m, sourceUrl: signed };
  });

  // GMB localPosts.create accepts exactly 1 photo. More → 400 INVALID_ARGUMENT.
  // Truncate defensively so multi-image drafts still publish.
  if (media.length > 1) {
    logger.info('scheduled_publisher.media_truncated', {
      scheduled_id: row.id,
      dropped_count: media.length - 1,
    });
    media = media.slice(0, 1);
  }

  // Build callToAction — GMB validates strictly:
  //   - CALL: URL is not allowed. GMB uses the location's registered
  //     phone. Sending { actionType:'CALL', url:'tel:...' } → 400
  //     ValidationError "URL is not needed for CALL actions."
  //   - All other action types: URL required.
  let cta = null;
  const ct = row.call_to_action;
  if (ct && ct.actionType) {
    if (ct.actionType === 'CALL') {
      cta = { actionType: 'CALL' };
    } else if (ct.url) {
      cta = { actionType: ct.actionType, url: ct.url };
    }
  }

  const gmbBody = {
    languageCode: 'en-US',
    summary: row.content,
    topicType: mapPostTypeToTopicType(row.post_type),
    ...(media.length ? { media } : {}),
    ...(cta ? { callToAction: cta } : {}),
  };

  const url = `https://mybusiness.googleapis.com/v4/accounts/${row.gmb_account_id}/locations/${row.location_id}/localPosts`;

  // Log the shape we're about to send so a 400 from GMB is diagnosable.
  // Truncate the summary + serialize a preview of media[0] instead of
  // dumping the whole signed URL (which has a secret + is huge).
  logger.info('scheduled_publisher.request', {
    scheduled_id: row.id,
    location_id: row.location_id,
    body_keys: Object.keys(gmbBody).join(','),
    summary_len: (gmbBody.summary || '').length,
    media_count: (gmbBody.media || []).length,
    media0_host: (gmbBody.media?.[0]?.sourceUrl || '').replace(/^https?:\/\//, '').split('/')[0] || null,
    has_cta: !!gmbBody.callToAction,
    cta_action: gmbBody.callToAction?.actionType || null,
    cta_scheme: (gmbBody.callToAction?.url || '').split(':')[0] || null,
  });

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

// GMB's v4 API returns validation detail under
// error.details[].errorDetails[] (each entry has {field, message, value}),
// while newer Google APIs use error.details[].fieldViolations[]. Handle
// both plus the flat error.errors[] shape so a "Request contains an
// invalid argument" always surfaces the specific field GMB rejected.
function extractGmbErrorMessage(err) {
  const top = err?.response?.data?.error;
  const parts = [];
  if (top?.message) parts.push(top.message);
  if (Array.isArray(top?.details)) {
    for (const d of top.details) {
      if (Array.isArray(d?.errorDetails)) {
        for (const ed of d.errorDetails) {
          if (ed?.message) parts.push(`${ed.field || 'field'}: ${ed.message}`);
        }
      }
      if (Array.isArray(d?.fieldViolations)) {
        for (const fv of d.fieldViolations) {
          if (fv?.description) parts.push(`${fv.field || 'field'}: ${fv.description}`);
        }
      }
      if (d?.reason) parts.push(`reason=${d.reason}`);
    }
  }
  if (Array.isArray(top?.errors)) {
    for (const e of top.errors) if (e?.message) parts.push(e.message);
  }
  if (!parts.length && err?.message) parts.push(err.message);
  return parts.join(' | ');
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
      const message = extractGmbErrorMessage(err) || 'unknown error';
      // Dump the raw GMB error body + request shape so we can see WHY the
      // truncate+rewrite path is still 400'ing. Trimmed to keep loki
      // structured-metadata under limits.
      let rawErrorBody = '';
      try { rawErrorBody = JSON.stringify(err?.response?.data || {}).slice(0, 900); } catch {}
      await releaseFailed(row.id, message);
      logger.error('scheduled_publisher.failed', {
        scheduled_id: row.id,
        user_id: row.user_id,
        location_id: row.location_id,
        error: message,
        status: err?.response?.status,
        raw_error_body: rawErrorBody,
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
