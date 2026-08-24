// Meta Ads read-only endpoints. Phase 1B.
//
// Every outbound call to Meta is a GET. The one non-GET route in this file
// (POST /accounts) writes only to Post-To's own Supabase — it does NOT
// mutate anything on Meta. That distinction is why the read-only invariant
// grep in the Phase 1B spec allows a POST handler here.
//
// Auth stack:
//   - authMiddleware  → app user JWT (populates req.user.userId)
//
// Meta OAuth is intentionally NOT enforced by a middleware — every endpoint
// resolves the Meta owner token via connectionsService.getMetaOwnerToken and
// returns a structured error contract (see ERROR_CODES) if it's missing or
// lacks ads_read. This means users can hit /_diagnose to figure out WHY the
// integration is broken without getting a blanket 401.
//
// Error contract (stable, machine-readable — the future MetaAds.js frontend
// keys off `code` to decide which prompt to show):
//   META_NOT_CONNECTED           → user has never granted Meta OAuth
//   META_TOKEN_INVALID           → token dead (expired/revoked); needsReauth: true
//   META_ADS_SCOPE_REQUIRED      → token alive but missing ads_read; needsAdsScope: true
//   META_NO_AD_ACCOUNTS          → /me/adaccounts returned empty
//   META_NO_SELECTION            → user hasn't picked an ad account via POST /accounts
//   META_AD_ACCOUNT_NOT_AUTHORIZED → requested act_id not among the user's saved selection
//   META_INVALID_AD_ACCOUNT_ID   → adAccountId param missing/malformed
//   META_RATE_LIMITED            → Meta returned a throttling error
//   META_UPSTREAM_ERROR          → catch-all for any other Meta API failure
//   META_APP_NOT_CONFIGURED      → server missing META_APP_ID / META_APP_SECRET

const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const svc = require('../services/metaAdsService');
const connections = require('../services/connectionsService');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authMiddleware);

// -------- constants --------

// Day-range envelope for read endpoints. Matches the GoogleAds.js frontend
// [7 / 30 / 90 / 180 / 365] selector so the UI can share the same control.
const ALLOWED_DAYS = new Set([7, 14, 30, 60, 90, 180, 365]);

// Ad-level insight fanout across a 180+ day window on a large account can
// return >100KB. The Marketing API paginates, but we cap the effective range
// for the ad-level endpoint specifically to guarantee bounded response size.
// Overview / campaigns / adsets don't need this cap because they're bounded
// by campaign count, not ad count.
const MAX_ADS_DAYS = 90;

// -------- error helpers --------

// Standard error envelope for the frontend. Every 4xx/5xx from this router
// goes through here so the shape is stable and the frontend key-off is
// consistent.
function sendErr(res, { status, code, error, needsReauth, needsAdsScope, extra }) {
  const body = {
    error,
    code,
    ...(needsReauth ? { needsReauth: true } : {}),
    ...(needsAdsScope ? { needsAdsScope: true } : {}),
    ...(extra || {}),
  };
  return res.status(status).json(body);
}

