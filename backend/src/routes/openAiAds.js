// Read-only OpenAI Ads (ads.openai.com) dashboard routes.
//
// Every route is authMiddleware-guarded. The OpenAI Ads API key is resolved
// from either ?connectionId=<uuid> (looked up in connected_accounts) or,
// as a dev shortcut, the OPENAI_ADS_API_KEY env var.
//
// No mutate endpoints. This is a diagnostics + JSON export surface, matching
// the same shape as /api/google-ads.

const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const openAiAds = require('../services/openAiAdsService');
const connectionsService = require('../services/connectionsService');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authMiddleware);

function parseDays(raw, fallback = 30) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  if (n > 365) return 365;
  return n;
}

function sendUpstream(res, err, event) {
  const status = err.status || 500;
  const payload = { error: err.message, code: err.code };
  if (err.code === 'UNAUTHORIZED') payload.needsReauth = true;
  logger.warn(event, { status, code: err.code, message: err.message });
  res.status(status).json(payload);
}

// Diagnose: does the user have a key + does it authenticate.
router.get('/_diagnose', async (req, res) => {
  try {
    const out = await openAiAds.diagnose({
      userId: req.user.userId,
      connectionId: req.query.connectionId,
    });
    res.json(out);
  } catch (err) {
    logger.error('openAiAds.diagnose_failed', { error: err.message });
    res.status(500).json({ error: 'Diagnose failed', message: err.message });
  }
});

// List the current user's OpenAI Ads connections (mirrors what /api/connections
// returns, filtered to just openai_ads for convenience — same api_key stripping
// applies).
router.get('/connected', async (req, res) => {
  try {
    const rows = await connectionsService.listForUser(req.user.userId);
    const filtered = rows.filter(r => r.provider === 'openai_ads');
    res.json({ connections: filtered });
  } catch (err) {
    logger.error('openAiAds.connected_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to list connections' });
  }
});

router.get('/campaigns', async (req, res) => {
  try {
    const data = await openAiAds.getCampaigns({
      userId: req.user.userId,
      connectionId: req.query.connectionId,
    });
    res.json({ campaigns: data });
  } catch (err) {
    return sendUpstream(res, err, 'openAiAds.campaigns_failed');
  }
});

router.get('/ad-groups', async (req, res) => {
  try {
    const data = await openAiAds.getAdGroups({
      userId: req.user.userId,
      connectionId: req.query.connectionId,
    });
    res.json({ adGroups: data });
  } catch (err) {
    return sendUpstream(res, err, 'openAiAds.ad_groups_failed');
  }
});

router.get('/ads', async (req, res) => {
  try {
    const data = await openAiAds.getAds({
      userId: req.user.userId,
      connectionId: req.query.connectionId,
    });
    res.json({ ads: data });
  } catch (err) {
    return sendUpstream(res, err, 'openAiAds.ads_failed');
  }
});

// Insights. Query params:
//   scope=account|campaign|ad_group|ad (default: account)
//   id=<entity id> — required when scope != account
//   days=1..365 (default: 30)
//   granularity=hourly|daily|monthly|none (default: daily)
//   aggregationLevel=ad_account|campaign|ad_group|ad — optional row entity
router.get('/insights', async (req, res) => {
  try {
    const data = await openAiAds.getInsights({
      userId: req.user.userId,
      connectionId: req.query.connectionId,
      scope: req.query.scope || 'account',
      days: parseDays(req.query.days),
      granularity: req.query.granularity || 'daily',
      aggregationLevel: req.query.aggregationLevel || null,
      id: req.query.id || null,
    });
    res.json({ insights: data });
  } catch (err) {
    return sendUpstream(res, err, 'openAiAds.insights_failed');
  }
});

module.exports = router;
