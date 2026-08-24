// Tests for backend/src/services/metaAdsService.js — Phase 1A read-only client.
//
// Strategy: intercept axios via require.cache with a table-driven fake. Each
// test sets up a route map (method + URL prefix → response) and asserts the
// service normalizes correctly.
//
// Run: npm test (from backend/)

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// --------------------------------------------------------------------------
// axios stub — table-driven fake with per-test route map + call log.
// --------------------------------------------------------------------------
const axiosState = {
  routes: [],
  calls: [],
};

function resetAxios() {
  axiosState.routes = [];
  axiosState.calls = [];
}

// Register: { method, matchUrl (substring), respond(request) → {data} | throw }
function addRoute(route) {
  axiosState.routes.push(route);
}

function findRoute(method, url) {
  for (const r of axiosState.routes) {
    if (r.method === method && url.includes(r.matchUrl)) return r;
  }
  return null;
}

const axiosStub = {
  async get(url, config = {}) {
    axiosState.calls.push({ method: 'get', url, config });
    const route = findRoute('get', url);
    if (!route) {
      const err = new Error(`no route registered for GET ${url}`);
      throw err;
    }
    const r = await route.respond({ url, config });
    if (r && r.__throw) throw r.__throw;
    return { data: r };
  },
  // Deliberately NOT implementing post/put/delete/patch — if the service
  // ever grows one, this test suite will crash the run (which is what we
  // want as a read-only invariant guard at test time).
};

// --------------------------------------------------------------------------
// Hook Module.prototype.require to swap axios BEFORE the service loads.
// --------------------------------------------------------------------------
const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === 'axios') return axiosStub;
  return originalRequire.apply(this, arguments);
};