// Route a Meta API error to the appropriate error contract. Used when a
// downstream metaAdsService call throws with a `.normalized` envelope.
function sendMetaErr(res, err, context = {}) {
  const n = err.normalized || svc.normalizeApiError(err);

  // Log at warn so we can debug via Loki without erroring on user-triggered
  // 4xxs. Token values are never on `err` so this is safe.
  logger.warn('metaAds.upstream_error', {
    ...context,
    status: n.status,
    code: n.code,
    subcode: n.subcode,
    needsReauth: n.needsReauth,
    needsAdsScope: n.needsAdsScope,
    fbtraceId: n.fbtraceId,
    // Truncate to keep the log line bounded.
    message: String(n.message || '').slice(0, 300),
  });

  if (n.needsReauth) {
    return sendErr(res, {
      status: 401,
      code: 'META_TOKEN_INVALID',
      error: 'Meta access token expired or was revoked. Reconnect Meta.',
      needsReauth: true,
    });
  }
  if (n.needsAdsScope) {
    return sendErr(res, {
      status: 403,
      code: 'META_ADS_SCOPE_REQUIRED',
      error:
        'This Meta connection does not have the ads_read permission. Reconnect Meta and approve the Ads permission when prompted.',
      needsAdsScope: true,
    });
  }
  // Meta uses code 4 / subcode 17 for user-throttle, code 17 for app-throttle,
  // code 32 for page-throttle. All map to 429 for the frontend.
  if (n.code === 4 || n.code === 17 || n.code === 32 || n.status === 429) {
    return sendErr(res, {
      status: 429,
      code: 'META_RATE_LIMITED',
      error: 'Meta rate limit reached. Wait a minute and retry.',
    });
  }
  return sendErr(res, {
    status: n.status || 500,
    code: 'META_UPSTREAM_ERROR',
    error: n.message || 'Meta API error',
    extra: {
      // Include Meta's fbtrace_id when present — it's the single most useful
      // signal for filing bugs with Meta support. Never a token, never PII.
      ...(n.fbtraceId ? { fbtraceId: n.fbtraceId } : {}),
    },
  });
}

// -------- day-range helpers --------

function parseDays(req, { max = 365, fallback = 30 } = {}) {
  const raw = Number(req.query.days);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  if (!ALLOWED_DAYS.has(raw)) return fallback;
  return Math.min(raw, max);
}

// -------- authorization resolver --------
//
// Every account-scoped endpoint funnels through this. Semantics:
//   1. Fetch the user's Meta owner token from connected_accounts. If none →
//      META_NOT_CONNECTED.
//   2. Fetch the user's saved ad account selection. If empty →
//      META_NO_SELECTION (they need to POST /accounts first).
//   3. Normalize the requested adAccountId. If missing/invalid →
//      META_INVALID_AD_ACCOUNT_ID.
//   4. Require the normalized adAccountId to be in the saved selection.
//      Not being in the selection → META_AD_ACCOUNT_NOT_AUTHORIZED.
//
// We deliberately do NOT hit /me/adaccounts to validate — that would burn a
// Meta round-trip on every request. The saved selection is the source of
// truth and is refreshed each time the user calls GET /accounts.
//
// Returns { adAccountId, accessToken, metaUserId }. On any failure returns
// { error: { status, code, error, needsReauth?, needsAdsScope? } } — the
// caller uses sendErr(res, err.error) to respond.
async function resolveMetaAdAccount(userId, requestedAdAccountId) {
  const meta = await connections.getMetaOwnerToken(userId);
  if (!meta?.accessToken) {
    return {
      error: {
        status: 400,
        code: 'META_NOT_CONNECTED',
        error: 'No Meta connection found. Connect Facebook/Instagram first.',
      },
    };
  }

  const normalized = svc.normalizeAdAccountId(requestedAdAccountId);
  if (!normalized) {
    return {
      error: {
        status: 400,
        code: 'META_INVALID_AD_ACCOUNT_ID',
        error: 'adAccountId query parameter is required (format: act_<numeric>).',
      },
    };
  }

  const selection = await connections.getMetaAdAccountSelection(userId);
  if (!selection.adAccountIds.length) {
    return {
      error: {
        status: 400,
        code: 'META_NO_SELECTION',
        error:
          'No Meta ad account selected. POST /api/meta-ads/accounts to save one first.',
      },
    };
  }
  if (!selection.adAccountIds.includes(normalized)) {
    return {
      error: {
        status: 403,
        code: 'META_AD_ACCOUNT_NOT_AUTHORIZED',
        error:
          'Requested ad account is not associated with your Meta connection. Re-select from GET /accounts.',
      },
    };
  }
  return {
    adAccountId: normalized,
    accessToken: meta.accessToken,
    metaUserId: meta.metaUserId,
  };
}

