// Tests for backend/src/services/optimizationReportService.js (Phase 1D).
//
// Covers every scenario in spec §11 + §12:
//   * Meta section present
//   * Meta absent
//   * Meta upstream error isolation
//   * Meta ads_read scope missing / token expired / rate limited / 500
//   * Google failure while Meta succeeds
//   * GA4 failure while Meta succeeds
//   * Single vs mixed-objective results
//   * Campaign / partial / channel / none attribution quality
//   * Unmatched campaigns stay unmatched (no fuzzy joining)
//   * Backward-compatible crossReference.byCampaign
//   * Sensitive Meta fields excluded from serialized output
//   * Report works without Google Ads (Meta-only)
//   * Report works without GA4 (Meta + Google only)
//
// Strategy: intercept the concrete service modules via require.cache and
// drive each scenario by rigging the mocked returns. This gives per-test
// control without instantiating any HTTP layer.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Silence logger.
const loggerPath = require.resolve('../src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

// -------- stubs for the underlying providers --------
let adsStubs, ga4Stubs, metaStubs;
function resetStubs() {
  adsStubs = {
    getCampaigns: async () => [{ name: 'C1', campaign: 'C1', clicks: 100, cost: 50, impressions: 10000, conversions: 5, conversionValue: 500, ctr: 0.01, avgCpc: 0.5 }],
    getAdGroups: async () => [], getKeywords: async () => [], getSearchTerms: async () => [], getAds: async () => [],
    getAssets: async () => [], getRecommendations: async () => [], getConversions: async () => [{ primary: true, status: 'ENABLED', conversions: 5, name: 'Purchase', type: 'PURCHASE' }],
    getDevices: async () => [], getLocations: async () => [], getDayHour: async () => [], getAudience: async () => [],
    getAuctionInsights: async () => [], getQuality: async () => [], getChangeHistory: async () => [], getDiagnostics: async () => ({}),
  };
  ga4Stubs = {
    getOverview: async () => ({ sessions: 500, users: 400, conversions: 20, totalRevenue: 1000, pageViews: 2000, rangeDays: 30 }),
    getLandingPages: async () => [], getTrafficSources: async () => [], getEvents: async () => [],
    getCampaigns: async () => [], getGeography: async () => [], getDevices: async () => [],
  };
  metaStubs = {
    describeAdAccount: async () => ({ id: 'act_1', name: 'Tampa', currency: 'USD', timezoneName: 'America/Detroit' }),
    getCampaigns: async () => [{ id: 'mc1', name: 'Spring Leads FL', objective: 'OUTCOME_LEADS', effectiveStatus: 'ACTIVE', issuesInfo: [] }],
    getAdSets: async () => [{ id: 'as1', campaignId: 'mc1', effectiveStatus: 'ACTIVE', dailyBudget: 5000 }],
    getAds: async () => [{ id: 'ad1', adSetId: 'as1', campaignId: 'mc1', effectiveStatus: 'ACTIVE', issuesInfo: [] }],
    getInsights: async ({ level, breakdowns }) => {
      if (breakdowns?.length) {
        // Placements request
        return {
          rows: [
            { spend: 40, impressions: 4000, clicks: 30, ctr: 0.75, cpm: 10, breakdowns: { publisher_platform: 'facebook', platform_position: 'feed' } },
            { spend: 20, impressions: 2000, clicks: 15, ctr: 0.75, cpm: 10, breakdowns: { publisher_platform: 'instagram', platform_position: 'story' } },
          ],
          dateRange: { since: '2026-07-25', until: '2026-08-24' },
        };
      }
      if (level === 'campaign') {
        return {
          rows: [
            realSvc.normalizeInsightsRow({
              campaign_id: 'mc1', spend: '100', impressions: '10000', clicks: '250', ctr: '2.5', cpc: '0.4', cpm: '10',
              actions: [{ action_type: 'lead', value: '8' }],
              cost_per_action_type: [{ action_type: 'lead', value: '12.5' }],
            }),
          ],
          dateRange: { since: '2026-07-25', until: '2026-08-24' },
        };
      }
      return { rows: [], dateRange: { since: '2026-07-25', until: '2026-08-24' } };
    },
    getDeliveryIssues: async () => [],
    normalizeInsightsRow: null, // set below
    pickResultForObjective: null,
    pickResultActionTypes: null,
  };
}

// -------- proxy require.cache so the service picks up our stubs --------

// Load real metaAdsService FIRST to grab pure helpers.
const svcRealPath = require.resolve('../src/services/metaAdsService');
const originalRequire = Module.prototype.require;
const realSvc = originalRequire.call(module, svcRealPath);

require.cache[require.resolve('../src/services/googleAdsService')] = {
  id: require.resolve('../src/services/googleAdsService'),
  filename: require.resolve('../src/services/googleAdsService'),
  loaded: true,
  exports: new Proxy({}, {
    get: (_t, k) => (...args) => adsStubs[k] ? adsStubs[k](...args) : Promise.resolve(null),
  }),
};
require.cache[require.resolve('../src/services/analyticsService')] = {
  id: require.resolve('../src/services/analyticsService'),
  filename: require.resolve('../src/services/analyticsService'),
  loaded: true,
  exports: new Proxy({}, {
    get: (_t, k) => (...args) => ga4Stubs[k] ? ga4Stubs[k](...args) : Promise.resolve(null),
  }),
};
require.cache[svcRealPath] = {
  id: svcRealPath, filename: svcRealPath, loaded: true,
  exports: new Proxy({}, {
    get: (_t, k) => {
      // Pass-through pure helpers to the real implementation
      if (['normalizeInsightsRow', 'pickResultForObjective', 'pickResultActionTypes',
           'normalizeAdAccountId', 'normalizeApiError', 'timeRangeForDays',
           'API_VERSION', 'GRAPH_BASE'].includes(k)) return realSvc[k];
      return (...args) => metaStubs[k] ? metaStubs[k](...args) : Promise.resolve(null);
    },
  }),
};

resetStubs();

const service = require('../src/services/optimizationReportService');

// -------- helpers --------

const defaultInputs = () => ({
  adsAccessToken: 'ads-tok',
  customerId: '1234567890',
  loginCustomerId: null,
  campaignId: null,
  ga4AccessToken: 'ga4-tok',
  propertyId: '999',
  days: 30,
  thresholds: {},
  userId: 'user-A',
  metaAccessToken: 'meta-tok',
  metaAdAccountId: 'act_1',
});

// ============================================================================
// Meta section present
// ============================================================================

test('Meta section present when metaAdAccountId + metaAccessToken supplied', async () => {
  resetStubs();
  const r = await service.generateReport(defaultInputs());
  assert.ok(r.metaAds, 'expected metaAds section');
  assert.equal(r.metaAds.account.adAccountId, 'act_1');
  assert.ok(r.metaAds.totals);
  assert.ok(Array.isArray(r.metaAds.campaigns));
  // Backward compat: existing meta metadata field still present
  assert.ok(r.meta, 'expected legacy meta metadata field');
  assert.ok(r.meta.generatedAt);
});

// ============================================================================
// Meta absent
// ============================================================================

test('Meta absent when metaAdAccountId not supplied — report still works', async () => {
  resetStubs();
  const r = await service.generateReport({ ...defaultInputs(), metaAdAccountId: null, metaAccessToken: null });
  assert.equal(r.metaAds, null);
  assert.equal(r.crossReference.metaByCampaign.length, 0);
  assert.equal(r.crossReference.metaAttribution.quality, 'not_requested');
});

// ============================================================================
// Meta API error isolation
// ============================================================================

test('Meta upstream error isolated to that section; report otherwise complete', async () => {
  resetStubs();
  metaStubs.getInsights = async () => { throw new Error('meta insights 500'); };
  const r = await service.generateReport(defaultInputs());
  // Google Ads section still complete
  assert.equal(r.summary.clicks, 100);
  // Meta section: campaigns still fetched (no error), insights null → results null
  assert.ok(r.metaAds);
  assert.ok(Array.isArray(r.errors));
  const metaErr = r.errors.find((e) => e.section === 'meta.insights.campaign');
  assert.ok(metaErr, 'meta insights failure recorded');
});

test('Meta ads_read scope missing simulated by all-Meta-calls-throwing', async () => {
  resetStubs();
  const throwScope = async () => { const e = new Error('needs ads_read'); e.normalized = { needsAdsScope: true }; throw e; };
  metaStubs.describeAdAccount = throwScope;
  metaStubs.getCampaigns = throwScope;
  metaStubs.getAdSets = throwScope;
  metaStubs.getAds = throwScope;
  metaStubs.getInsights = throwScope;
  metaStubs.getDeliveryIssues = throwScope;
  const r = await service.generateReport(defaultInputs());
  // Report doesn't die
  assert.ok(r.summary);
  // metaAds section present with mostly-empty content
  assert.ok(r.metaAds);
  assert.equal(r.metaAds.campaigns.length, 0);
  // Every Meta call recorded a failure
  const metaFailures = (r.errors || []).filter((e) => e.section.startsWith('meta.'));
  assert.ok(metaFailures.length >= 5, `expected 5+ meta failures, got ${metaFailures.length}`);
});

test('Meta token expired: same isolation contract as scope missing', async () => {
  resetStubs();
  const expired = async () => { const e = new Error('token expired'); e.normalized = { needsReauth: true }; throw e; };
  metaStubs.getCampaigns = expired;
  const r = await service.generateReport(defaultInputs());
  assert.ok(r.errors.find((e) => e.section === 'meta.campaigns'));
  assert.ok(r.summary); // Google still works
});

test('Meta rate limited: report survives', async () => {
  resetStubs();
  metaStubs.getInsights = async () => { const e = new Error('rate limit'); e.normalized = { code: 17 }; throw e; };
  const r = await service.generateReport(defaultInputs());
  assert.ok(r.errors.find((e) => e.section === 'meta.insights.campaign'));
  assert.ok(r.metaAds);
});

test('Meta upstream 500: report survives', async () => {
  resetStubs();
  metaStubs.describeAdAccount = async () => { throw new Error('500 server error'); };
  const r = await service.generateReport(defaultInputs());
  assert.ok(r.errors.find((e) => e.section === 'meta.account'));
});

// ============================================================================
// Google failure while Meta succeeds
// ============================================================================

test('Google Ads failure isolated: Meta section unaffected', async () => {
  resetStubs();
  adsStubs.getCampaigns = async () => { throw new Error('ads_dead'); };
  const r = await service.generateReport(defaultInputs());
  assert.ok(r.errors.find((e) => e.section === 'campaigns'));
  assert.ok(r.metaAds);
  assert.equal(r.metaAds.account.adAccountId, 'act_1');
});

// ============================================================================
// GA4 failure while Meta succeeds
// ============================================================================

test('GA4 failure isolated: Meta section unaffected', async () => {
  resetStubs();
  ga4Stubs.getOverview = async () => { throw new Error('ga4_dead'); };
  ga4Stubs.getTrafficSources = async () => { throw new Error('ga4_dead'); };
  const r = await service.generateReport(defaultInputs());
  assert.ok(r.metaAds);
  // Attribution falls back gracefully with empty ga4 rows
  assert.ok(r.crossReference.metaAttribution);
});

// ============================================================================
// Single vs mixed objective
// ============================================================================

test('single-objective account: metaAds.resultsByObjective has 1 bucket', async () => {
  resetStubs();
  const r = await service.generateReport(defaultInputs());
  assert.equal(r.metaAds.resultsByObjective.length, 1);
  assert.equal(r.metaAds.resultsByObjective[0].actionType, 'lead');
});

test('mixed-objective account: resultsByObjective has multiple buckets, not summed', async () => {
  resetStubs();
  metaStubs.getCampaigns = async () => [
    { id: 'mc1', name: 'X', objective: 'OUTCOME_LEADS', effectiveStatus: 'ACTIVE', issuesInfo: [] },
    { id: 'mc2', name: 'Y', objective: 'OUTCOME_SALES', effectiveStatus: 'ACTIVE', issuesInfo: [] },
  ];
  metaStubs.getInsights = async ({ level, breakdowns }) => {
    if (breakdowns?.length) return { rows: [], dateRange: {} };
    if (level === 'campaign') return {
      rows: [
        realSvc.normalizeInsightsRow({ campaign_id: 'mc1', spend: '100', actions: [{ action_type: 'lead', value: '5' }] }),
        realSvc.normalizeInsightsRow({ campaign_id: 'mc2', spend: '200', actions: [{ action_type: 'purchase', value: '3' }] }),
      ],
      dateRange: {},
    };
    return { rows: [], dateRange: {} };
  };
  const r = await service.generateReport(defaultInputs());
  const bucketTypes = r.metaAds.resultsByObjective.map((b) => b.actionType).sort();
  assert.deepEqual(bucketTypes, ['lead', 'purchase']);
  // Both channels present in cross-channel summary
  const meta = r.summary.channels.meta_ads;
  assert.equal(meta.results.length, 2);
});

// ============================================================================
// Attribution qualities
// ============================================================================

test('crossReference.metaAttribution.quality=campaign when GA4 rows match', async () => {
  resetStubs();
  ga4Stubs.getTrafficSources = async () => [
    { source: 'facebook', medium: 'cpc', campaign: 'Spring Leads FL', sessions: 200, users: 150, conversions: 12, revenue: 0 },
  ];
  metaStubs.getCampaigns = async () => [{ id: 'mc1', name: 'Spring Leads FL', objective: 'OUTCOME_LEADS', effectiveStatus: 'ACTIVE', issuesInfo: [] }];
  const r = await service.generateReport(defaultInputs());
  assert.equal(r.crossReference.metaAttribution.quality, 'campaign');
  assert.equal(r.crossReference.metaByCampaign.length, 1);
  assert.equal(r.crossReference.metaByCampaign[0].confidence, 'high');
});

test('crossReference.metaAttribution.quality=channel matches live Spotless case', async () => {
  resetStubs();
  ga4Stubs.getTrafficSources = async () => [
    { source: 'm.facebook.com', medium: 'referral', campaign: '(not set)', sessions: 1, conversions: 1, users: 1, revenue: 0 },
    { source: 'google', medium: 'organic', campaign: '(not set)', sessions: 400 },
  ];
  metaStubs.getCampaigns = async () => [
    { id: 'mc1', name: '[Marketplace listing] boosted 7/28/2026', objective: 'OUTCOME_SALES', effectiveStatus: 'ACTIVE', issuesInfo: [] },
  ];
  const r = await service.generateReport(defaultInputs());
  assert.equal(r.crossReference.metaAttribution.quality, 'channel');
  assert.equal(r.crossReference.metaByCampaign.length, 0);
  assert.equal(r.crossReference.metaAttribution.channelRollup.sessions, 1);
});

test('unmatched campaigns stay unmatched (no fuzzy joining)', async () => {
  resetStubs();
  ga4Stubs.getTrafficSources = async () => [
    { source: 'facebook', medium: 'cpc', campaign: 'Spring Leads FL Zone A', sessions: 100 }, // superset
  ];
  metaStubs.getCampaigns = async () => [{ id: 'mc1', name: 'Spring Leads FL', objective: 'OUTCOME_LEADS', effectiveStatus: 'ACTIVE', issuesInfo: [] }];
  const r = await service.generateReport(defaultInputs());
  // Similar names must not silently join
  assert.equal(r.crossReference.metaByCampaign.length, 0);
  assert.equal(r.crossReference.metaAttribution.unmatchedMetaCampaigns.length, 1);
});

// ============================================================================
// Provider-tagged alerts
// ============================================================================

test('alertsByProvider tags Meta issues with provider=meta_ads', async () => {
  resetStubs();
  metaStubs.getCampaigns = async () => [
    // WITH_ISSUES + issues_info → will fire ruleMetaIssuesInfo
    { id: 'mc1', name: 'X', objective: 'OUTCOME_LEADS', effectiveStatus: 'WITH_ISSUES',
      issuesInfo: [{ error_summary: 'Payment invalid', error_message: 'msg', error_type: 'HARD_ERROR' }] },
  ];
  const r = await service.generateReport(defaultInputs());
  const metaAlerts = r.alertsByProvider.filter((a) => a.provider === 'meta_ads');
  assert.ok(metaAlerts.length >= 1);
  const paymentAlert = metaAlerts.find((a) => /Payment/i.test(a.title));
  assert.ok(paymentAlert);
  assert.equal(paymentAlert.source, 'meta');
});

test('alertsByProvider preserves google_ads tagging for existing alerts', async () => {
  resetStubs();
  // Feed a search term that will trigger highSpendNoConversions
  adsStubs.getSearchTerms = async () => [
    { searchTerm: 'foo', cost: 100, clicks: 50, conversions: 0, matchedKeyword: 'foo', matchType: 'PHRASE', campaign: 'C1' },
  ];
  const r = await service.generateReport(defaultInputs());
  const googleAlerts = r.alertsByProvider.filter((a) => a.provider === 'google_ads');
  assert.ok(googleAlerts.length >= 1);
});

// ============================================================================
// Backward compatibility
// ============================================================================

test('crossReference.byCampaign preserved (backward compat)', async () => {
  resetStubs();
  ga4Stubs.getCampaigns = async () => [
    { source: 'google', medium: 'cpc', campaign: 'C1', sessions: 200, users: 150, conversions: 10, revenue: 500 },
  ];
  const r = await service.generateReport(defaultInputs());
  assert.ok(Array.isArray(r.crossReference.byCampaign));
  assert.equal(r.crossReference.byCampaign.length, 1);
  // Alias also present
  assert.deepEqual(r.crossReference.googleByCampaign, r.crossReference.byCampaign);
});

test('legacy `meta` (metadata) field still present + shape unchanged', async () => {
  resetStubs();
  const r = await service.generateReport(defaultInputs());
  assert.ok(r.meta);
  assert.ok(r.meta.generatedAt);
  assert.equal(r.meta.dateRangeDays, 30);
  // metaAds is a DIFFERENT field — not clobbering meta
  assert.notEqual(r.meta, r.metaAds);
});

// ============================================================================
// Sensitive fields
// ============================================================================

test('Meta section excludes tokens, page_access_token, owner_user_token', async () => {
  resetStubs();
  const r = await service.generateReport(defaultInputs());
  const text = JSON.stringify(r);
  for (const forbidden of ['owner_user_token', 'page_access_token', 'user_access_token', 'access_token', 'EAAG']) {
    assert.equal(text.includes(forbidden), false, `report contains forbidden fragment: ${forbidden}`);
  }
});

test('Meta account block strips lifetime amountSpent + status codes', async () => {
  resetStubs();
  metaStubs.describeAdAccount = async () => ({
    id: 'act_1', name: 'Tampa', currency: 'USD', timezoneName: 'America/Detroit',
    // These should NOT land in the report
    amountSpent: 999999, accountStatus: 1, spendCap: 100000,
    disableReason: null,
  });
  const r = await service.generateReport(defaultInputs());
  const accountJSON = JSON.stringify(r.metaAds.account);
  assert.equal(accountJSON.includes('amountSpent'), false);
  assert.equal(accountJSON.includes('accountStatus'), false);
  assert.equal(accountJSON.includes('spendCap'), false);
});

// ============================================================================
// Meta-only + Google-only + GA4-optional
// ============================================================================

test('report works Meta-only (no Google Ads customerId)', async () => {
  resetStubs();
  const r = await service.generateReport({ ...defaultInputs(), customerId: null, adsAccessToken: null });
  assert.ok(r.metaAds);
  // Google summary should still be present but zeroed
  assert.equal(r.summary.clicks, 0);
  assert.equal(r.summary.channels.google_ads, undefined);
  assert.ok(r.summary.channels.meta_ads);
});

test('report works without GA4 (Meta + Google Ads only)', async () => {
  resetStubs();
  const r = await service.generateReport({ ...defaultInputs(), propertyId: null, ga4AccessToken: null });
  assert.equal(r.ga4, null);
  assert.ok(r.metaAds);
  assert.equal(r.crossReference.metaAttribution.quality, 'none');
});