// Silence logger warnings so test output is clean.
const loggerPath = require.resolve('../src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

// Load the service AFTER the axios stub is in place.
const svc = require('../src/services/metaAdsService');

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function metaError({ status = 400, code, subcode, message, type }) {
  const err = new Error(message || 'meta error');
  err.response = {
    status,
    data: {
      error: {
        message: message || 'meta error',
        code,
        error_subcode: subcode,
        type: type || 'OAuthException',
        fbtrace_id: 'trace_abc',
      },
    },
  };
  return err;
}

// --------------------------------------------------------------------------
// normalizeAdAccountId
// --------------------------------------------------------------------------
test('normalizeAdAccountId strips act_ prefix and re-adds it', () => {
  assert.equal(svc.normalizeAdAccountId('act_123'), 'act_123');
  assert.equal(svc.normalizeAdAccountId('123'), 'act_123');
  assert.equal(svc.normalizeAdAccountId('act_act_123'), 'act_123');
  assert.equal(svc.normalizeAdAccountId(' 123456 '), 'act_123456');
  assert.equal(svc.normalizeAdAccountId(''), null);
  assert.equal(svc.normalizeAdAccountId(null), null);
  assert.equal(svc.normalizeAdAccountId('act_'), null); // no numeric
});

// --------------------------------------------------------------------------
// normalizeApiError
// --------------------------------------------------------------------------
test('normalizeApiError flags needsReauth on code 190', () => {
  const err = metaError({ status: 400, code: 190, message: 'Session expired' });
  const n = svc.normalizeApiError(err);
  assert.equal(n.needsReauth, true);
  assert.equal(n.status, 400);
  assert.equal(n.code, 190);
  assert.equal(n.fbtraceId, 'trace_abc');
});

test('normalizeApiError flags needsAdsScope on code 10 without needsReauth', () => {
  const err = metaError({
    status: 400,
    code: 10,
    message: 'Application does not have permission for this action',
  });
  const n = svc.normalizeApiError(err);
  assert.equal(n.needsReauth, false);
  assert.equal(n.needsAdsScope, true);
});

test('normalizeApiError flags needsAdsScope on code 100 (verified live)', () => {
  // Meta returns this exact shape when a live token lacks ads_read on
  // /me/adaccounts — captured from the Phase 1B smoke test against a real
  // Spotless connection whose token predates the scope change.
  const err = metaError({
    status: 400,
    code: 100,
    message:
      'Unsupported get request. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api',
  });
  const n = svc.normalizeApiError(err);
  assert.equal(n.needsReauth, false);
  assert.equal(n.needsAdsScope, true);
});

test('normalizeApiError does not double-flag when token is dead', () => {
  const err = metaError({
    status: 400,
    code: 190,
    subcode: 463,
    message: 'Session has expired',
  });
  const n = svc.normalizeApiError(err);
  assert.equal(n.needsReauth, true);
  assert.equal(n.needsAdsScope, false); // dead token, not a scope problem
});

test('normalizeApiError handles missing response envelope', () => {
  const err = new Error('network down');
  const n = svc.normalizeApiError(err);
  assert.equal(n.status, 500);
  assert.equal(n.message, 'network down');
  assert.equal(n.needsReauth, false);
});

// --------------------------------------------------------------------------
// listAdAccounts — happy path + pagination
// --------------------------------------------------------------------------
test('listAdAccounts normalizes rows and paginates', async () => {
  resetAxios();
  // First call — /me/adaccounts with params → return page 1 with paging.next.
  addRoute({
    method: 'get',
    matchUrl: '/me/adaccounts',
    respond: () => ({
      data: [
        {
          id: 'act_111',
          account_id: '111',
          name: 'Tampa',
          account_status: 1,
          currency: 'USD',
          timezone_name: 'America/New_York',
          timezone_offset_hours_utc: -4,
          business: { id: 'biz_1', name: 'Spotless LLC' },
          business_country_code: 'US',
          amount_spent: '12345',
          spend_cap: '0',
        },
      ],
      paging: { next: 'https://graph.facebook.com/next-page-1' },
    }),
  });
  // Follow-up call — the fully-formed `next` URL. pagedGet uses it verbatim.
  addRoute({
    method: 'get',
    matchUrl: '/next-page-1',
    respond: () => ({
      data: [
        {
          id: 'act_222',
          account_id: '222',
          name: 'Jacksonville',
          account_status: 1,
          currency: 'USD',
          timezone_name: 'America/New_York',
          timezone_offset_hours_utc: -4,
          amount_spent: '999',
        },
      ],
    }),
  });

  const rows = await svc.listAdAccounts('t0k3n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].adAccountId, 'act_111');
  assert.equal(rows[0].name, 'Tampa');
  assert.equal(rows[0].currency, 'USD');
  assert.equal(rows[0].business.name, 'Spotless LLC');
  assert.equal(rows[0].amountSpent, 12345);
  assert.equal(rows[1].adAccountId, 'act_222');
  assert.equal(rows[1].business, null);
});

test('listAdAccounts terminates pagination gracefully with no next', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/me/adaccounts',
    respond: () => ({ data: [{ id: 'act_1', account_id: '1' }] }),
  });
  const rows = await svc.listAdAccounts('tok');
  assert.equal(rows.length, 1);
  assert.equal(axiosState.calls.length, 1);
});

test('listAdAccounts throws with normalized envelope on 401', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/me/adaccounts',
    respond: () => ({
      __throw: metaError({
        status: 401,
        code: 190,
        message: 'Invalid OAuth 2.0 access token',
      }),
    }),
  });
  await assert.rejects(
    () => svc.listAdAccounts('bad'),
    (e) => {
      assert.equal(e.status, 401);
      assert.equal(e.normalized.needsReauth, true);
      assert.equal(e.normalized.code, 190);
      return true;
    }
  );
});

test('listAdAccounts requires accessToken', async () => {
  await assert.rejects(() => svc.listAdAccounts(''), /accessToken required/);
});

// --------------------------------------------------------------------------
// describeAdAccount
// --------------------------------------------------------------------------
test('describeAdAccount returns normalized shape', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_555',
    respond: () => ({
      id: 'act_555',
      account_id: '555',
      name: 'Spotless Tampa',
      account_status: 1,
      currency: 'USD',
      timezone_name: 'America/New_York',
      timezone_offset_hours_utc: -4,
      amount_spent: '5000',
    }),
  });
  const acct = await svc.describeAdAccount({
    accessToken: 'tok',
    adAccountId: '555',
  });
  assert.equal(acct.id, 'act_555');
  assert.equal(acct.amountSpent, 5000);
  assert.equal(acct.currency, 'USD');
});