// Resolve without requiring a request-specified adAccountId — falls back to
// the user's saved default. Used by /overview and the section endpoints when
// the client omits the query param.
async function resolveDefaultOrRequested(userId, requestedAdAccountId) {
  if (requestedAdAccountId) return resolveMetaAdAccount(userId, requestedAdAccountId);
  const meta = await connections.getMetaOwnerToken(userId);
  if (!meta?.accessToken) {
    return {
      error: {
        status: 400,
        code: 'META_NOT_CONNECTED',
        error: 'No Meta connection found. Connect Facebook/Instagram first.',
      },
    };
  }
  const selection = await connections.getMetaAdAccountSelection(userId);
  if (!selection.adAccountIds.length) {
    return {
      error: {
        status: 400,
        code: 'META_NO_SELECTION',
        error:
          'No Meta ad account selected. POST /api/meta-ads/accounts to save one first.',
      },
    };
  }
  return {
    adAccountId: selection.defaultAdAccountId,
    accessToken: meta.accessToken,
    metaUserId: meta.metaUserId,
  };
}

// -------- diagnose: introspect the current Meta token --------

router.get('/_diagnose', async (req, res) => {
  try {
    const meta = await connections.getMetaOwnerToken(req.user.userId);
    if (!meta?.accessToken) {
      return res.json({
        metaConnected: false,
        code: 'META_NOT_CONNECTED',
        hasAdsReadScope: false,
        hasAdsManagementScope: false,
        guidance: 'Connect Facebook via /connections to start.',
      });
    }
    let info;
    try {
      info = await svc.debugToken({ inputToken: meta.accessToken });
    } catch (err) {
      // Log but return a structured shape rather than 500 — this endpoint
      // exists specifically to explain broken states.
      logger.warn('metaAds.diagnose.debug_token_failed', {
        userId: req.user.userId,
        error: err.message,
      });
      return res.json({
        metaConnected: true,
        code: 'META_TOKEN_INTROSPECTION_FAILED',
        hasAdsReadScope: false,
        hasAdsManagementScope: false,
        error: err.message,
      });
    }
    res.json({
      metaConnected: true,
      metaUserId: info.userId,
      isValid: info.isValid,
      expiresAt: info.expiresAt,
      dataAccessExpiresAt: info.dataAccessExpiresAt,
      scopes: info.scopes,
      hasAdsReadScope: info.hasAdsRead,
      hasAdsManagementScope: info.hasAdsManagement,
      apiVersion: svc.API_VERSION,
      guidance: !info.isValid
        ? 'Token is not valid. Reconnect Meta.'
        : !info.hasAdsRead
          ? 'Token lacks ads_read. Reconnect Meta and approve the Ads permission when prompted.'
          : null,
    });
  } catch (err) {
    logger.error('metaAds.diagnose.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to diagnose Meta connection' });
  }
});

// -------- account discovery + selection --------

router.get('/accounts', async (req, res) => {
  try {
    const meta = await connections.getMetaOwnerToken(req.user.userId);
    if (!meta?.accessToken) {
      return sendErr(res, {
        status: 400,
        code: 'META_NOT_CONNECTED',
        error: 'No Meta connection found. Connect Facebook/Instagram first.',
      });
    }
    let accounts;
    try {
      accounts = await svc.listAdAccounts(meta.accessToken);
    } catch (err) {
      return sendMetaErr(res, err, { userId: req.user.userId, op: 'listAdAccounts' });
    }
    if (accounts.length === 0) {
      return sendErr(res, {
        status: 200, // 200 not 4xx — it's a valid state, just empty
        code: 'META_NO_AD_ACCOUNTS',
        error:
          'This Meta account has no accessible ad accounts. Ask an admin to grant Business Manager access.',
        extra: { accounts: [] },
      });
    }
    const selection = await connections.getMetaAdAccountSelection(req.user.userId);
    logger.info('metaAds.accounts.list_ok', {
      userId: req.user.userId,
      count: accounts.length,
      selectedCount: selection.adAccountIds.length,
    });
    res.json({
      accounts,
      selection,
    });
  } catch (err) {
    logger.error('metaAds.accounts.list_failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to list Meta ad accounts' });
  }
});

