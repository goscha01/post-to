// Google Ads tool-use tests for the Campaign Assistant.
//
// Covers:
//   - Tool schemas format correctly for OpenAI and Claude
//   - Executor dispatches to the right googleAdsService method
//   - Days clamping (invalid → default), digitsOnly on IDs
//   - Result capping + sorting on high-cardinality lists
//   - Errors returned as { error } instead of thrown (must not kill the chat)
//   - Unavailable state when accessToken/customerId missing
//   - Default campaignId flows through when caller doesn't override
//   - Unknown tool name returns an error
//   - Tool-usage instructions only appear in system prompt when hasTools=true

const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://example.com';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'svc';

require.cache[require.resolve('@supabase/supabase-js')] = {
  id: require.resolve('@supabase/supabase-js'),
  filename: require.resolve('@supabase/supabase-js'),
  loaded: true,
  exports: { createClient: () => ({ from() { return this; } }) },
};

const loggerPath = require.resolve('../src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

// Stub googleAdsService BEFORE requiring the tools module. Every method is
// a spy that returns a canned payload — tests then inspect what the tool
// executor passed in and how it shaped the response.
const calls = [];
function recordCall(name, args) {
  calls.push({ name, args });
}
function makeStub() {
  return {
    listAccessibleCustomers: () => Promise.resolve([]),
    describeCustomers: () => Promise.resolve({ customers: [] }),
    enumerateManagerChildren: () => Promise.resolve([]),
    getCampaigns: (accessToken, customerId, days, opts) => {
      recordCall('getCampaigns', { accessToken, customerId, days, opts });
      return Promise.resolve([{ campaignId: opts?.campaignId || '111', name: 'Test Camp', cost: 42 }]);
    },
    getAdGroups: () => Promise.resolve([]),
    getKeywords: () => Promise.resolve([]),
    getSearchTerms: (accessToken, customerId, days, opts) => {
      recordCall('getSearchTerms', { accessToken, customerId, days, opts });
      // Return 60 rows with varying cost so we can verify sort + slice-to-50.
      return Promise.resolve(
        Array.from({ length: 60 }, (_, i) => ({
          searchTerm: `term-${i}`,
          cost: i,           // cost=0..59 — sort desc + cap 50 keeps 59..10.
          conversions: 0,
        }))
      );
    },
    getAds: (accessToken, customerId, days, opts) => {
      recordCall('getAds', { accessToken, customerId, days, opts });
      return Promise.resolve([
        { adId: '819046265947', status: 'ENABLED', adStrength: 'EXCELLENT', impressions: 1000 },
        { adId: '111', status: 'PAUSED', impressions: 500 },
      ]);
    },
    getAssets: () => Promise.resolve([]),
    getRecommendations: () => Promise.resolve([]),
    getConversions: () => Promise.resolve([]),
    getDevices: () => Promise.resolve([]),
    getLocations: () => Promise.resolve([]),
    getDayHour: () => Promise.resolve([]),
    getAudience: () => Promise.resolve([]),
    getAuctionInsights: () => Promise.resolve([]),
    getQuality: () => Promise.resolve([]),
    getChangeHistory: (accessToken, customerId, days, opts) => {
      recordCall('getChangeHistory', { accessToken, customerId, days, opts });
      return Promise.resolve(
        Array.from({ length: 120 }, (_, i) => ({ id: `chg-${i}`, action: 'BUDGET_CHANGE' }))
      );
    },
    getDiagnostics: (accessToken, customerId, days, opts) => {
      recordCall('getDiagnostics', { accessToken, customerId, days, opts });
      return Promise.resolve({ issues: [{ code: 'BROKEN_TRACKING', severity: 'high' }] });
    },
    normalizeApiError: (err) => ({
      status: err?.response?.status || 500,
      message: err?.message || 'unknown',
      code: err?.code || null,
    }),
    _internal: {},
  };
}

const gaPath = require.resolve('../src/services/googleAdsService');
require.cache[gaPath] = {
  id: gaPath, filename: gaPath, loaded: true,
  exports: makeStub(),
};

const tools = require('../src/services/campaignAssistantTools');

// Rebuild stub between tests so we can vary behaviour per case. Must
// MUTATE the same exports object (not replace it) — the tools module
// captured the reference at import time, so a fresh object would be
// invisible to it.
function resetStub(overrides = {}) {
  calls.length = 0;
  Object.assign(require.cache[gaPath].exports, makeStub(), overrides);
}

// ============================================================================
// Tool schema shape
// ============================================================================

test('exposes 6 Google Ads tools with stable names', () => {
  assert.equal(tools.TOOL_NAMES.length, 6);
  const expected = [
    'google_ads_get_ad_status',
    'google_ads_get_campaign',
    'google_ads_get_search_terms',
    'google_ads_get_recent_changes',
    'google_ads_get_diagnostics',
    'google_ads_list_ads',
  ];
  for (const n of expected) assert.ok(tools.TOOL_NAMES.includes(n), `missing tool: ${n}`);
});

test('toolsForOpenAI produces {type:function, function:{name, description, parameters}}', () => {
  const arr = tools.toolsForOpenAI();
  assert.equal(arr.length, 6);
  for (const t of arr) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.name);
    assert.ok(t.function.description);
    assert.equal(t.function.parameters.type, 'object');
  }
});

