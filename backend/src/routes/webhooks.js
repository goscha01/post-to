// Inbound webhook endpoints — unauthed by JWT, gated by shared secrets.
//
// Current webhooks:
//   POST /api/webhooks/subscription-event
//     Apple App Store Server Notifications V2 (and later Google Play RTDN),
//     forwarded by proof-pix-proxy after it verifies the signedPayload.
//     Powers the Analytics page's live Active trials / Post-trial outcome
//     sections. Bearer-authed with SUBSCRIPTION_WEBHOOK_SECRET.
//
// A deprecated /api/webhooks/revenuecat alias accepts the same body (RC
// shape) for a 7-day grace period while any legacy traffic migrates. Will
// be removed after confirming zero RC hits for a full week.
//
// Always return 2xx after persisting the raw event. The proxy retries on
// non-2xx; dedupe on event_id makes replays safe.

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

// Shared handler for both the current and the deprecated-alias routes.
async function handleSubscriptionWebhook(req, res) {
  // SUBSCRIPTION_WEBHOOK_SECRET is the current name; REVENUECAT_WEBHOOK_SECRET
  // is read as a transitional fallback so the switchover doesn't need a
  // simultaneous env-var rotation + deploy. Delete the fallback once the
  // rename is confirmed everywhere.
  const expectedSecret = process.env.SUBSCRIPTION_WEBHOOK_SECRET || process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!expectedSecret) {
    logger.error('subscription.webhook.secret_missing', {});
    return res.status(503).json({ error: 'webhook not configured' });
  }

  const authHeader = req.get('authorization') || '';
  const presented = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader; // some callers send the raw token without the Bearer prefix.

  if (!timingSafeEqual(presented, expectedSecret)) {
    logger.warn('subscription.webhook.unauthorized', {
      ip: req.ip,
      hasHeader: !!authHeader,
    });
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body || {};

  // TEST events are an explicit smoke-test path from either the proxy or a
  // manual curl. Logged + 200'd but not persisted so test traffic doesn't
  // pollute trial_states. Checks both Apple's top-level notificationType and
  // the legacy RC shape (event.type).
  const notificationType =
    String(body.notificationType || body.event?.type || '').toUpperCase();
  if (notificationType === 'TEST') {
    logger.info('subscription.webhook.test_event', {
      source: body.notificationType ? 'apple' : 'rc_legacy',
      notificationUUID: body.notificationUUID || body.event?.id || null,
    });
    return res.json({ ok: true, test: true });
  }

  try {
    const result = await subscriptionState.ingestEvent(body);
    logger.info('subscription.webhook.ingested', {
      notificationUUID: body.notificationUUID || body.event?.id || null,
      notificationType,
      subtype: body.subtype || null,
      productId: body.productId || body.event?.product_id || null,
      duplicate: result.duplicate,
      stateChanged: result.stateChanged,
      newState: result.newState,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('subscription.webhook.ingest_failed', {
      notificationUUID: body.notificationUUID || body.event?.id || null,
      notificationType,
      error: err.message,
    });
    // Return 500 so the caller retries — ingestion errors are typically
    // transient (Supabase blip). Dedupe on event_id makes retries safe.
    return res.status(err.status || 500).json({ error: err.message });
  }
}

router.post('/subscription-event', express.json({ limit: '512kb' }), handleSubscriptionWebhook);

// Deprecated alias — delete once the proxy has fully migrated and we've
// confirmed zero traffic on this path for 7 days.
router.post('/revenuecat', express.json({ limit: '512kb' }), handleSubscriptionWebhook);

module.exports = router;
