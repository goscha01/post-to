// Meta Marketing API — read-only reporting client.
//
// PHASE 1A of the Meta Ads integration (see docs/meta-ads-implementation-plan.md).
// Every method here is a GET against the Marketing API. There are no mutate
// endpoints. The read-only invariant is enforced by grep:
//   grep -RE "axios\.(post|delete|put|patch)" backend/src/services/metaAdsService.js
// must return nothing.
//
// Design constraints:
//   - Direct axios, no facebook-nodejs-business-sdk dep (same pattern as
//     googleAdsService.js and the organic-posting metaService.js).
//   - Pinned to META_ADS_API_VERSION (env, default v23.0) — separate from the
//     organic-posting META_GRAPH_VERSION so their lifecycles are independent.
//   - Auth: caller passes a long-lived Meta user access token (retrieved via
//     connectionsService.getMetaOwnerToken). This service does NOT resolve
//     user identity or ownership — that's the route layer's job in Phase 1B.
//     Every method takes the token explicitly.
//   - Ad accounts are addressed as `act_<numeric_id>`. Any leading `act_` is
//     stripped and re-added by normalizeAdAccountId to protect against
//     double-prefixing.
//
// What "results" and "cost_per_result" mean here:
//   Meta's Marketing API does NOT return scalar `results` / `cost_per_result`
//   fields — those are Ads Manager UI constructs derived from the campaign's
//   `objective` and the corresponding action_type in the returned `actions[]`
//   array. The normalization layer below (normalizeInsights) surfaces the raw
//   actions/action_values arrays plus the standard scalars (spend, impressions,
//   clicks, ctr, cpc, cpm, reach, frequency) verbatim, and exposes a helper
//   pickResultForObjective(objective, insights) that Phase 1C diagnostics /
//   1D optimization-report code can call to derive the appropriate result
//   metric per campaign objective. We do NOT invent a universal `results`
//   scalar in the base shape.

const axios = require('axios');
const logger = require('../utils/logger');

// v23.0 as of 2026-08 — active through Oct 8, 2027 per Meta's changelog
// (12+ month runway). Bump when META_ADS_API_VERSION is changed via env or
// when Meta announces the next sunset. Marketing API breaking changes hit
// harder than Graph API, so verify against a real account after upgrading.
const API_VERSION = process.env.META_ADS_API_VERSION || 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;

// Meta's default insights page size is 25; 500 is the documented max. Larger
// pages cut round-trip count on high-cardinality reads (per-ad insights on a
// big account) but Meta occasionally soft-fails on 500 with a timeout —
// 200 is the sweet spot we've seen elsewhere.
const DEFAULT_INSIGHTS_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 100;
// Safety cap on pagination loops. Meta's paging can technically go forever;
// we stop after this many pages to avoid runaway loops on malformed cursors.
const MAX_PAGES = 25;

// -------- normalization helpers --------