// Save the user's ad-account selection. Local-only write — does NOT mutate
// anything on Meta. Body: { adAccountIds: string[], defaultAdAccountId?: string }.
// Every id in the body must be validated against the user's actual accessible
// accounts before persistence — we don't want to accept an arbitrary act_id
// the user typed into a curl request.
router.post('/accounts', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const requested = Array.isArray(body.adAccountIds)
      ? body.adAccountIds
      : body.adAccountId
        ? [body.adAccountId]
        : [];
    if (!requested.length) {
      return sendErr(res, {
        status: 400,
        code: 'META_INVALID_AD_ACCOUNT_ID',
        error: 'adAccountIds (array) or adAccountId (string) required in body.',
      });
    }
    const normalized = [...new Set(requested.map((s) => svc.normalizeAdAccountId(s)).filter(Boolean))];
    if (!normalized.length) {
      return sendErr(res, {
        status: 400,
        code: 'META_INVALID_AD_ACCOUNT_ID',
        error: 'No valid act_<numeric> id supplied.',
      });
    }

    const meta = await connections.getMetaOwnerToken(req.user.userId);
    if (!meta?.accessToken) {
      return sendErr(res, {
        status: 400,
        code: 'META_NOT_CONNECTED',
        error: 'No Meta connection found. Connect Facebook/Instagram first.',
      });
    }

    // Validate every requested id against the user's actually-accessible list.
    let accessible;
    try {
      accessible = await svc.listAdAccounts(meta.accessToken);
    } catch (err) {
      return sendMetaErr(res, err, { userId: req.user.userId, op: 'listAdAccounts.forSelection' });
    }
    const accessibleIds = new Set(accessible.map((a) => a.id));
    const invalid = normalized.filter((id) => !accessibleIds.has(id));
    if (invalid.length) {
      return sendErr(res, {
        status: 403,
        code: 'META_AD_ACCOUNT_NOT_AUTHORIZED',
        error: `Requested ad account(s) not accessible with your Meta connection: ${invalid.join(', ')}`,
      });
    }

    const requestedDefault = body.defaultAdAccountId
      ? svc.normalizeAdAccountId(body.defaultAdAccountId)
      : null;
    const persisted = await connections.setMetaAdAccountSelection(req.user.userId, {
      adAccountIds: normalized,
      defaultAdAccountId:
        requestedDefault && normalized.includes(requestedDefault)
          ? requestedDefault
          : normalized[0],
    });
    logger.info('metaAds.accounts.selection_saved', {
      userId: req.user.userId,
      count: persisted.adAccountIds.length,
      default: persisted.defaultAdAccountId,
      rowsUpdated: persisted.rowsUpdated,
    });
    res.status(201).json({ selection: persisted });
  } catch (err) {
    if (err.code === 'META_NOT_CONNECTED') {
      return sendErr(res, {
        status: 400,
        code: 'META_NOT_CONNECTED',
        error: err.message,
      });
    }
    logger.error('metaAds.accounts.save_failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to save ad account selection' });
  }
});

// Return only the SAVED selection (no live Meta call). Cheap, used by the
// dashboard on load to know which account to render.
router.get('/connected', async (req, res) => {
  try {
    const selection = await connections.getMetaAdAccountSelection(req.user.userId);
    res.json({ selection });
  } catch (err) {
    logger.error('metaAds.connected.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to fetch selection' });
  }
});

// -------- overview --------

