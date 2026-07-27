const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../utils/logger');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);

// ── Schedule CRUD ───────────────────────────────────────
//
// POST   /api/calendar/schedule            Create a scheduled post row
// PATCH  /api/calendar/schedule/:id        Reschedule / edit content
// DELETE /api/calendar/schedule/:id        Cancel a scheduled post
//
// The scheduledPublisher worker (started in index.js) picks up rows where
// status='scheduled' AND scheduled_time <= now() and posts them to GMB.

router.post('/schedule', async (req, res) => {
  const userId = req.user?.userId;
  try {
    const {
      content,
      media = [],
      platforms = ['google'],
      scheduledTime,
      gmbAccountId,
      gmbLocationId,
      postType = 'UPDATE',
      callToAction = null,
    } = req.body || {};

    if (!content || !scheduledTime || !gmbAccountId || !gmbLocationId) {
      return res.status(400).json({
        success: false,
        error: 'content, scheduledTime, gmbAccountId, and gmbLocationId are required',
      });
    }
    const when = new Date(scheduledTime);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ success: false, error: 'scheduledTime must be a valid ISO timestamp' });
    }
    // Guard against scheduling in the past — the worker would fire it
    // immediately and the user probably didn't mean to.
    if (when.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ success: false, error: 'scheduledTime must be in the future' });
    }

    // Normalize media: accept an array of {sourceUrl, mediaFormat} or of URL strings.
    const mediaClean = Array.isArray(media)
      ? media
          .map((m) => {
            if (!m) return null;
            if (typeof m === 'string') return { sourceUrl: m, mediaFormat: 'PHOTO' };
            const url = m.sourceUrl || m.url || null;
            if (!url) return null;
            return { sourceUrl: url, mediaFormat: m.mediaFormat || 'PHOTO' };
          })
          .filter(Boolean)
      : [];

    const { data, error } = await supabase
      .from('scheduled_posts')
      .insert({
        user_id: userId,
        content,
        media: mediaClean,
        platforms,
        scheduled_time: when.toISOString(),
        status: 'scheduled',
        gmb_account_id: gmbAccountId,
        location_id: gmbLocationId,
        post_type: postType,
        call_to_action: callToAction || null,
      })
      .select()
      .single();

    if (error) {
      logger.error('calendar.schedule.insert_error', { user_id: userId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to schedule post', details: error.message });
    }

    logger.info('calendar.schedule.created', {
      user_id: userId,
      id: data.id,
      scheduled_time: data.scheduled_time,
      location_id: data.location_id,
    });
    return res.json({ success: true, scheduled: data });
  } catch (err) {
    logger.error('calendar.schedule.unhandled', { user_id: userId, error: err?.message });
    return res.status(500).json({ success: false, error: 'Failed to schedule post', details: err.message });
  }
});

router.patch('/schedule/:id', async (req, res) => {
  const userId = req.user?.userId;
  const { id } = req.params;
  try {
    const patch = {};
    if (typeof req.body?.content === 'string') patch.content = req.body.content;
    if (req.body?.scheduledTime) {
      const when = new Date(req.body.scheduledTime);
      if (Number.isNaN(when.getTime())) {
        return res.status(400).json({ success: false, error: 'scheduledTime must be a valid ISO timestamp' });
      }
      patch.scheduled_time = when.toISOString();
    }
    if (req.body?.postType) patch.post_type = req.body.postType;
    if (req.body?.callToAction !== undefined) patch.call_to_action = req.body.callToAction || null;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields provided' });
    }

    // Ownership + state guard: only editable while still 'scheduled'.
    const { data, error } = await supabase
      .from('scheduled_posts')
      .update(patch)
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'scheduled')
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Scheduled post not found or no longer editable' });
    }
    return res.json({ success: true, scheduled: data });
  } catch (err) {
    logger.error('calendar.schedule.patch_error', { user_id: userId, id, error: err?.message });
    return res.status(500).json({ success: false, error: 'Failed to update scheduled post', details: err.message });
  }
});