function normalizeAdAccountId(id) {
  const s = String(id || '').trim();
  if (!s) return null;
  // Strip any leading `act_`, keep only the numeric id, re-add prefix.
  const numeric = s.replace(/^act_/i, '').replace(/[^0-9]/g, '');
  if (!numeric) return null;
  return `act_${numeric}`;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Meta returns most metrics as strings (their JSON convention). Normalize to
// numbers on the way out so downstream code does not have to.
function toNum(v, fallback = 0) {
  const n = numberOrNull(v);
  return n === null ? fallback : n;
}

// -------- error normalization --------

// Meta error envelope: { error: { message, type, code, error_subcode, fbtrace_id } }
// Map to a stable shape the routes/UI can key on. See the parallel function
// in metaService.js — same shape, but with a `scope` hint distinguishing
// ads_read-required errors so the UI can prompt for just the ads reconnect.
function normalizeApiError(err) {
  const status = err.response?.status || 500;
  const fbErr = err.response?.data?.error;
  const message = fbErr?.message || err.message || 'Meta Marketing API error';
  const code = fbErr?.code;
  const type = fbErr?.type;
  const subcode = fbErr?.error_subcode;

  const needsReauth =
    code === 190 ||   // OAuth token invalid / expired
    subcode === 458 || // App not installed for this user
    subcode === 463 || // Session expired
    subcode === 467;   // Invalid access token

  // Code classification for missing ads_read scope. Verified against a live
  // Spotless token that has organic scopes but no ads_read — Meta returns
  // code 100 "Unsupported get request" (not a permission-shaped message) on
  // /me/adaccounts and similar. Since this normalizer is only invoked from
  // Marketing API calls, we can treat these codes as scope-related without
  // ambiguity:
  //   - 10  → permission denied
  //   - 100 → unsupported get request (Meta's misleading code for
  //           "missing scope on Marketing API endpoint" — verified live)
  //   - 200 → generic permission error subcode family
  const isAdsPermissionMissing =
    code === 10 ||
    code === 100 ||
    code === 200 ||
    (typeof message === 'string' && /ads_read|ads_management|permission/i.test(message));

  return {
    status,
    message,
    code: code ?? null,
    type: type ?? null,
    subcode: subcode ?? null,
    needsReauth,
    // needsAdsScope is only meaningful when needsReauth is false — otherwise
    // the whole token is dead and reauthing gets everything back.
    needsAdsScope: !needsReauth && isAdsPermissionMissing,
    fbtraceId: fbErr?.fbtrace_id ?? null,
  };
}

// Wrap an axios error into a shaped Error the router can inspect. Rejects
// as an error but carries the normalized envelope on the `.normalized`
// property so routes can `if (e.normalized?.needsAdsScope) …`.
function wrapError(err, context = {}) {
  const normalized = normalizeApiError(err);
  const wrapped = new Error(normalized.message);
  wrapped.status = normalized.status;
  wrapped.code = normalized.code;
  wrapped.normalized = normalized;
  wrapped.context = context;
  logger.warn('metaAds.api_error', {
    ...context,
    status: normalized.status,
    code: normalized.code,
    subcode: normalized.subcode,
    needsReauth: normalized.needsReauth,
    needsAdsScope: normalized.needsAdsScope,
    message: normalized.message,
  });
  return wrapped;
}

// -------- generic paginated GET --------

// Meta returns { data: [...], paging: { cursors: { after }, next } } on list
// endpoints. Walk pages until `paging.next` is absent or MAX_PAGES is hit.
// Every list method below funnels through here.
async function pagedGet(url, params, { accessToken, context = {} } = {}) {
  const rows = [];
  let nextUrl = url;
  let nextParams = { ...params, access_token: accessToken };
  let pages = 0;

  while (nextUrl && pages < MAX_PAGES) {
    let res;
    try {
      res = await axios.get(nextUrl, {
        params: nextParams,
        timeout: 30000,
      });
    } catch (err) {
      throw wrapError(err, { ...context, page: pages });
    }
    const body = res.data || {};
    if (Array.isArray(body.data)) rows.push(...body.data);
    const next = body.paging?.next;
    if (!next) break;
    // Meta's `next` is a fully-formed URL with all params baked in — use it
    // directly and stop passing our own params so we don't double up.
    nextUrl = next;
    nextParams = undefined;
    pages += 1;
  }

  return rows;
}

// -------- ad account discovery --------

// GET /me/adaccounts — every ad account this user's token can see. Includes
// both accounts they own and accounts shared with them via Business Manager.
// Filters are applied client-side (numeric account_id present, not disabled).
async function listAdAccounts(accessToken) {
  if (!accessToken) throw new Error('accessToken required');
  const url = `${GRAPH_BASE}/me/adaccounts`;
  const rows = await pagedGet(
    url,
    {
      fields:
        'id,account_id,name,account_status,currency,timezone_name,timezone_offset_hours_utc,business,business_country_code,disable_reason,amount_spent,spend_cap',
      limit: DEFAULT_PAGE_LIMIT,
    },
    { accessToken, context: { op: 'listAdAccounts' } }
  );
  return rows.map((r) => ({
    id: r.id, // "act_<numeric>"
    adAccountId: r.id,
    accountIdNumeric: r.account_id || String(r.id || '').replace(/^act_/, ''),
    name: r.name || null,
    // Meta account_status: 1=ACTIVE, 2=DISABLED, 3=UNSETTLED, 7=PENDING_RISK_REVIEW,
    // 8=PENDING_SETTLEMENT, 9=IN_GRACE_PERIOD, 100=PENDING_CLOSURE,
    // 101=CLOSED, 201=ANY_ACTIVE, 202=ANY_CLOSED.
    accountStatus: numberOrNull(r.account_status),
    currency: r.currency || null,
    timezoneName: r.timezone_name || null,
    timezoneOffsetHoursUtc: numberOrNull(r.timezone_offset_hours_utc),
    business: r.business
      ? { id: r.business.id, name: r.business.name || null }
      : null,
    businessCountryCode: r.business_country_code || null,
    disableReason: numberOrNull(r.disable_reason),
    amountSpent: toNum(r.amount_spent, 0),
    spendCap: toNum(r.spend_cap, 0),
  }));
}

// GET /act_{id} — one ad account's descriptor. Used to enrich a picked
// account for the Connections UI + as a health check that our token still
// has access.
async function describeAdAccount({ accessToken, adAccountId }) {
  if (!accessToken) throw new Error('accessToken required');
  const acct = normalizeAdAccountId(adAccountId);
  if (!acct) throw new Error('adAccountId required');
  const url = `${GRAPH_BASE}/${acct}`;
  try {
    const res = await axios.get(url, {
      params: {
        access_token: accessToken,
        fields:
          'id,account_id,name,account_status,currency,timezone_name,timezone_offset_hours_utc,business,business_country_code,disable_reason,amount_spent,spend_cap',
      },
      timeout: 20000,
    });
    const r = res.data || {};
    return {
      id: r.id,
      adAccountId: r.id,
      accountIdNumeric:
        r.account_id || String(r.id || '').replace(/^act_/, ''),
      name: r.name || null,
      accountStatus: numberOrNull(r.account_status),
      currency: r.currency || null,
      timezoneName: r.timezone_name || null,
      timezoneOffsetHoursUtc: numberOrNull(r.timezone_offset_hours_utc),
      business: r.business
        ? { id: r.business.id, name: r.business.name || null }
        : null,
      businessCountryCode: r.business_country_code || null,
      disableReason: numberOrNull(r.disable_reason),
      amountSpent: toNum(r.amount_spent, 0),
      spendCap: toNum(r.spend_cap, 0),
    };
  } catch (err) {
    throw wrapError(err, { op: 'describeAdAccount', adAccountId: acct });
  }
}

// -------- date range helpers --------

// Meta accepts either `date_preset` or `time_range: { since, until }`. We
// use time_range so callers can pass an arbitrary N-day lookback. Meta docs
// use YYYY-MM-DD in the account's timezone; we send UTC dates and let Meta
// interpret them in the ad account's timezone.
function timeRangeForDays(days) {
  // `Number(days) || 30` would treat 0 as falsy and silently upgrade it to
  // 30 — surprising for callers. Instead, coerce, default only when NaN,
  // then clamp to [1, 365].
  const coerced = Number(days);
  const raw = Number.isFinite(coerced) ? coerced : 30;
  const n = Math.min(Math.max(1, raw), 365);
  const now = new Date();
  const until = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - (n - 1) * 86_400_000);
  const since = start.toISOString().slice(0, 10);
  return { since, until };
}