// Aggregate scalars + per-objective result breakdown. We deliberately do NOT
// sum "results" across objectives (leads + purchases isn't a meaningful
// number). Instead: fetch per-campaign insights, aggregate scalar KPIs
// (spend, impressions, reach avg, clicks, derived rates), and group results
// by the campaign objective's result_action_type.
router.get('/overview', async (req, res) => {
  try {
    const days = parseDays(req);
    const resolved = await resolveDefaultOrRequested(req.user.userId, req.query.adAccountId);
    if (resolved.error) return sendErr(res, resolved.error);

    const { accessToken, adAccountId } = resolved;
    let campaigns, insightsBundle;
    try {
      [campaigns, insightsBundle] = await Promise.all([
        svc.getCampaigns({ accessToken, adAccountId, days }),
        svc.getInsights({ accessToken, node: adAccountId, level: 'campaign', days }),
      ]);
    } catch (err) {
      return sendMetaErr(res, err, { userId: req.user.userId, op: 'overview', adAccountId });
    }

    const insights = insightsBundle.rows;
    const objectiveByCampaign = new Map(campaigns.map((c) => [c.id, c.objective]));

    // Scalar aggregation — safe to sum across objectives.
    let spend = 0, impressions = 0, reach = 0, clicks = 0;
    let weightedFreqNumerator = 0; // sum(frequency * impressions)
    for (const r of insights) {
      spend += r.spend || 0;
      impressions += r.impressions || 0;
      reach += r.reach || 0;
      clicks += r.clicks || 0;
      if (r.frequency && r.impressions) {
        weightedFreqNumerator += r.frequency * r.impressions;
      }
    }
    const frequency = impressions > 0 ? weightedFreqNumerator / impressions : null;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
    const cpc = clicks > 0 ? spend / clicks : null;
    const cpm = impressions > 0 ? (spend / impressions) * 1000 : null;

    // Group results per objective. Sum results / cost within each objective;
    // never across objectives.
    const resultsByObjective = {};
    for (const r of insights) {
      const obj = objectiveByCampaign.get(r.campaignId);
      if (!obj) continue;
      const pick = svc.pickResultForObjective(obj, r);
      if (pick.results === null || pick.resultActionType === null) continue;
      const bucket =
        resultsByObjective[obj] ||
        (resultsByObjective[obj] = {
          objective: obj,
          actionType: pick.resultActionType,
          results: 0,
          spend: 0,
        });
      bucket.results += pick.results;
      bucket.spend += r.spend || 0;
    }
    for (const b of Object.values(resultsByObjective)) {
      b.costPerResult = b.results > 0 ? b.spend / b.results : null;
    }

    // Top-level `results` scalar: populate only when all campaigns share a
    // single objective + result actionType. Otherwise leave null and let
    // the frontend render the breakdown.
    const objectiveKeys = Object.keys(resultsByObjective);
    const topLevelResults =
      objectiveKeys.length === 1
        ? {
            value: resultsByObjective[objectiveKeys[0]].results,
            actionType: resultsByObjective[objectiveKeys[0]].actionType,
            label: objectiveKeys[0],
          }
        : { value: null, actionType: null, label: null };
    const topLevelCostPerResult =
      objectiveKeys.length === 1 ? resultsByObjective[objectiveKeys[0]].costPerResult : null;

    res.json({
      adAccountId,
      days,
      dateRange: insightsBundle.dateRange,
      campaignCount: campaigns.length,
      totals: {
        spend,
        impressions,
        reach,
        frequency,
        clicks,
        ctr,
        cpc,
        cpm,
      },
      results: topLevelResults,
      costPerResult: topLevelCostPerResult,
      resultsByObjective: Object.values(resultsByObjective),
    });
  } catch (err) {
    logger.error('metaAds.overview.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to compute overview' });
  }
});

// -------- entity + insights section endpoints --------

// Small helper: join a list of entities (campaigns/adsets/ads) with insights
// rows keyed by the entity id. Attaches `insights` and `derivedResults`
// (from pickResultForObjective when the entity is a campaign with a known
// objective). Missing insights → `insights: null`.
function joinEntitiesWithInsights({ entities, insightsRows, entityKey, campaignsById }) {
  const insightsById = new Map();
  for (const r of insightsRows) {
    const key = r[entityKey];
    if (key) insightsById.set(String(key), r);
  }
  return entities.map((e) => {
    const ins = insightsById.get(String(e.id)) || null;
    let derived = null;
    if (ins) {
      const objective =
        e.objective ||
        (campaignsById && e.campaignId && campaignsById.get(e.campaignId)?.objective) ||
        null;
      if (objective) {
        derived = svc.pickResultForObjective(objective, ins);
      }
    }
    return { ...e, insights: ins, derivedResults: derived };
  });
}

