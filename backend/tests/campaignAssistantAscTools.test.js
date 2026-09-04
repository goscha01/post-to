// Tests for the App Store Connect tool dispatchers inside the shared
// executor. The Google Ads dispatchers are covered by
// campaignAssistantGoogleTools.test.js — this file targets asc_* only.

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

// Stub googleAdsService (unused by asc_* tools but required by the module).
const gaPath = require.resolve('../src/services/googleAdsService');
require.cache[gaPath] = {
  id: gaPath, filename: gaPath, loaded: true,
  exports: {
    normalizeApiError: (err) => ({ status: err?.status || 500, message: err?.message, code: null }),
  },
};

// Stub the ASC service and the analytics service.
const ascPath = require.resolve('../src/services/appStoreConnectService');
const analyticsPath = require.resolve('../src/services/ascAnalyticsService');

const ascCalls = [];
const analyticsCalls = [];

require.cache[ascPath] = {
  id: ascPath, filename: ascPath, loaded: true,
  exports: {
    getReviews: (creds, opts) => {
      ascCalls.push({ fn: 'getReviews', creds, opts });
      return Promise.resolve([
        { id: 'r1', rating: 5, title: 'Great', body: 'Love it', reviewerNickname: 'Alice', createdDate: '2026-08-30', territory: 'USA' },
      ]);
    },
    normalizeApiError: (err) => ({ status: err?.status || 500, message: err?.message, code: null }),
  },
};

require.cache[analyticsPath] = {
  id: analyticsPath, filename: analyticsPath, loaded: true,
  exports: {
    getInstallFunnel: (opts) => {
      analyticsCalls.push({ fn: 'getInstallFunnel', opts });
      return Promise.resolve({
        days: opts.days,
        totals: { impressions: 1000, productPageViews: 200, installs: 40, conversionRate: 0.2, redownloads: 5 },
        perDay: [
          { date: '2026-08-30', impressions: 500, productPageViews: 100, installs: 20 },
          { date: '2026-08-29', impressions: 500, productPageViews: 100, installs: 20 },
        ],
        dataCoverageDays: 2,
      });
    },
    getInstallsBySource: (opts) => {
      analyticsCalls.push({ fn: 'getInstallsBySource', opts });
      return Promise.resolve({
        days: opts.days,
        sources: [
          { sourceType: 'App Store Search', impressions: 800, productPageViews: 150, topCampaigns: [] },
          { sourceType: 'Web Referrer', impressions: 200, productPageViews: 50, topCampaigns: [{ campaign: 'summer-sale', productPageViews: 30 }] },
        ],
      });
    },
  },
};

const tools = require('../src/services/campaignAssistantTools');

function ascCtx() {
  return {
    creds: { p8: 'fake-key', issuerId: 'iss', keyId: 'kid' },
    connectionId: 'conn-xyz',
    appId: '111',
    userId: 'user-1',
  };
}

function reset() {
  ascCalls.length = 0;
  analyticsCalls.length = 0;
}

// ============================================================================

test('asc_* tool returns "not connected" when only Google Ads context is set', async () => {
  reset();
  const exec = tools.makeExecutor({
    googleAds: { accessToken: 't', customerId: '123' },
  });
  const r = await exec.execute('asc_get_install_funnel', {});
  assert.match(r.error, /Apple App Store Connect is not connected/);
});

test('asc_get_install_funnel calls analytics service with clamped days', async () => {
  reset();
  const exec = tools.makeExecutor({ asc: ascCtx() });
  const r = await exec.execute('asc_get_install_funnel', { days: 30 });
  assert.equal(r.days, 30);
  assert.equal(r.totals.installs, 40);
  assert.equal(r.totals.conversionRate, 0.2);
  const c = analyticsCalls.find(x => x.fn === 'getInstallFunnel');
  assert.equal(c.opts.days, 30);
  assert.equal(c.opts.connectionId, 'conn-xyz');
});

test('asc_get_install_funnel clamps invalid days to 14', async () => {
  reset();
  const exec = tools.makeExecutor({ asc: ascCtx() });
  await exec.execute('asc_get_install_funnel', { days: 999 });
  const c = analyticsCalls.find(x => x.fn === 'getInstallFunnel');
  assert.equal(c.opts.days, 14);
});

test('asc_get_install_funnel surfaces a note when no data cached yet', async () => {
  reset();
  // Override just this call to return empty funnel.
  const analyticsModule = require.cache[analyticsPath].exports;
  const orig = analyticsModule.getInstallFunnel;
  analyticsModule.getInstallFunnel = () => Promise.resolve({
    days: 14,
    totals: { impressions: 0, productPageViews: 0, installs: 0, conversionRate: null, redownloads: 0 },
    perDay: [],
    dataCoverageDays: 0,
  });
  try {
    const exec = tools.makeExecutor({ asc: ascCtx() });
    const r = await exec.execute('asc_get_install_funnel', {});
    assert.match(r.note, /No analytics data cached yet/);
  } finally {
    analyticsModule.getInstallFunnel = orig;
  }
});

test('asc_get_installs_by_source returns sources array', async () => {
  reset();
  const exec = tools.makeExecutor({ asc: ascCtx() });
  const r = await exec.execute('asc_get_installs_by_source', { days: 7 });
  assert.equal(r.days, 7);
  assert.equal(r.sources.length, 2);
  assert.equal(r.sources[0].sourceType, 'App Store Search');
});

test('asc_get_recent_reviews calls asc.getReviews with capped limit', async () => {
  reset();
  const exec = tools.makeExecutor({ asc: ascCtx() });
  const r = await exec.execute('asc_get_recent_reviews', { limit: 999, territory: 'usa' });
  assert.equal(r.count, 1);
  const c = ascCalls.find(x => x.fn === 'getReviews');
  assert.equal(c.opts.limit, 30);          // capped at MAX_ASC_REVIEWS
  assert.equal(c.opts.territory, 'USA');   // uppercased
  assert.equal(c.opts.appId, '111');
});

test('asc_get_recent_reviews defaults limit to 20', async () => {
  reset();
  const exec = tools.makeExecutor({ asc: ascCtx() });
  await exec.execute('asc_get_recent_reviews', {});
  const c = ascCalls.find(x => x.fn === 'getReviews');
  assert.equal(c.opts.limit, 20);
});

test('asc_get_recent_reviews errors clearly when appId missing on the context', async () => {
  reset();
  const ctx = ascCtx();
  ctx.appId = null;
  const exec = tools.makeExecutor({ asc: ctx });
  const r = await exec.execute('asc_get_recent_reviews', {});
  assert.match(r.error, /no primary appId/);
});

test('unknown asc_* tool name returns an error', async () => {
  reset();
  const exec = tools.makeExecutor({ asc: ascCtx() });
  const r = await exec.execute('asc_something_new', {});
  assert.match(r.error, /Unknown ASC tool/);
});

test('errors from analytics service are caught and returned as { error }', async () => {
  reset();
  const analyticsModule = require.cache[analyticsPath].exports;
  const orig = analyticsModule.getInstallFunnel;
  analyticsModule.getInstallFunnel = () => Promise.reject(Object.assign(new Error('DB down'), { status: 503 }));
  try {
    const exec = tools.makeExecutor({ asc: ascCtx() });
    const r = await exec.execute('asc_get_install_funnel', {});
    assert.match(r.error, /DB down/);
  } finally {
    analyticsModule.getInstallFunnel = orig;
  }
});