// -------- entity list reads (campaigns, ad sets, ads, creatives) --------

// GET /act_{id}/campaigns — fields validated against v23.0 reference (see
// docs/meta-ads-implementation-plan.md § 1A validation).
async function getCampaigns({ accessToken, adAccountId, days = 30 } = {}) {
  if (!accessToken) throw new Error('accessToken required');
  const acct = normalizeAdAccountId(adAccountId);
  if (!acct) throw new Error('adAccountId required');
  const url = `${GRAPH_BASE}/${acct}/campaigns`;
  const rows = await pagedGet(
    url,
    {
      fields: [
        'id',
        'name',
        'status',
        'effective_status',
        'objective',
        'buying_type',
        'daily_budget',
        'lifetime_budget',
        'budget_remaining',
        'spend_cap',
        'start_time',
        'stop_time',
        'created_time',
        'updated_time',
        'special_ad_categories',
        'issues_info',
      ].join(','),
      limit: DEFAULT_PAGE_LIMIT,
    },
    { accessToken, context: { op: 'getCampaigns', adAccountId: acct } }
  );

  const range = timeRangeForDays(days);
  return rows.map((r) => ({
    id: r.id,
    name: r.name || null,
    status: r.status || null,
    effectiveStatus: r.effective_status || null,
    objective: r.objective || null,
    buyingType: r.buying_type || null,
    dailyBudget: toNum(r.daily_budget, 0), // minor currency units (e.g. cents)
    lifetimeBudget: toNum(r.lifetime_budget, 0),
    budgetRemaining: toNum(r.budget_remaining, 0),
    spendCap: toNum(r.spend_cap, 0),
    startTime: r.start_time || null,
    stopTime: r.stop_time || null,
    createdTime: r.created_time || null,
    updatedTime: r.updated_time || null,
    specialAdCategories: Array.isArray(r.special_ad_categories)
      ? r.special_ad_categories
      : [],
    // issues_info shape is documented as list<AdCampaignIssuesInfo> but Meta
    // does not publish the inner schema — pass through raw. Phase 1C surfaces
    // this verbatim in Diagnostics.
    issuesInfo: Array.isArray(r.issues_info) ? r.issues_info : [],
    // The insights window this row's diagnostics *would* correspond to.
    // Callers overlay actual insights separately via getInsights().
    _dateRange: range,
  }));
}