router.delete('/schedule/:id', async (req, res) => {
  const userId = req.user?.userId;
  const { id } = req.params;
  try {
    // Ownership + state guard: allow cancel only when 'scheduled'. Rows
    // already 'processing'/'posted'/'failed' are terminal.
    const { data, error } = await supabase
      .from('scheduled_posts')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'scheduled')
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Scheduled post not found or no longer cancellable' });
    }
    logger.info('calendar.schedule.cancelled', { user_id: userId, id });
    return res.json({ success: true, scheduled: data });
  } catch (err) {
    logger.error('calendar.schedule.delete_error', { user_id: userId, id, error: err?.message });
    return res.status(500).json({ success: false, error: 'Failed to cancel scheduled post', details: err.message });
  }
});

function parseIso(value, fallback) {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function firstMediaUrl(row) {
  if (Array.isArray(row.media_data) && row.media_data.length) {
    const m = row.media_data[0];
    return m?.thumbnailUrl || m?.source_url || m?.sourceUrl || null;
  }
  if (Array.isArray(row.media_urls) && row.media_urls.length) {
    return row.media_urls[0];
  }
  if (Array.isArray(row.media) && row.media.length) {
    const m = row.media[0];
    return typeof m === 'string' ? m : (m?.sourceUrl || m?.url || null);
  }
  return null;
}

// GET /api/calendar?from=<iso>&to=<iso>
// Returns published (social_media_posts) + scheduled (scheduled_posts) items
// within the requested window. Auth-only — reads Supabase, no Google APIs.
router.get('/', async (req, res) => {
  const userId = req.user?.userId;
  const now = new Date();
  // Default window: previous month → 2 months out. Covers the typical
  // month-view + week-view scroll without a re-fetch.
  const defFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const defTo = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
  const from = parseIso(req.query.from, defFrom);
  const to = parseIso(req.query.to, defTo);

  try {
    const [pubQ, schedQ] = await Promise.all([
      supabase
        .from('social_media_posts')
        .select('id, post_id, platform, content, media_urls, media_data, published_at, gmb_account_id, location_id')
        .eq('user_id', userId)
        .gte('published_at', from.toISOString())
        .lte('published_at', to.toISOString())
        .order('published_at', { ascending: true })
        .limit(500),
      supabase
        .from('scheduled_posts')
        .select('id, content, media, platforms, scheduled_time, status, gmb_account_id, location_id')
        .eq('user_id', userId)
        .gte('scheduled_time', from.toISOString())
        .lte('scheduled_time', to.toISOString())
        .in('status', ['scheduled'])
        .order('scheduled_time', { ascending: true })
        .limit(500),
    ]);

    if (pubQ.error) {
      logger.error('calendar.published_query_error', { user_id: userId, error: pubQ.error.message });
    }
    // scheduled_posts.gmb_* columns are new (added by migration
    // supabase/scheduled-posts-location.sql). If the migration hasn't run
    // yet the query 400s — degrade to an empty scheduled list rather than
    // 500ing the whole calendar.
    if (schedQ.error) {
      logger.warn('calendar.scheduled_query_error', { user_id: userId, error: schedQ.error.message });
    }

    const published = (pubQ.data || []).map((r) => ({
      id: r.id,
      externalId: r.post_id || null,
      kind: 'published',
      when: r.published_at,
      accountId: r.gmb_account_id || null,
      locationId: r.location_id || null,
      platform: r.platform || 'google',
      content: r.content || '',
      thumbUrl: firstMediaUrl(r),
      status: 'published',
    }));

    const scheduled = (schedQ.data || []).map((r) => ({
      id: r.id,
      externalId: null,
      kind: 'scheduled',
      when: r.scheduled_time,
      accountId: r.gmb_account_id || null,
      locationId: r.location_id || null,
      platform: (Array.isArray(r.platforms) && r.platforms[0]) || 'google',
      content: r.content || '',
      thumbUrl: firstMediaUrl(r),
      status: r.status || 'scheduled',
    }));

    logger.info('calendar.response', {
      user_id: userId,
      from: from.toISOString(),
      to: to.toISOString(),
      published_count: published.length,
      scheduled_count: scheduled.length,
    });

    res.json({
      success: true,
      published,
      scheduled,
      from: from.toISOString(),
      to: to.toISOString(),
    });
  } catch (err) {
    logger.error('calendar.unhandled', {
      user_id: userId,
      error: err?.message,
      stack: err?.stack?.slice(0, 1500),
    });
    res.status(500).json({ success: false, error: 'Failed to load calendar', details: err.message });
  }
});

module.exports = router;