test('toolsForClaude produces {name, description, input_schema} (no wrapper)', () => {
  const arr = tools.toolsForClaude();
  assert.equal(arr.length, 6);
  for (const t of arr) {
    assert.ok(t.name);
    assert.ok(t.description);
    assert.equal(t.input_schema.type, 'object');
    assert.equal(t.type, undefined); // Claude does NOT wrap in {type:function}
  }
});

// ============================================================================
// Executor dispatch
// ============================================================================

test('makeExecutor returns unavailable when accessToken missing', async () => {
  const exec = tools.makeExecutor({ customerId: '123' });
  assert.equal(exec.available, false);
  const r = await exec.execute('google_ads_get_ad_status', { adId: '999' });
  assert.ok(r.error);
  assert.match(r.error, /not connected/i);
});

test('makeExecutor returns unavailable when customerId missing', async () => {
  const exec = tools.makeExecutor({ accessToken: 'tok' });
  assert.equal(exec.available, false);
});

test('unknown tool name returns { error }', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  const r = await exec.execute('google_ads_fake_tool', {});
  assert.match(r.error, /Unknown tool/);
});

test('get_ad_status finds a matching ad and returns { found:true, ad }', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123', loginCustomerId: '456' });
  const r = await exec.execute('google_ads_get_ad_status', { adId: '819046265947' });
  assert.equal(r.found, true);
  assert.equal(r.adId, '819046265947');
  assert.equal(r.ad.status, 'ENABLED');
  // getAds was called with loginCustomerId propagated.
  const c = calls.find(x => x.name === 'getAds');
  assert.equal(c.args.opts.loginCustomerId, '456');
  assert.equal(c.args.days, 30);
});

test('get_ad_status accepts adId with non-digit noise (strips to digits)', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  const r = await exec.execute('google_ads_get_ad_status', { adId: '819-046-265-947' });
  assert.equal(r.found, true);
  assert.equal(r.adId, '819046265947');
});

test('get_ad_status returns { found:false, note } when ad not in last 30d', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  const r = await exec.execute('google_ads_get_ad_status', { adId: '999999' });
  assert.equal(r.found, false);
  assert.ok(r.note);
});

test('get_ad_status requires adId', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  const r = await exec.execute('google_ads_get_ad_status', {});
  assert.match(r.error, /adId required/);
});

test('get_campaign clamps invalid days to 30', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  await exec.execute('google_ads_get_campaign', { campaignId: '111', days: 999 });
  const c = calls.find(x => x.name === 'getCampaigns');
  assert.equal(c.args.days, 30);
});

test('get_campaign accepts valid days from the enum', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  await exec.execute('google_ads_get_campaign', { campaignId: '111', days: 7 });
  const c = calls.find(x => x.name === 'getCampaigns');
  assert.equal(c.args.days, 7);
});