// GET /act_{id}/adsets — includes learning_stage_info (raw pass-through: shape
// is documented as AdCampaignLearningStageInfo but Meta doesn't publish the
// inner schema).
async function getAdSets({ accessToken, adAccountId, days = 30 } = {}) {
  if (!accessToken) throw new Error('accessToken required');
  const acct = normalizeAdAccountId(adAccountId);
  if (!acct) throw new Error('adAccountId required');
  const url = `${GRAPH_BASE}/${acct}/adsets`;
  const rows = await pagedGet(
    url,
    {
      fields: [
        'id',
        'name',
        'status',
        'effective_status',
        'campaign_id',
        'optimization_goal',
        'billing_event',
        'bid_amount',
        'bid_strategy',
        'daily_budget',
        'lifetime_budget',
        'budget_remaining',
        'start_time',
        'end_time',
        'created_time',
        'updated_time',
        'promoted_object',
        'issues_info',
        'learning_stage_info',
      ].join(','),
      limit: DEFAULT_PAGE_LIMIT,
    },
    { accessToken, context: { op: 'getAdSets', adAccountId: acct } }
  );

  const range = timeRangeForDays(days);
  return rows.map((r) => ({
    id: r.id,
    name: r.name || null,
    status: r.status || null,
    effectiveStatus: r.effective_status || null,
    campaignId: r.campaign_id || null,
    optimizationGoal: r.optimization_goal || null,
    billingEvent: r.billing_event || null,
    bidAmount: toNum(r.bid_amount, 0),
    bidStrategy: r.bid_strategy || null,
    dailyBudget: toNum(r.daily_budget, 0),
    lifetimeBudget: toNum(r.lifetime_budget, 0),
    budgetRemaining: toNum(r.budget_remaining, 0),
    startTime: r.start_time || null,
    endTime: r.end_time || null,
    createdTime: r.created_time || null,
    updatedTime: r.updated_time || null,
    promotedObject: r.promoted_object || null,
    issuesInfo: Array.isArray(r.issues_info) ? r.issues_info : [],
    learningStageInfo: r.learning_stage_info || null,
    _dateRange: range,
  }));
}

// GET /act_{id}/ads — one row per ad. Creative reference is expanded so the
// diagnostics can inspect creative type without a second round-trip.
async function getAds({ accessToken, adAccountId, days = 30 } = {}) {
  if (!accessToken) throw new Error('accessToken required');
  const acct = normalizeAdAccountId(adAccountId);
  if (!acct) throw new Error('adAccountId required');
  const url = `${GRAPH_BASE}/${acct}/ads`;
  const rows = await pagedGet(
    url,
    {
      fields: [
        'id',
        'name',
        'status',
        'effective_status',
        'campaign_id',
        'adset_id',
        'creative{id,name,thumbnail_url,effective_object_story_id}',
        'created_time',
        'updated_time',
        'issues_info',
      ].join(','),
      limit: DEFAULT_PAGE_LIMIT,
    },
    { accessToken, context: { op: 'getAds', adAccountId: acct } }
  );

  const range = timeRangeForDays(days);
  return rows.map((r) => ({
    id: r.id,
    name: r.name || null,
    status: r.status || null,
    effectiveStatus: r.effective_status || null,
    campaignId: r.campaign_id || null,
    adSetId: r.adset_id || null,
    creative: r.creative
      ? {
          id: r.creative.id || null,
          name: r.creative.name || null,
          thumbnailUrl: r.creative.thumbnail_url || null,
          effectiveObjectStoryId:
            r.creative.effective_object_story_id || null,
        }
      : null,
    createdTime: r.created_time || null,
    updatedTime: r.updated_time || null,
    issuesInfo: Array.isArray(r.issues_info) ? r.issues_info : [],
    _dateRange: range,
  }));
}

