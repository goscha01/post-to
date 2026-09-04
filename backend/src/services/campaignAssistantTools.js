// Google Ads read-only tools exposed to the Campaign Assistant's chat models.
//
// Why: the chat snapshot injected at conversation-creation time is static.
// When a user asks "what's the status of ad 12345 right now?", or "did
// anything change today?", the model needs to fetch fresh data — not
// answer from a stale JSON blob.
//
// How: each tool is a thin wrapper around a googleAdsService read method.
// The customer id + OAuth token are bound at conversation load time (via
// makeExecutor) so the model NEVER sees them and can NEVER call against
// a different account.
//
// Read-only. There is no mutation tool. If you find yourself adding one,
// re-read the CAMPAIGN ASSISTANT SPEC — chat is diagnostics, mutations go
// through the plan/apply pipeline where they get user confirmation.
//
// Both OpenAI (chat completions) and Claude (messages) accept the same
// JSON Schema for function parameters, so the definition list here is
// provider-agnostic; toolsForOpenAI() / toolsForClaude() format for each.

const googleAdsService = require('./googleAdsService');
const ascAnalytics = require('./ascAnalyticsService');
const asc = require('./appStoreConnectService');
const logger = require('../utils/logger');

// Bound to what the chat handler considers safe: no 6-month lookbacks, no
// unbounded windows. Everything the snapshot already covers.
const ALLOWED_DAYS = [7, 14, 30, 60, 90];

// Row caps on tool results so a single tool call can't blow the context
// window. The model still gets the largest-signal rows because we sort
// before slicing.
const MAX_SEARCH_TERMS = 50;
const MAX_ADS = 100;
const MAX_CHANGE_EVENTS = 100;

function clampDays(v, fallback) {
  const n = parseInt(v, 10);
  return ALLOWED_DAYS.includes(n) ? n : fallback;
}