test('describeAdAccount surfaces needsAdsScope on permission error', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_555',
    respond: () => ({
      __throw: metaError({
        status: 400,
        code: 10,
        message: 'Application does not have the ads_read permission',
      }),
    }),
  });
  await assert.rejects(
    () =>
      svc.describeAdAccount({ accessToken: 'tok', adAccountId: '555' }),
    (e) => {
      assert.equal(e.normalized.needsAdsScope, true);
      return true;
    }
  );
});

test('describeAdAccount rejects on missing/invalid id', async () => {
  await assert.rejects(
    () => svc.describeAdAccount({ accessToken: 'tok', adAccountId: '' }),
    /adAccountId required/
  );
});

// --------------------------------------------------------------------------
// getCampaigns
// --------------------------------------------------------------------------
test('getCampaigns normalizes rows including issues_info pass-through', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_777/campaigns',
    respond: () => ({
      data: [
        {
          id: 'c1',
          name: 'Tampa Leads',
          status: 'ACTIVE',
          effective_status: 'ACTIVE',
          objective: 'OUTCOME_LEADS',
          buying_type: 'AUCTION',
          daily_budget: '5000',
          budget_remaining: '3200',
          special_ad_categories: ['NONE'],
          issues_info: [{ error_message: 'Learning limited', level: 'AD_SET' }],
          created_time: '2026-08-01T00:00:00+0000',
        },
        {
          id: 'c2',
          name: 'Jax Sales',
          effective_status: 'PAUSED',
          objective: 'OUTCOME_SALES',
        },
      ],
    }),
  });
  const rows = await svc.getCampaigns({
    accessToken: 'tok',
    adAccountId: '777',
    days: 30,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].objective, 'OUTCOME_LEADS');
  assert.equal(rows[0].dailyBudget, 5000);
  assert.equal(rows[0].issuesInfo.length, 1);
  assert.equal(rows[0].issuesInfo[0].error_message, 'Learning limited');
  assert.equal(rows[0].specialAdCategories.length, 1);
  assert.deepEqual(Object.keys(rows[0]._dateRange), ['since', 'until']);
  assert.equal(rows[1].issuesInfo.length, 0); // absent → empty array
});

test('getCampaigns handles empty account (no campaigns)', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_888/campaigns',
    respond: () => ({ data: [] }),
  });
  const rows = await svc.getCampaigns({
    accessToken: 'tok',
    adAccountId: '888',
  });
  assert.deepEqual(rows, []);
});

// --------------------------------------------------------------------------
// getAdSets
// --------------------------------------------------------------------------
test('getAdSets normalizes learningStageInfo raw pass-through', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_999/adsets',
    respond: () => ({
      data: [
        {
          id: 'as1',
          name: 'Set A',
          effective_status: 'LEARNING_LIMITED',
          campaign_id: 'c1',
          optimization_goal: 'OFFSITE_CONVERSIONS',
          billing_event: 'IMPRESSIONS',
          bid_amount: '250',
          daily_budget: '2500',
          learning_stage_info: {
            status: 'LEARNING_LIMITED',
            attribution_windows: ['7d_click'],
          },
        },
      ],
    }),
  });
  const rows = await svc.getAdSets({
    accessToken: 'tok',
    adAccountId: '999',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].effectiveStatus, 'LEARNING_LIMITED');
  assert.equal(rows[0].learningStageInfo.status, 'LEARNING_LIMITED');
  assert.equal(rows[0].bidAmount, 250);
});

// --------------------------------------------------------------------------
// getAds
// --------------------------------------------------------------------------
test('getAds preserves creative reference and issues_info', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_101/ads',
    respond: () => ({
      data: [
        {
          id: 'a1',
          name: 'Ad 1',
          status: 'ACTIVE',
          effective_status: 'WITH_ISSUES',
          campaign_id: 'c1',
          adset_id: 'as1',
          creative: {
            id: 'cr1',
            name: 'Hero image',
            thumbnail_url: 'https://cdn/thumb.jpg',
          },
          issues_info: [{ error_message: 'Text overlays too much of image' }],
        },
      ],
    }),
  });
  const rows = await svc.getAds({
    accessToken: 'tok',
    adAccountId: '101',
  });
  assert.equal(rows[0].creative.id, 'cr1');
  assert.equal(rows[0].creative.thumbnailUrl, 'https://cdn/thumb.jpg');
  assert.equal(rows[0].issuesInfo.length, 1);
});