// GET /act_{id}/adcreatives — standalone list. Ad rows above already embed
// a minimal creative reference; this endpoint is for the creatives tab which
// shows every creative independent of whether it's currently attached to an ad.
async function getAdCreatives({ accessToken, adAccountId } = {}) {
  if (!accessToken) throw new Error('accessToken required');
  const acct = normalizeAdAccountId(adAccountId);
  if (!acct) throw new Error('adAccountId required');
  const url = `${GRAPH_BASE}/${acct}/adcreatives`;
  const rows = await pagedGet(
    url,
    {
      fields: [
        'id',
        'name',
        'title',
        'body',
        'image_url',
        'image_hash',
        'thumbnail_url',
        'video_id',
        'object_story_id',
        'effective_object_story_id',
        'call_to_action_type',
        'status',
      ].join(','),
      limit: DEFAULT_PAGE_LIMIT,
    },
    { accessToken, context: { op: 'getAdCreatives', adAccountId: acct } }
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name || null,
    title: r.title || null,
    body: r.body || null,
    imageUrl: r.image_url || null,
    imageHash: r.image_hash || null,
    thumbnailUrl: r.thumbnail_url || null,
    videoId: r.video_id || null,
    objectStoryId: r.object_story_id || null,
    effectiveObjectStoryId: r.effective_object_story_id || null,
    callToActionType: r.call_to_action_type || null,
    status: r.status || null,
  }));
}

// -------- insights (the metrics endpoint) --------

// GET /{node}/insights. `node` is one of:
//   - `act_<id>` (account-level totals; use level='ad', 'adset', 'campaign',
//     or 'account' to change aggregation)
//   - a single campaign/adset/ad id
// The Meta docs use the `level` parameter to control aggregation when hitting
// the account. Callers pick which they want.
//
// Fields requested are the full set our normalizer expects. Meta silently
// omits fields it can't compute (e.g. no purchases → no purchase_roas), so
// downstream code must tolerate absent fields.
async function getInsights({
  accessToken,
  node,
  level = 'ad',
  days = 30,
  breakdowns = [],
  limit = DEFAULT_INSIGHTS_LIMIT,
} = {}) {
  if (!accessToken) throw new Error('accessToken required');
  if (!node) throw new Error('node required');
  const validLevels = new Set(['account', 'campaign', 'adset', 'ad']);
  if (!validLevels.has(level)) throw new Error(`invalid level: ${level}`);

  const range = timeRangeForDays(days);
  const url = `${GRAPH_BASE}/${node}/insights`;
  const params = {
    level,
    time_range: JSON.stringify(range),
    fields: [
      'account_id',
      'account_currency',
      'campaign_id',
      'campaign_name',
      'adset_id',
      'adset_name',
      'ad_id',
      'ad_name',
      'spend',
      'impressions',
      'reach',
      'frequency',
      'clicks',
      'ctr',
      'cpc',
      'cpm',
      'cpp',
      'actions',
      'action_values',
      'cost_per_action_type',
      'purchase_roas',
      'website_purchase_roas',
      'video_p25_watched_actions',
      'video_p50_watched_actions',
      'video_p75_watched_actions',
      'video_p100_watched_actions',
      'video_avg_time_watched_actions',
      'unique_clicks',
      'unique_ctr',
      'date_start',
      'date_stop',
    ].join(','),
    limit,
  };
  if (breakdowns.length) params.breakdowns = breakdowns.join(',');

  const rawRows = await pagedGet(url, params, {
    accessToken,
    context: { op: 'getInsights', node, level, breakdowns },
  });

  return {
    dateRange: range,
    level,
    breakdowns,
    rows: rawRows.map(normalizeInsightsRow),
  };
}

// -------- delivery issues aggregation --------

// Fan out to campaigns + adsets + ads and pluck any issues_info entries. The
// Marketing API has no dedicated "give me all delivery issues" endpoint — we
// have to walk each level and pull the field. Returns a flat list keyed by
// entity type/id.
async function getDeliveryIssues({ accessToken, adAccountId } = {}) {
  if (!accessToken) throw new Error('accessToken required');
  const acct = normalizeAdAccountId(adAccountId);
  if (!acct) throw new Error('adAccountId required');

  const [campaigns, adsets, ads] = await Promise.all([
    getCampaigns({ accessToken, adAccountId: acct }),
    getAdSets({ accessToken, adAccountId: acct }),
    getAds({ accessToken, adAccountId: acct }),
  ]);

  const out = [];
  for (const c of campaigns) {
    for (const info of c.issuesInfo || []) {
      out.push({
        entityType: 'campaign',
        entityId: c.id,
        entityName: c.name,
        effectiveStatus: c.effectiveStatus,
        issue: info,
      });
    }
  }
  for (const a of adsets) {
    for (const info of a.issuesInfo || []) {
      out.push({
        entityType: 'adset',
        entityId: a.id,
        entityName: a.name,
        effectiveStatus: a.effectiveStatus,
        issue: info,
      });
    }
  }
  for (const a of ads) {
    for (const info of a.issuesInfo || []) {
      out.push({
        entityType: 'ad',
        entityId: a.id,
        entityName: a.name,
        effectiveStatus: a.effectiveStatus,
        issue: info,
      });
    }
  }
  return out;
}