router.get('/campaigns', async (req, res) => {
  try {
    const days = parseDays(req);
    const resolved = await resolveDefaultOrRequested(req.user.userId, req.query.adAccountId);
    if (resolved.error) return sendErr(res, resolved.error);
    const { accessToken, adAccountId } = resolved;
    let campaigns, insightsBundle;
    try {
      [campaigns, insightsBundle] = await Promise.all([
        svc.getCampaigns({ accessToken, adAccountId, days }),
        svc.getInsights({ accessToken, node: adAccountId, level: 'campaign', days }),
      ]);
    } catch (err) {
      return sendMetaErr(res, err, { userId: req.user.userId, op: 'campaigns', adAccountId });
    }
    const rows = joinEntitiesWithInsights({
      entities: campaigns,
      insightsRows: insightsBundle.rows,
      entityKey: 'campaignId',
    });
    res.json({ adAccountId, days, dateRange: insightsBundle.dateRange, campaigns: rows });
  } catch (err) {
    logger.error('metaAds.campaigns.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to fetch campaigns' });
  }
});

router.get('/adsets', async (req, res) => {
  try {
    const days = parseDays(req);
    const resolved = await resolveDefaultOrRequested(req.user.userId, req.query.adAccountId);
    if (resolved.error) return sendErr(res, resolved.error);
    const { accessToken, adAccountId } = resolved;
    let campaigns, adsets, insightsBundle;
    try {
      [campaigns, adsets, insightsBundle] = await Promise.all([
        svc.getCampaigns({ accessToken, adAccountId, days }),
        svc.getAdSets({ accessToken, adAccountId, days }),
        svc.getInsights({ accessToken, node: adAccountId, level: 'adset', days }),
      ]);
    } catch (err) {
      return sendMetaErr(res, err, { userId: req.user.userId, op: 'adsets', adAccountId });
    }
    const campaignsById = new Map(campaigns.map((c) => [c.id, c]));
    const rows = joinEntitiesWithInsights({
      entities: adsets,
      insightsRows: insightsBundle.rows,
      entityKey: 'adSetId',
      campaignsById,
    });
    res.json({ adAccountId, days, dateRange: insightsBundle.dateRange, adsets: rows });
  } catch (err) {
    logger.error('metaAds.adsets.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to fetch ad sets' });
  }
});

router.get('/ads', async (req, res) => {
  try {
    // Ad-level fanout is the payload-heavy endpoint — cap the window.
    const requestedDays = parseDays(req);
    if (requestedDays > MAX_ADS_DAYS) {
      return sendErr(res, {
        status: 400,
        code: 'META_INVALID_DAY_RANGE',
        error: `Ad-level requests are capped at ${MAX_ADS_DAYS} days to keep payload sizes bounded. Reduce the days parameter.`,
      });
    }
    const days = requestedDays;
    const resolved = await resolveDefaultOrRequested(req.user.userId, req.query.adAccountId);
    if (resolved.error) return sendErr(res, resolved.error);
    const { accessToken, adAccountId } = resolved;
    let campaigns, ads, insightsBundle;
    try {
      [campaigns, ads, insightsBundle] = await Promise.all([
        svc.getCampaigns({ accessToken, adAccountId, days }),
        svc.getAds({ accessToken, adAccountId, days }),
        svc.getInsights({ accessToken, node: adAccountId, level: 'ad', days }),
      ]);
    } catch (err) {
      return sendMetaErr(res, err, { userId: req.user.userId, op: 'ads', adAccountId });
    }
    const campaignsById = new Map(campaigns.map((c) => [c.id, c]));
    const rows = joinEntitiesWithInsights({
      entities: ads,
      insightsRows: insightsBundle.rows,
      entityKey: 'adId',
      campaignsById,
    });
    res.json({ adAccountId, days, dateRange: insightsBundle.dateRange, ads: rows });
  } catch (err) {
    logger.error('metaAds.ads.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to fetch ads' });
  }
});