function digitsOnly(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

// Apple App Store Connect analytics tools operate on THREE data sources:
//   - The Sales & Trends synchronous report (installs, IAP counts) via ASC
//     service directly
//   - The customer reviews REST endpoint (near real-time)
//   - The App Analytics cache table (impressions, product page views, install
//     conversion rate, source-type breakdown) — populated by the cron worker
//
// Executor calls out to two different modules (asc + ascAnalytics) depending
// on which data the tool needs; both share the same credential context bound
// at conversation-load time.
const ASC_ALLOWED_DAYS = [7, 14, 30, 60, 90];
const MAX_ASC_REVIEWS = 30;

function ascClampDays(v, fallback) {
  const n = parseInt(v, 10);
  return ASC_ALLOWED_DAYS.includes(n) ? n : fallback;
}

const TOOL_DEFINITIONS = [
  {
    name: 'google_ads_get_ad_status',
    description: 'Look up the current serving status of a specific Google Ads ad by its numeric ID. Use when the user asks "check ad 12345", "is ad X running", "why isn\'t ad X delivering". Returns status (ENABLED/PAUSED/REMOVED), ad strength, and recent performance. If the ad has no impressions in the last 30 days it will not be found.',
    parameters: {
      type: 'object',
      properties: {
        adId: { type: 'string', description: 'Numeric Google Ads ad ID' },
      },
      required: ['adId'],
    },
  },
  {
    name: 'google_ads_get_campaign',
    description: 'Fetch current metrics for one campaign (impressions, clicks, cost, conversions, CPA) over a lookback window. Use when the user asks about a specific campaign\'s CURRENT performance — not for historical comparisons that are already in the snapshot.',
    parameters: {
      type: 'object',
      properties: {
        campaignId: { type: 'string', description: 'Numeric Google Ads campaign ID' },
        days: { type: 'integer', enum: ALLOWED_DAYS, description: 'Lookback window. Default 30.' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'google_ads_get_search_terms',
    description: 'List recent search terms with cost and conversions. Use to diagnose wasted spend on irrelevant queries when the user asks "what\'s eating my budget" or "any bad search terms". Results are capped to the top 50 by cost.',
    parameters: {
      type: 'object',
      properties: {
        campaignId: { type: 'string', description: 'Optional — restrict to one campaign. If omitted, uses the conversation\'s scoped campaign or account-wide.' },
        days: { type: 'integer', enum: ALLOWED_DAYS, description: 'Lookback window. Default 14.' },
      },
    },
  },
  {
    name: 'google_ads_get_recent_changes',
    description: 'List recent account changes (budget edits, status flips, keyword adds/removes, bid changes). Use when the user asks "what changed recently" or is diagnosing a performance shift after an edit.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', enum: ALLOWED_DAYS, description: 'Lookback window. Default 14.' },
      },
    },
  },
  {
    name: 'google_ads_get_diagnostics',
    description: 'Fetch a fresh aggregated diagnostic punch list — broken tracking, disapproved ads, low-quality keywords, geo mistargeting, etc. Use when the user asks "what\'s wrong with my account right now" or wants the current issue snapshot.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', enum: ALLOWED_DAYS, description: 'Lookback window. Default 14.' },
      },
    },
  },
  {
    name: 'google_ads_list_ads',
    description: 'List ads with status, approval status, and recent performance. Use when the user asks "which ads are running", "which ads are disapproved", or "show me my ads". Capped to 100 rows sorted by impressions.',
    parameters: {
      type: 'object',
      properties: {
        campaignId: { type: 'string', description: 'Optional — restrict to one campaign. If omitted, uses the conversation\'s scoped campaign or account-wide.' },
        days: { type: 'integer', enum: ALLOWED_DAYS, description: 'Lookback window. Default 14.' },
      },
    },
  },
  // -----------------------------------------------------------------------
  // Apple App Store Connect tools
  // -----------------------------------------------------------------------
  {
    name: 'asc_get_install_funnel',
    description: 'Apple App Store install funnel: impressions on the listing → product page views → app installs → install conversion rate. Use to answer "how does my App Store listing perform?", "what\'s my install conversion rate?", "is my listing converting well?" Returns totals + per-day breakdown. Reads from the analytics cache — reflects the last successful cron walk (roughly hourly). Data lag from Apple is ~24-36 hours.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', enum: ASC_ALLOWED_DAYS, description: 'Lookback window. Default 14.' },
      },
    },
  },
  {
    name: 'asc_get_installs_by_source',
    description: 'Apple App Store installs and product-page views broken down by source type: App Store Search, App Store Browse, App Referrer, Web Referrer, Campaign, etc. This is THE tool for answering "which of my paid campaigns actually drives installs?" or "what proportion of installs is organic?" Includes the top 10 campaigns under each source when Campaign is populated.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', enum: ASC_ALLOWED_DAYS, description: 'Lookback window. Default 14.' },
      },
    },
  },
  {
    name: 'asc_get_recent_reviews',
    description: 'Recent App Store customer reviews (ratings + text) across all territories. Use when the user asks "any bad reviews recently?", "what are users complaining about?", or wants sentiment context on a performance issue. Returns up to 30 reviews sorted newest-first.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Number of reviews to return, 1-30. Default 20.' },
        territory: { type: 'string', description: 'Optional ISO-3 country code (e.g. USA, GBR, JPN) to restrict to one territory.' },
      },
    },
  },
];

const TOOL_NAMES = TOOL_DEFINITIONS.map(t => t.name);