test('get_search_terms sorts by cost desc and caps at 50', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  const r = await exec.execute('google_ads_get_search_terms', {});
  assert.equal(r.count, 50);
  assert.equal(r.truncated, true);
  // Highest cost (59) should be first.
  assert.equal(r.searchTerms[0].cost, 59);
  assert.equal(r.searchTerms[49].cost, 10);
});

test('get_search_terms uses conversation default campaignId when caller omits', async () => {
  resetStub();
  const exec = tools.makeExecutor({
    accessToken: 'tok', customerId: '123', campaignId: '888',
  });
  await exec.execute('google_ads_get_search_terms', {});
  const c = calls.find(x => x.name === 'getSearchTerms');
  assert.equal(c.args.opts.campaignId, '888');
});

test('get_search_terms caller campaignId overrides conversation default', async () => {
  resetStub();
  const exec = tools.makeExecutor({
    accessToken: 'tok', customerId: '123', campaignId: '888',
  });
  await exec.execute('google_ads_get_search_terms', { campaignId: '777' });
  const c = calls.find(x => x.name === 'getSearchTerms');
  assert.equal(c.args.opts.campaignId, '777');
});

test('get_recent_changes caps at 100 events', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  const r = await exec.execute('google_ads_get_recent_changes', { days: 14 });
  assert.equal(r.count, 100);
  assert.equal(r.truncated, true);
});

test('get_diagnostics forwards result under { diagnostics }', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  const r = await exec.execute('google_ads_get_diagnostics', { days: 7 });
  assert.equal(r.days, 7);
  assert.ok(r.diagnostics);
  assert.ok(Array.isArray(r.diagnostics.issues));
});

test('list_ads sorts by impressions desc, caps at 100', async () => {
  resetStub();
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  const r = await exec.execute('google_ads_list_ads', {});
  assert.equal(r.count, 2);
  assert.equal(r.ads[0].adId, '819046265947'); // impressions 1000 > 500
});

// ============================================================================
// Error handling — must return, not throw
// ============================================================================

test('service error is caught and returned as { error }, not thrown', async () => {
  resetStub({
    getDiagnostics: () => Promise.reject(Object.assign(new Error('DEVELOPER_TOKEN_NOT_APPROVED'), {
      response: { status: 403 },
    })),
  });
  const exec = tools.makeExecutor({ accessToken: 'tok', customerId: '123' });
  const r = await exec.execute('google_ads_get_diagnostics', {});
  assert.ok(r.error);
  assert.match(r.error, /DEVELOPER_TOKEN_NOT_APPROVED/);
});

// ============================================================================
// System prompt guidance
// ============================================================================

test('TOOL_USAGE_INSTRUCTIONS only appear when hasTools=true (OpenAI system content)', () => {
  const svc = require('../src/services/campaignAssistantService');
  const { buildOpenAiSystemContent } = svc._internal;
  const report = {
    meta: { dateRangeDays: 30 },
    account: { descriptiveName: 'Test' },
    metaAds: null,
  };
  const withoutTools = buildOpenAiSystemContent(report, null);
  const withTools = buildOpenAiSystemContent(report, null, { hasTools: true });
  assert.ok(!withoutTools.includes('LIVE DATA TOOLS AVAILABLE'));
  assert.ok(withTools.includes('LIVE DATA TOOLS AVAILABLE'));
  assert.ok(withTools.includes('google_ads_get_ad_status'));
});

test('TOOL_USAGE_INSTRUCTIONS only appear when hasTools=true (Claude system array)', () => {
  const svc = require('../src/services/campaignAssistantService');
  const { buildClaudeSystemArray } = svc._internal;
  const report = {
    meta: { dateRangeDays: 30 },
    account: { descriptiveName: 'Test' },
    metaAds: null,
  };
  const without = buildClaudeSystemArray(report, null);
  const withT = buildClaudeSystemArray(report, null, { hasTools: true });
  const joinWithout = without.map(p => p.text).join('\n');
  const joinWith = withT.map(p => p.text).join('\n');
  assert.ok(!joinWithout.includes('LIVE DATA TOOLS AVAILABLE'));
  assert.ok(joinWith.includes('LIVE DATA TOOLS AVAILABLE'));
});
