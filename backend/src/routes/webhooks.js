// Inbound webhook endpoints — unauthed by JWT, gated by shared secrets.
//
// Current webhooks:
//   POST /api/webhooks/revenuecat — RevenueCat subscription lifecycle events
//                                   (powers Analytics page trial sections)
//
// RevenueCat auth model: configure the Authorization header in the RC
// dashboard to "Bearer <REVENUECAT_WEBHOOK_SECRET>". We compare in
// constant time against the env var. No raw-body signature verification
// is used (RC doesn't ship HMAC today), so plain express.json() is fine.
//
// Always return 2xx after persisting the raw event. RC retries non-2xx
// with exponential backoff for 24h — fire-and-forget derivation lets us
// stay within the 5s webhook timeout even if the trial_states upsert is slow.

const express = require('express');
const crypto = require('crypto');
const subscriptionState = require('../services/subscriptionStateService');
const logger = require('../utils/logger');

const router = express.Router();

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// POST /api/webhooks/revenuecat
//
// RC body shape: { api_version, event: { id, type, app_user_id, product_id, … } }
// We persist the full body in subscription_events.raw and derive trial_states
// from the normalized shape (see subscriptionStateService.normalizeRcEvent).
router.post('/revenuecat', express.json({ limit: '512kb' }), async (req, res) => {
  const expectedSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!expectedSecret) {
    // Fail closed — never accept events when the secret isn't configured.
    logger.error('revenuecat.webhook.secret_missing', {});
    return res.status(503).json({ error: 'webhook not configured' });
  }

  const authHeader = req.get('authorization') || '';
  const presented = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader; // RC lets you set any header value; accept both forms.

  if (!timingSafeEqual(presented, expectedSecret)) {
    logger.warn('revenuecat.webhook.unauthorized', {
      ip: req.ip,
      hasHeader: !!authHeader,
    });
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body || {};
  const evt = body?.event || {};
  const eventType = String(evt.type || '').toUpperCase();

  // RC fires TEST events from the dashboard's "Send test event" button. Log
  // + 200 them so the dashboard shows success, but skip ingestion so a test
  // doesn't pollute trial_states.
  if (eventType === 'TEST') {
    logger.info('revenuecat.webhook.test_event', {
      eventId: evt.id,
      appUserId: evt.app_user_id,
    });
    return res.json({ ok: true, test: true });
  }

  try {
    const result = await subscriptionState.ingestEvent(body);
    logger.info('revenuecat.webhook.ingested', {
      eventId: evt.id,
      eventType,
      appUserId: evt.app_user_id,
      productId: evt.product_id,
      duplicate: result.duplicate,
      stateChanged: result.stateChanged,
      newState: result.newState,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('revenuecat.webhook.ingest_failed', {
      eventId: evt.id,
      eventType,
      appUserId: evt.app_user_id,
      error: err.message,
    });
    // Return 500 so RC retries — ingestion errors are typically transient
    // (Supabase blip). Dedupe on event_id makes retries safe.
    return res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