// --------------------------------------------------------------------------
// getInsights + normalization
// --------------------------------------------------------------------------
test('getInsights normalizes a full row with actions + roas + video', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_202/insights',
    respond: () => ({
      data: [
        {
          account_id: '202',
          account_currency: 'USD',
          campaign_id: 'c1',
          campaign_name: 'Tampa Leads',
          spend: '450.75',
          impressions: '12000',
          reach: '8100',
          frequency: '1.48',
          clicks: '340',
          ctr: '2.83',
          cpc: '1.33',
          cpm: '37.56',
          actions: [
            { action_type: 'link_click', value: '340' },
            { action_type: 'lead', value: '18' },
          ],
          action_values: [{ action_type: 'purchase', value: '2100' }],
          cost_per_action_type: [{ action_type: 'lead', value: '25.04' }],
          purchase_roas: [{ action_type: 'purchase', value: '4.66' }],
          video_p25_watched_actions: [
            { action_type: 'video_view', value: '3000' },
          ],
          date_start: '2026-07-25',
          date_stop: '2026-08-23',
        },
      ],
    }),
  });
  const { rows, dateRange } = await svc.getInsights({
    accessToken: 'tok',
    node: 'act_202',
    level: 'campaign',
    days: 30,
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.spend, 450.75);
  assert.equal(row.impressions, 12000);
  assert.equal(row.actionsByType.lead, 18);
  assert.equal(row.actionsByType.link_click, 340);
  assert.equal(row.actionValuesByType.purchase, 2100);
  assert.equal(row.costPerActionTypeByType.lead, 25.04);
  assert.equal(row.purchaseRoasByType.purchase, 4.66);
  assert.equal(row.videoP25.video_view, 3000);
  assert.equal(dateRange.since && dateRange.until ? true : false, true);
});

test('getInsights tolerates empty response and partial fields', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_303/insights',
    respond: () => ({ data: [] }),
  });
  const { rows } = await svc.getInsights({
    accessToken: 'tok',
    node: 'act_303',
    level: 'campaign',
  });
  assert.deepEqual(rows, []);
});

test('getInsights tolerates row with only some scalar fields', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_404/insights',
    respond: () => ({
      data: [
        {
          campaign_id: 'cX',
          spend: '10',
          impressions: '1000',
          // no clicks, ctr, cpc, cpm, actions
        },
      ],
    }),
  });
  const { rows } = await svc.getInsights({
    accessToken: 'tok',
    node: 'act_404',
    level: 'campaign',
  });
  assert.equal(rows[0].spend, 10);
  assert.equal(rows[0].impressions, 1000);
  assert.equal(rows[0].clicks, null); // absent → null, not 0
  assert.deepEqual(rows[0].actionsByType, {}); // absent array → empty map
});

test('getInsights rejects invalid level', async () => {
  await assert.rejects(
    () =>
      svc.getInsights({
        accessToken: 'tok',
        node: 'act_1',
        level: 'invalid',
      }),
    /invalid level/
  );
});

test('getInsights includes breakdowns in request when supplied', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_505/insights',
    respond: ({ config }) => {
      assert.equal(config.params.breakdowns, 'publisher_platform,platform_position');
      return {
        data: [
          {
            campaign_id: 'c1',
            spend: '100',
            publisher_platform: 'instagram',
            platform_position: 'story',
          },
        ],
      };
    },
  });
  const { rows } = await svc.getInsights({
    accessToken: 'tok',
    node: 'act_505',
    level: 'ad',
    breakdowns: ['publisher_platform', 'platform_position'],
  });
  assert.equal(rows[0].breakdowns.publisher_platform, 'instagram');
  assert.equal(rows[0].breakdowns.platform_position, 'story');
});