// -------- pixel + custom conversions (optional metadata) --------

// GET /act_{id}/customconversions — list the account's custom conversions,
// used by Phase 1C to check whether campaigns are optimized for a
// conversion event the pixel actually fires. Returns empty on any error
// (not every account has this API surface enabled).
async function getCustomConversions({ accessToken, adAccountId } = {}) {
  if (!accessToken) throw new Error('accessToken required');
  const acct = normalizeAdAccountId(adAccountId);
  if (!acct) throw new Error('adAccountId required');
  const url = `${GRAPH_BASE}/${acct}/customconversions`;
  try {
    const rows = await pagedGet(
      url,
      {
        fields:
          'id,name,rule,event_source_id,custom_event_type,is_archived,creation_time',
        limit: DEFAULT_PAGE_LIMIT,
      },
      { accessToken, context: { op: 'getCustomConversions', adAccountId: acct } }
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name || null,
      customEventType: r.custom_event_type || null,
      eventSourceId: r.event_source_id || null,
      isArchived: !!r.is_archived,
      creationTime: r.creation_time || null,
    }));
  } catch (err) {
    // Custom conversions endpoint is not universally available — bubble up
    // the normalized error so the route can decide to skip/omit.
    throw err;
  }
}

// GET /{pixel_id} — pixel-level metadata (name + last_fired_time). Not the
// firehose of pixel events; just enough to answer "is the pixel firing?".
async function getPixel({ accessToken, pixelId } = {}) {
  if (!accessToken) throw new Error('accessToken required');
  if (!pixelId) throw new Error('pixelId required');
  const url = `${GRAPH_BASE}/${pixelId}`;
  try {
    const res = await axios.get(url, {
      params: {
        access_token: accessToken,
        fields: 'id,name,last_fired_time,is_created_by_business,code',
      },
      timeout: 20000,
    });
    const r = res.data || {};
    return {
      id: r.id,
      name: r.name || null,
      lastFiredTime: r.last_fired_time || null,
      isCreatedByBusiness: !!r.is_created_by_business,
      // We do NOT expose r.code — it's the JS snippet with the pixel id
      // baked in, unnecessary for read-only diagnostics.
    };
  } catch (err) {
    throw wrapError(err, { op: 'getPixel', pixelId });
  }
}

// -------- insights normalization --------