// OpenAI chat completions API tool schema (wraps ours in {type:'function', function:{...}}).
function toolsForOpenAI() {
  return TOOL_DEFINITIONS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// Anthropic messages API tool schema (input_schema instead of parameters).
function toolsForClaude() {
  return TOOL_DEFINITIONS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

// Build an executor bound to the conversation's provider contexts.
//   ctx.googleAds  = { accessToken, customerId, loginCustomerId, campaignId, userId } | null
//   ctx.asc        = { creds:{p8,issuerId,keyId}, connectionId, appId, userId } | null
//
// Tools dispatch by prefix (google_ads_* → Google Ads; asc_* → ASC). If a
// tool is called with the matching provider unconnected, execute() returns
// { error: '<provider> not connected...' } rather than throwing — the model
// then explains the gap to the user.
//
// Errors from provider APIs are ALSO returned as { error } instead of
// thrown, for the same reason: a broken tool should never kill a turn.
function makeExecutor(context) {
  const gaCtx = context?.googleAds || null;
  const ascCtx = context?.asc || null;
  const anyAvailable = !!(gaCtx?.accessToken && gaCtx?.customerId) || !!(ascCtx?.creds && ascCtx?.connectionId);

  if (!anyAvailable) {
    return {
      available: false,
      execute: async () => ({
        error: 'No provider (Google Ads or App Store Connect) is connected for this conversation.',
      }),
    };
  }

  const gaOpts = gaCtx ? { loginCustomerId: gaCtx.loginCustomerId || null } : null;
  const userIdForLog = gaCtx?.userId || ascCtx?.userId || null;

  async function execute(name, args = {}) {
    const t0 = Date.now();
    try {
      const result = await dispatch(name, args);
      logger.info('campaignAssistant.tool_ok', {
        userId: userIdForLog,
        tool: name,
        duration_ms: Date.now() - t0,
      });
      return result;
    } catch (err) {
      // Google Ads errors have a specific normalizer; ASC errors already carry
      // status + a readable message from asc.summarizeAppleError. Pick the
      // right path so we log useful context.
      let message = err?.message || 'tool execution failed';
      let code = null;
      if (name.startsWith('google_ads_') && googleAdsService.normalizeApiError) {
        const norm = googleAdsService.normalizeApiError(err, { endpoint: name, userId: userIdForLog });
        message = norm.message || message;
        code = norm.code || null;
      }
      logger.warn('campaignAssistant.tool_failed', {
        userId: userIdForLog,
        tool: name,
        error: String(message).slice(0, 300),
        status: err?.status || null,
        code,
        duration_ms: Date.now() - t0,
      });
      return {
        error: message,
        code: code || null,
      };
    }
  }

  async function dispatch(name, args) {
    // ---- Google Ads dispatch ----
    if (name.startsWith('google_ads_')) {
      if (!gaCtx?.accessToken || !gaCtx?.customerId) {
        return { error: 'Google Ads is not connected for this conversation. Ask the user to connect it in Connections.' };
      }
      return dispatchGoogleAds(name, args);
    }
    // ---- App Store Connect dispatch ----
    if (name.startsWith('asc_')) {
      if (!ascCtx?.creds || !ascCtx?.connectionId) {
        return { error: 'Apple App Store Connect is not connected for this conversation. Ask the user to connect it in Connections.' };
      }
      return dispatchAsc(name, args);
    }
    return { error: `Unknown tool: ${name}` };
  }

  async function dispatchAsc(name, args) {
    switch (name) {
      case 'asc_get_install_funnel': {
        const days = ascClampDays(args.days, 14);
        const funnel = await ascAnalytics.getInstallFunnel({
          connectionId: ascCtx.connectionId,
          days,
        });
        // If no data has landed yet, tell the model plainly so it doesn't
        // interpret zero-metrics as "your app has no impressions."
        if (funnel.dataCoverageDays === 0) {
          return {
            days,
            note: 'No analytics data cached yet. Apple takes 24-48 hours after the initial bootstrap to produce the first daily report; the hourly cron will populate the cache as reports become available. Ask the user to check back tomorrow, or use asc_get_recent_reviews for immediately-available data.',
            totals: funnel.totals,
          };
        }
        return funnel;
      }
      case 'asc_get_installs_by_source': {
        const days = ascClampDays(args.days, 14);
        const res = await ascAnalytics.getInstallsBySource({
          connectionId: ascCtx.connectionId,
          days,
        });
        if (!res.sources.length) {
          return {
            days,
            note: 'No source-attribution data cached yet. See asc_get_install_funnel note about the initial bootstrap lag.',
            sources: [],
          };
        }
        return res;
      }
      case 'asc_get_recent_reviews': {
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), MAX_ASC_REVIEWS);
        const territory = args.territory ? String(args.territory).toUpperCase().slice(0, 3) : null;
        if (!ascCtx.appId) return { error: 'ASC connection has no primary appId' };
        const reviews = await asc.getReviews(ascCtx.creds, {
          appId: ascCtx.appId, limit, territory,
        });
        return { count: reviews.length, territory, reviews };
      }
      default:
        return { error: `Unknown ASC tool: ${name}` };
    }
  }

  async function dispatchGoogleAds(name, args) {
    const { accessToken, customerId, campaignId: defaultCampaignId } = gaCtx;
    const baseOpts = gaOpts;
    switch (name) {
      case 'google_ads_get_ad_status': {
        const adId = digitsOnly(args.adId);
        if (!adId) return { error: 'adId required (digits only)' };
        // Search recent 30d ads for the id. This is a single GAQL call — cheap.
        const ads = await googleAdsService.getAds(accessToken, customerId, 30, baseOpts);
        const hit = (ads || []).find(a => digitsOnly(a.adId) === adId);
        if (!hit) {
          return {
            adId,
            found: false,
            note: 'Ad not found. Either the ID is wrong, the ad has zero impressions in the last 30 days, or it belongs to a different customer.',
          };
        }
        return { adId, found: true, ad: hit };
      }

      case 'google_ads_get_campaign': {
        const cid = digitsOnly(args.campaignId);
        if (!cid) return { error: 'campaignId required' };
        const days = clampDays(args.days, 30);
        const rows = await googleAdsService.getCampaigns(
          accessToken, customerId, days,
          { ...baseOpts, campaignId: cid }
        );
        const row = (rows || [])[0] || null;
        if (!row) return { days, campaignId: cid, found: false };
        return { days, campaignId: cid, found: true, campaign: row };
      }

      case 'google_ads_get_search_terms': {
        const days = clampDays(args.days, 14);
        const cid = digitsOnly(args.campaignId) || defaultCampaignId || null;
        const rows = await googleAdsService.getSearchTerms(
          accessToken, customerId, days,
          { ...baseOpts, campaignId: cid }
        );
        const sorted = (rows || [])
          .slice()
          .sort((a, b) => (b.cost || 0) - (a.cost || 0))
          .slice(0, MAX_SEARCH_TERMS);
        return {
          days,
          campaignId: cid,
          count: sorted.length,
          truncated: (rows || []).length > MAX_SEARCH_TERMS,
          searchTerms: sorted,
        };
      }

      case 'google_ads_get_recent_changes': {
        const days = clampDays(args.days, 14);
        const rows = await googleAdsService.getChangeHistory(
          accessToken, customerId, days, baseOpts
        );
        const capped = (rows || []).slice(0, MAX_CHANGE_EVENTS);
        return {
          days,
          count: capped.length,
          truncated: (rows || []).length > MAX_CHANGE_EVENTS,
          changes: capped,
        };
      }

      case 'google_ads_get_diagnostics': {
        const days = clampDays(args.days, 14);
        const diag = await googleAdsService.getDiagnostics(
          accessToken, customerId, days, baseOpts
        );
        return { days, diagnostics: diag };
      }

      case 'google_ads_list_ads': {
        const days = clampDays(args.days, 14);
        const cid = digitsOnly(args.campaignId) || defaultCampaignId || null;
        const rows = await googleAdsService.getAds(
          accessToken, customerId, days,
          { ...baseOpts, campaignId: cid }
        );
        const sorted = (rows || [])
          .slice()
          .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
          .slice(0, MAX_ADS);
        return {
          days,
          campaignId: cid,
          count: sorted.length,
          truncated: (rows || []).length > MAX_ADS,
          ads: sorted,
        };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  return {
    available: true,
    execute,
  };
}

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  toolsForOpenAI,
  toolsForClaude,
  makeExecutor,
};