// --------------------------------------------------------------------------
// pickResultForObjective
// --------------------------------------------------------------------------
test('pickResultForObjective maps OUTCOME_LEADS → lead action', () => {
  const row = svc.normalizeInsightsRow({
    actions: [{ action_type: 'lead', value: '25' }],
    cost_per_action_type: [{ action_type: 'lead', value: '18.50' }],
  });
  const r = svc.pickResultForObjective('OUTCOME_LEADS', row);
  assert.equal(r.results, 25);
  assert.equal(r.costPerResult, 18.5);
  assert.equal(r.resultActionType, 'lead');
});

test('pickResultForObjective maps OUTCOME_SALES → purchase action', () => {
  const row = svc.normalizeInsightsRow({
    actions: [{ action_type: 'purchase', value: '12' }],
    cost_per_action_type: [{ action_type: 'purchase', value: '75.42' }],
  });
  const r = svc.pickResultForObjective('OUTCOME_SALES', row);
  assert.equal(r.results, 12);
  assert.equal(r.costPerResult, 75.42);
  assert.equal(r.resultActionType, 'purchase');
});

test('pickResultForObjective falls through action_type candidates', () => {
  // OUTCOME_SALES → tries purchase, omni_purchase, offsite_conversion.fb_pixel_purchase
  const row = svc.normalizeInsightsRow({
    actions: [{ action_type: 'omni_purchase', value: '5' }],
  });
  const r = svc.pickResultForObjective('OUTCOME_SALES', row);
  assert.equal(r.results, 5);
  assert.equal(r.resultActionType, 'omni_purchase');
});

test('pickResultForObjective returns nulls for unknown objective', () => {
  const row = svc.normalizeInsightsRow({
    actions: [{ action_type: 'link_click', value: '100' }],
  });
  const r = svc.pickResultForObjective('SOME_FUTURE_OBJECTIVE', row);
  assert.equal(r.results, null);
  assert.equal(r.costPerResult, null);
});

test('pickResultForObjective returns nulls when no matching action present', () => {
  const row = svc.normalizeInsightsRow({
    actions: [{ action_type: 'link_click', value: '100' }],
  });
  const r = svc.pickResultForObjective('OUTCOME_LEADS', row);
  assert.equal(r.results, null);
  assert.equal(r.costPerResult, null);
});

// --------------------------------------------------------------------------
// getAdCreatives
// --------------------------------------------------------------------------
test('getAdCreatives normalizes shape', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_606/adcreatives',
    respond: () => ({
      data: [
        {
          id: 'cr1',
          name: 'Hero',
          title: 'Book now',
          body: 'Get a cleaner today',
          image_url: 'https://cdn/i.jpg',
          call_to_action_type: 'BOOK_TRAVEL',
        },
      ],
    }),
  });
  const rows = await svc.getAdCreatives({
    accessToken: 'tok',
    adAccountId: '606',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Hero');
  assert.equal(rows[0].callToActionType, 'BOOK_TRAVEL');
});

// --------------------------------------------------------------------------
// getDeliveryIssues aggregation
// --------------------------------------------------------------------------
test('getDeliveryIssues fans out across campaigns/adsets/ads', async () => {
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/act_707/campaigns',
    respond: () => ({
      data: [{ id: 'c1', name: 'Camp', issues_info: [{ error_message: 'X' }] }],
    }),
  });
  addRoute({
    method: 'get',
    matchUrl: '/act_707/adsets',
    respond: () => ({
      data: [{ id: 'as1', name: 'Set', issues_info: [] }],
    }),
  });
  addRoute({
    method: 'get',
    matchUrl: '/act_707/ads',
    respond: () => ({
      data: [
        {
          id: 'a1',
          name: 'Ad',
          issues_info: [{ error_message: 'Y' }, { error_message: 'Z' }],
        },
      ],
    }),
  });

  const issues = await svc.getDeliveryIssues({
    accessToken: 'tok',
    adAccountId: '707',
  });
  assert.equal(issues.length, 3);
  const campaignIssues = issues.filter((i) => i.entityType === 'campaign');
  const adIssues = issues.filter((i) => i.entityType === 'ad');
  assert.equal(campaignIssues.length, 1);
  assert.equal(adIssues.length, 2);
});