// One row of Insights → stable internal shape.
//
// Meta's Insights row structure (verified against v22–v25 changelog):
//   {
//     account_id, account_currency,
//     campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
//     spend, impressions, reach, frequency, clicks, ctr, cpc, cpm, cpp,
//     actions: [{ action_type, value, "1d_click"?, "7d_click"?, "1d_view"? }, ...],
//     action_values: [{ action_type, value }, ...],
//     cost_per_action_type: [{ action_type, value }, ...],
//     purchase_roas: [{ action_type, value }, ...],
//     website_purchase_roas: [{ action_type, value }, ...],
//     video_p{25,50,75,100}_watched_actions: [{ action_type, value }, ...],
//     video_avg_time_watched_actions: [{ action_type, value }, ...],
//     unique_clicks, unique_ctr,
//     date_start, date_stop,
//     // if breakdowns=publisher_platform,platform_position was passed:
//     publisher_platform, platform_position,
//     // if breakdowns=device_platform: device_platform
//     // if breakdowns=age,gender: age, gender
//     // if breakdowns=hourly_stats_aggregated_by_advertiser_time_zone:
//     //   hourly_stats_aggregated_by_advertiser_time_zone
//   }
//
// Meta omits fields it cannot compute (no purchases → no purchase_roas), so
// we handle absence uniformly. The actions/action_values/cost_per_action_type
// arrays are preserved raw AND flattened into keyed maps for easy lookup —
// pickResultForObjective() below uses the maps.
function normalizeInsightsRow(r) {
  if (!r) return null;

  // Flatten action_type-keyed arrays into { [action_type]: number } maps so
  // downstream code doesn't need to loop every time.
  const flattenActionArray = (arr) => {
    if (!Array.isArray(arr)) return {};
    const out = {};
    for (const a of arr) {
      if (a && a.action_type) {
        const v = numberOrNull(a.value);
        if (v !== null) out[a.action_type] = v;
      }
    }
    return out;
  };

  const actions = Array.isArray(r.actions) ? r.actions : [];
  const actionValues = Array.isArray(r.action_values) ? r.action_values : [];
  const costPerActionType = Array.isArray(r.cost_per_action_type)
    ? r.cost_per_action_type
    : [];
  const purchaseRoas = Array.isArray(r.purchase_roas) ? r.purchase_roas : [];
  const websitePurchaseRoas = Array.isArray(r.website_purchase_roas)
    ? r.website_purchase_roas
    : [];

  return {
    // dimension identifiers (populated based on `level`)
    accountId: r.account_id || null,
    accountCurrency: r.account_currency || null,
    campaignId: r.campaign_id || null,
    campaignName: r.campaign_name || null,
    adSetId: r.adset_id || null,
    adSetName: r.adset_name || null,
    adId: r.ad_id || null,
    adName: r.ad_name || null,

    // scalar metrics — nulls preserved so downstream code can distinguish
    // "0" from "not returned by Meta for this row"
    spend: numberOrNull(r.spend),
    impressions: numberOrNull(r.impressions),
    reach: numberOrNull(r.reach),
    frequency: numberOrNull(r.frequency),
    clicks: numberOrNull(r.clicks),
    ctr: numberOrNull(r.ctr),
    cpc: numberOrNull(r.cpc),
    cpm: numberOrNull(r.cpm),
    cpp: numberOrNull(r.cpp),
    uniqueClicks: numberOrNull(r.unique_clicks),
    uniqueCtr: numberOrNull(r.unique_ctr),

    // action arrays: preserve raw shape for callers that need attribution
    // window fields, and expose a flat map for the common case.
    actions,
    actionsByType: flattenActionArray(actions),
    actionValues,
    actionValuesByType: flattenActionArray(actionValues),
    costPerActionType,
    costPerActionTypeByType: flattenActionArray(costPerActionType),

    // ROAS — arrays keyed by action_type (usually 'purchase' or 'omni_purchase').
    purchaseRoas,
    purchaseRoasByType: flattenActionArray(purchaseRoas),
    websitePurchaseRoas,
    websitePurchaseRoasByType: flattenActionArray(websitePurchaseRoas),

    // video engagement
    videoP25: flattenActionArray(r.video_p25_watched_actions),
    videoP50: flattenActionArray(r.video_p50_watched_actions),
    videoP75: flattenActionArray(r.video_p75_watched_actions),
    videoP100: flattenActionArray(r.video_p100_watched_actions),
    videoAvgTime: flattenActionArray(r.video_avg_time_watched_actions),

    // breakdown dimensions (only present when the request included them)
    breakdowns: pickBreakdowns(r),

    dateStart: r.date_start || null,
    dateStop: r.date_stop || null,
  };
}

// Meta puts breakdown values as top-level keys on the row (e.g. row.age = '25-34').
// Copy the ones we care about into a nested breakdowns object so downstream
// code has one place to look regardless of which breakdowns were requested.
const BREAKDOWN_KEYS = [
  'publisher_platform',
  'platform_position',
  'device_platform',
  'age',
  'gender',
  'region',
  'country',
  'dma',
  'hourly_stats_aggregated_by_advertiser_time_zone',
  'hourly_stats_aggregated_by_audience_time_zone',
];
function pickBreakdowns(row) {
  const out = {};
  for (const k of BREAKDOWN_KEYS) {
    if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
  }
  return Object.keys(out).length ? out : null;
}