// -------- breakdown endpoints --------

function makeBreakdownRoute({ path, level, breakdowns, days = { fallback: 30, max: 90 } }) {
  router.get(path, async (req, res) => {
    try {
      const requested = parseDays(req, days);
      const resolved = await resolveDefaultOrRequested(req.user.userId, req.query.adAccountId);
      if (resolved.error) return sendErr(res, resolved.error);
      const { accessToken, adAccountId } = resolved;
      let bundle;
      try {
        bundle = await svc.getInsights({
          accessToken,
          node: adAccountId,
          level,
          days: requested,
          breakdowns,
        });
      } catch (err) {
        return sendMetaErr(res, err, {
          userId: req.user.userId,
          op: `breakdown${path}`,
          adAccountId,
          breakdowns,
        });
      }
      res.json({
        adAccountId,
        days: requested,
        dateRange: bundle.dateRange,
        breakdowns: bundle.breakdowns,
        rows: bundle.rows,
      });
    } catch (err) {
      logger.error('metaAds.breakdown.failed', {
        userId: req.user.userId,
        path,
        error: err.message,
      });
      res.status(500).json({ error: err.message || 'Failed to fetch breakdown' });
    }
  });
}

// Wire the four breakdown routes with the Phase 1A-verified breakdown string
// names. Level is 'ad' for placements/devices/demographics (finest granularity
// where Meta actually attributes conversions to a placement/device/audience
// segment) and 'campaign' for day-hour (Meta's advertiser-timezone hourly
// breakdown is documented at campaign level).
makeBreakdownRoute({
  path: '/placements',
  level: 'ad',
  breakdowns: ['publisher_platform', 'platform_position'],
});
makeBreakdownRoute({
  path: '/devices',
  level: 'ad',
  breakdowns: ['device_platform'],
});
makeBreakdownRoute({
  path: '/demographics',
  level: 'ad',
  breakdowns: ['age', 'gender'],
});
makeBreakdownRoute({
  path: '/day-hour',
  level: 'campaign',
  breakdowns: ['hourly_stats_aggregated_by_advertiser_time_zone'],
});

// -------- creatives + delivery issues --------

router.get('/creatives', async (req, res) => {
  try {
    const resolved = await resolveDefaultOrRequested(req.user.userId, req.query.adAccountId);
    if (resolved.error) return sendErr(res, resolved.error);
    const { accessToken, adAccountId } = resolved;
    let rows;
    try {
      rows = await svc.getAdCreatives({ accessToken, adAccountId });
    } catch (err) {
      return sendMetaErr(res, err, { userId: req.user.userId, op: 'creatives', adAccountId });
    }
    res.json({ adAccountId, creatives: rows });
  } catch (err) {
    logger.error('metaAds.creatives.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to fetch creatives' });
  }
});

router.get('/delivery-issues', async (req, res) => {
  try {
    const resolved = await resolveDefaultOrRequested(req.user.userId, req.query.adAccountId);
    if (resolved.error) return sendErr(res, resolved.error);
    const { accessToken, adAccountId } = resolved;
    let issues;
    try {
      issues = await svc.getDeliveryIssues({ accessToken, adAccountId });
    } catch (err) {
      return sendMetaErr(res, err, { userId: req.user.userId, op: 'deliveryIssues', adAccountId });
    }
    res.json({ adAccountId, issues });
  } catch (err) {
    logger.error('metaAds.deliveryIssues.failed', {
      userId: req.user.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message || 'Failed to fetch delivery issues' });
  }
});

// Exports for tests
module.exports = router;
module.exports._internal = {
  resolveMetaAdAccount,
  resolveDefaultOrRequested,
  joinEntitiesWithInsights,
  parseDays,
  ALLOWED_DAYS,
  MAX_ADS_DAYS,
};