// --------------------------------------------------------------------------
// pagination termination + safety
// --------------------------------------------------------------------------
test('pagedGet stops at MAX_PAGES to avoid runaway loops', async () => {
  resetAxios();
  let callCount = 0;
  const infiniteRespond = () => {
    callCount += 1;
    return {
      data: [{ id: `c${callCount}` }],
      paging: { next: 'https://graph.facebook.com/next-infinite' },
    };
  };
  // First-call matcher (has the /campaigns path).
  addRoute({
    method: 'get',
    matchUrl: '/act_808/campaigns',
    respond: infiniteRespond,
  });
  // Follow-up matcher (bare next URL that pagedGet re-uses).
  addRoute({
    method: 'get',
    matchUrl: '/next-infinite',
    respond: infiniteRespond,
  });
  const rows = await svc.getCampaigns({
    accessToken: 'tok',
    adAccountId: '808',
  });
  const cap = svc._internal.MAX_PAGES;
  // First call + up to MAX_PAGES follow-ups.
  assert.ok(callCount <= cap + 1, `expected ≤${cap + 1} calls, got ${callCount}`);
  assert.ok(rows.length >= 1);
});

// --------------------------------------------------------------------------
// debugToken introspection
// --------------------------------------------------------------------------
test('debugToken reports scopes present + missing ads_read', async () => {
  process.env.META_APP_ID = 'app';
  process.env.META_APP_SECRET = 'secret';
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/debug_token',
    respond: () => ({
      data: {
        app_id: 'app',
        user_id: '999',
        is_valid: true,
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
        scopes: ['pages_show_list', 'instagram_basic'], // note: no ads_read
      },
    }),
  });
  const info = await svc.debugToken({ inputToken: 'user_token' });
  assert.equal(info.isValid, true);
  assert.equal(info.hasAdsRead, false);
  assert.equal(info.hasAdsManagement, false);
  assert.ok(info.expiresAt > Date.now());
});

test('debugToken reports ads_read granted', async () => {
  process.env.META_APP_ID = 'app';
  process.env.META_APP_SECRET = 'secret';
  resetAxios();
  addRoute({
    method: 'get',
    matchUrl: '/debug_token',
    respond: () => ({
      data: {
        app_id: 'app',
        user_id: '999',
        is_valid: true,
        scopes: ['pages_show_list', 'ads_read'],
      },
    }),
  });
  const info = await svc.debugToken({ inputToken: 'user_token' });
  assert.equal(info.hasAdsRead, true);
  assert.equal(info.hasAdsManagement, false);
});

test('debugToken throws with normalized envelope when app creds unset', async () => {
  delete process.env.META_APP_ID;
  await assert.rejects(
    () => svc.debugToken({ inputToken: 't' }),
    /META_APP_ID or META_APP_SECRET not configured/
  );
});

// --------------------------------------------------------------------------
// API_VERSION exposure
// --------------------------------------------------------------------------
test('exports API_VERSION and GRAPH_BASE for callers', () => {
  assert.ok(svc.API_VERSION.startsWith('v'));
  assert.ok(svc.GRAPH_BASE.includes(svc.API_VERSION));
  assert.ok(svc.GRAPH_BASE.startsWith('https://graph.facebook.com/'));
});

// --------------------------------------------------------------------------
// timeRangeForDays boundary handling
// --------------------------------------------------------------------------
test('timeRangeForDays clamps to [1, 365] and returns YYYY-MM-DD strings', () => {
  const r0 = svc.timeRangeForDays(0);
  const r1 = svc.timeRangeForDays(1);
  const r365 = svc.timeRangeForDays(365);
  const rBig = svc.timeRangeForDays(9999);
  for (const r of [r0, r1, r365, rBig]) {
    assert.match(r.since, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.until, /^\d{4}-\d{2}-\d{2}$/);
  }
  // Clamping: 0 and 9999 should not produce absurd ranges.
  assert.equal(r0.since, r1.since); // both clamp to 1-day
  assert.equal(r365.since !== r1.since, true);
});