// Given a campaign objective + a normalized insights row, return the
// action_type that represents "results" for that objective per Meta's
// mapping. Callers can then look up:
//   row.actionsByType[resultKey] → result count
//   row.costPerActionTypeByType[resultKey] → cost per result
//
// The mapping is a subset of Meta's objective → optimization_goal → result
// action_type chain. Where the mapping is genuinely ambiguous (e.g. LEADS
// on Meta forms vs. offsite forms), we return the primary + fallbacks so
// callers can prefer the first present.
function pickResultActionTypes(objective) {
  const o = String(objective || '').toUpperCase();
  switch (o) {
    // The "outcome-driven" 2022+ objectives:
    case 'OUTCOME_LEADS':
    case 'LEAD_GENERATION':
      return ['lead', 'leadgen.other', 'onsite_conversion.lead_grouped'];
    case 'OUTCOME_SALES':
    case 'CONVERSIONS':
    case 'PRODUCT_CATALOG_SALES':
      return ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];
    case 'OUTCOME_AWARENESS':
    case 'REACH':
    case 'BRAND_AWARENESS':
      return ['reach'];
    case 'OUTCOME_TRAFFIC':
    case 'LINK_CLICKS':
      return ['link_click'];
    case 'OUTCOME_ENGAGEMENT':
    case 'POST_ENGAGEMENT':
      return ['post_engagement', 'page_engagement'];
    case 'OUTCOME_APP_PROMOTION':
    case 'APP_INSTALLS':
      return ['app_install', 'mobile_app_install'];
    case 'VIDEO_VIEWS':
      return ['video_view'];
    case 'MESSAGES':
    case 'MESSAGING_CONVERSATIONS_STARTED':
      return ['onsite_conversion.messaging_conversation_started_7d'];
    default:
      // Unknown / unsupported objective — return null so caller can decide
      // whether to omit the result column or fall back to link_click.
      return null;
  }
}

// Convenience: given an objective and a normalized insights row, return
// { results, costPerResult } or { results: null, costPerResult: null } if
// the objective has no clear result mapping OR none of the mapped action
// types are present in the row.
function pickResultForObjective(objective, row) {
  const candidates = pickResultActionTypes(objective);
  if (!candidates || !row) return { results: null, costPerResult: null };
  for (const at of candidates) {
    const count = row.actionsByType?.[at];
    if (count !== undefined && count !== null) {
      const cpr = row.costPerActionTypeByType?.[at] ?? null;
      return { results: count, costPerResult: cpr, resultActionType: at };
    }
  }
  return { results: null, costPerResult: null, resultActionType: null };
}

// -------- diagnostic / introspection helper --------

// GET /debug_token — introspect a user access token to see which scopes it
// carries. Used by the Phase 1B `/diagnose` route to distinguish "you granted
// FB Pages but not ads_read" from "your token is dead". Mirrors
// metaService.debugToken but returns a normalized shape.
async function debugToken({ inputToken }) {
  if (!inputToken) throw new Error('inputToken required');
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    const err = new Error('META_APP_ID or META_APP_SECRET not configured');
    err.status = 503;
    err.code = 'META_APP_NOT_CONFIGURED';
    throw err;
  }
  const url = `${GRAPH_BASE}/debug_token`;
  try {
    const res = await axios.get(url, {
      params: {
        input_token: inputToken,
        access_token: `${appId}|${appSecret}`,
      },
      timeout: 15000,
    });
    const d = res.data?.data || {};
    const scopes = Array.isArray(d.scopes) ? d.scopes : [];
    return {
      appId: d.app_id || null,
      userId: d.user_id || null,
      isValid: !!d.is_valid,
      expiresAt: d.expires_at ? d.expires_at * 1000 : null,
      dataAccessExpiresAt: d.data_access_expires_at
        ? d.data_access_expires_at * 1000
        : null,
      scopes,
      hasAdsRead: scopes.includes('ads_read'),
      hasAdsManagement: scopes.includes('ads_management'),
    };
  } catch (err) {
    throw wrapError(err, { op: 'debugToken' });
  }
}

module.exports = {
  // Public API
  listAdAccounts,
  describeAdAccount,
  getCampaigns,
  getAdSets,
  getAds,
  getAdCreatives,
  getInsights,
  getDeliveryIssues,
  getCustomConversions,
  getPixel,
  debugToken,

  // Normalization + helpers (exported for Phase 1C diagnostics + 1D
  // optimization-report code + tests)
  normalizeInsightsRow,
  pickResultActionTypes,
  pickResultForObjective,
  normalizeAdAccountId,
  normalizeApiError,
  timeRangeForDays,

  // Constants
  API_VERSION,
  GRAPH_BASE,

  // Internal — exported for tests only, not stable
  _internal: {
    pagedGet,
    wrapError,
    pickBreakdowns,
    BREAKDOWN_KEYS,
    DEFAULT_INSIGHTS_LIMIT,
    DEFAULT_PAGE_LIMIT,
    MAX_PAGES,
  },
};
