// Tests for backend/src/services/metaAdsDiagnostics.js.
//
// Every rule is exercised with normalized-shape inputs matching what the
// route layer produces from live Meta calls (see the Phase 1B.5 smoke test
// for the real shapes these are modeled on).

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Silence logger before the service loads.
const loggerPath = require.resolve('../src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

// metaAdsService.pickResultForObjective is a real dependency of the
// diagnostics engine — use the real implementation. No mocking.
const svc = require('../src/services/metaAdsService');
const diag = require('../src/services/metaAdsDiagnostics');

// -------- helpers --------

function insight({ campaignId, adSetId, adId, spend = 0, impressions = 0, clicks = 0, ctr = null, cpm = null, cpc = null, reach = null, frequency = null, actions = [], costPerAction = [] } = {}) {
  return svc.normalizeInsightsRow({
    campaign_id: campaignId,
    adset_id: adSetId,
    ad_id: adId,
    spend: String(spend),
    impressions: String(impressions),
    clicks: String(clicks),
    ctr: ctr === null ? undefined : String(ctr),
    cpm: cpm === null ? undefined : String(cpm),
    cpc: cpc === null ? undefined : String(cpc),
    reach: reach === null ? undefined : String(reach),
    frequency: frequency === null ? undefined : String(frequency),
    actions: actions.map((a) => ({ action_type: a.type, value: String(a.value) })),
    cost_per_action_type: costPerAction.map((a) => ({ action_type: a.type, value: String(a.value) })),
  });
}
function bundle(...rows) { return { rows }; }

// ============================================================================
// Meta-returned issues_info + effective_status pass-through
// ============================================================================

test('ruleMetaIssuesInfo — surfaces campaign/adset/ad issues verbatim', () => {
  const campaigns = [
    { id: 'c1', name: 'X', effectiveStatus: 'ACTIVE', issuesInfo: [] },
    { id: 'c2', name: 'Y', effectiveStatus: 'WITH_ISSUES', issuesInfo: [{ level: 'CAMPAIGN', error_code: 42, error_summary: 'Bad', error_message: 'msg', error_type: 'HARD_ERROR' }] },
  ];
  const ads = [
    { id: 'a1', name: 'Ad1', effectiveStatus: 'WITH_ISSUES', issuesInfo: [{ level: 'AD', error_code: 1487220, error_summary: 'Payment invalid', error_message: 'add card', error_type: 'HARD_ERROR' }] },
  ];
  const out = diag.runDiagnostics({ campaigns, ads });
  const metaIssues = out.filter((i) => i.type === 'meta_delivery_issue');
  assert.equal(metaIssues.length, 2);
  const paymentIssue = metaIssues.find((i) => i.entityIds[0] === 'a1');
  assert.equal(paymentIssue.severity, 'high'); // HARD_ERROR → high
  assert.equal(paymentIssue.source, 'meta');
  assert.equal(paymentIssue.title, 'Payment invalid');
  assert.equal(paymentIssue.guidance, 'add card'); // verbatim
});

test('ruleAbnormalStatus — flags WITH_ISSUES only when issues_info missing', () => {
  // WITH_ISSUES + issues_info populated → skip abnormal_status (issues_info already covers it)
  // WITH_ISSUES + no issues_info → emit abnormal_status
  const campaigns = [
    { id: 'c1', effectiveStatus: 'WITH_ISSUES', issuesInfo: [{ error_summary: 'X' }] },
    { id: 'c2', effectiveStatus: 'WITH_ISSUES', issuesInfo: [] },
    { id: 'c3', effectiveStatus: 'DISAPPROVED', issuesInfo: [] },
  ];
  const out = diag.runDiagnostics({ campaigns });
  const abnormal = out.filter((i) => i.type === 'abnormal_status');
  assert.equal(abnormal.length, 2);
  const disapproved = abnormal.find((i) => i.entityIds[0] === 'c3');
  assert.equal(disapproved.severity, 'high');
});

// ============================================================================
// Empirical performance diagnostics
// ============================================================================

test('ruleHighFrequency — flags freq >= 4 with >= 1000 impressions', () => {
  const insightsBundleAd = bundle(
    insight({ adId: 'a1', frequency: 5.2, impressions: 2000, clicks: 20, ctr: 1 }),
    insight({ adId: 'a2', frequency: 3.5, impressions: 2000 }), // below freq threshold
    insight({ adId: 'a3', frequency: 6, impressions: 500 }),    // too few impressions
    insight({ adId: 'a4', frequency: 4.1, impressions: 10000 }),
  );
  const out = diag.runDiagnostics({ insightsBundleAd });
  const hf = out.filter((i) => i.type === 'high_frequency');
  assert.equal(hf.length, 2);
  assert.equal(hf.find((i) => i.entityIds[0] === 'a1').severity, 'medium'); // < 6
  // freq=6 with too-few impressions filtered out
  assert.equal(hf.find((i) => i.entityIds[0] === 'a3'), undefined);
});

test('ruleLowCtr — flags CTR < 0.5% with >= 5000 impressions', () => {
  const insightsBundleAd = bundle(
    insight({ adId: 'a1', ctr: 0.3, impressions: 6000, clicks: 18 }),
    insight({ adId: 'a2', ctr: 0.8, impressions: 6000 }),  // above ctr threshold
    insight({ adId: 'a3', ctr: 0.2, impressions: 3000 }),  // too few impressions
  );
  const out = diag.runDiagnostics({ insightsBundleAd });
  const low = out.filter((i) => i.type === 'low_ctr');
  assert.equal(low.length, 1);
  assert.equal(low[0].entityIds[0], 'a1');
});

test('ruleCpaOutlier — never compares CPA across incompatible objectives', () => {
  // Two campaigns with different objectives (leads vs sales). Each has a
  // high CPA relative to the *other*, but they can't be compared. No outlier
  // should be emitted, and no peer group should be established.
  const campaigns = [
    { id: 'c1', objective: 'OUTCOME_LEADS' },
    { id: 'c2', objective: 'OUTCOME_SALES' },
    { id: 'c3', objective: 'OUTCOME_LEADS' },
  ];
  const insightsBundleCampaign = bundle(
    insight({ campaignId: 'c1', spend: 100, actions: [{ type: 'lead', value: 5 }], costPerAction: [{ type: 'lead', value: 20 }] }),
    insight({ campaignId: 'c2', spend: 100, actions: [{ type: 'purchase', value: 1 }], costPerAction: [{ type: 'purchase', value: 100 }] }),
    insight({ campaignId: 'c3', spend: 100, actions: [{ type: 'lead', value: 4 }], costPerAction: [{ type: 'lead', value: 25 }] }),
  );
  const out = diag.runDiagnostics({ campaigns, insightsBundleCampaign });
  const outliers = out.filter((i) => i.type === 'cpa_outlier');
  // Only 2 lead campaigns → below cpaOutlierMinPeers (3), so no outliers.
  assert.equal(outliers.length, 0);
});

test('ruleCpaOutlier — flags >2× peer average within same objective', () => {
  const campaigns = [
    { id: 'c1', objective: 'OUTCOME_LEADS' },
    { id: 'c2', objective: 'OUTCOME_LEADS' },
    { id: 'c3', objective: 'OUTCOME_LEADS' },
    { id: 'c4', objective: 'OUTCOME_LEADS' },
  ];
  const insightsBundleCampaign = bundle(
    insight({ campaignId: 'c1', spend: 100, actions: [{ type: 'lead', value: 10 }], costPerAction: [{ type: 'lead', value: 10 }] }),
    insight({ campaignId: 'c2', spend: 100, actions: [{ type: 'lead', value: 10 }], costPerAction: [{ type: 'lead', value: 10 }] }),
    insight({ campaignId: 'c3', spend: 100, actions: [{ type: 'lead', value: 10 }], costPerAction: [{ type: 'lead', value: 10 }] }),
    insight({ campaignId: 'c4', spend: 500, actions: [{ type: 'lead', value: 10 }], costPerAction: [{ type: 'lead', value: 50 }] }),
  );
  const out = diag.runDiagnostics({ campaigns, insightsBundleCampaign });
  const outlier = out.find((i) => i.type === 'cpa_outlier');
  assert.ok(outlier);
  assert.equal(outlier.entityIds[0], 'c4');
  // 50 > 10 * 3 → high severity
  assert.equal(outlier.severity, 'high');
});

test('ruleNoResultSpend — flags spend > $50 with 0 mapped results', () => {
  const campaigns = [
    { id: 'c1', objective: 'OUTCOME_LEADS' },
    { id: 'c2', objective: 'OUTCOME_SALES' },
    { id: 'c3', objective: 'OUTCOME_LEADS' }, // low spend, skip
  ];
  const insightsBundleCampaign = bundle(
    // c1: 0 leads on $100 spend → flag
    insight({ campaignId: 'c1', spend: 100, actions: [{ type: 'link_click', value: 50 }] }),
    // c2: has purchases → don't flag
    insight({ campaignId: 'c2', spend: 100, actions: [{ type: 'purchase', value: 3 }], costPerAction: [{ type: 'purchase', value: 33 }] }),
    // c3: below spend floor
    insight({ campaignId: 'c3', spend: 10 }),
  );
  const out = diag.runDiagnostics({ campaigns, insightsBundleCampaign });
  const nrs = out.filter((i) => i.type === 'no_result_spend');
  assert.equal(nrs.length, 1);
  assert.equal(nrs[0].entityIds[0], 'c1');
  assert.equal(nrs[0].severity, 'high');
});

test('ruleSingleAdInSet — flags active ad set with 1 active ad and spend', () => {
  const adsets = [
    { id: 'as1', effectiveStatus: 'ACTIVE' },
    { id: 'as2', effectiveStatus: 'ACTIVE' },
    { id: 'as3', effectiveStatus: 'PAUSED' },
  ];
  const ads = [
    { id: 'ad1', adSetId: 'as1', effectiveStatus: 'ACTIVE' }, // as1 has 1 → flag
    { id: 'ad2', adSetId: 'as2', effectiveStatus: 'ACTIVE' },
    { id: 'ad3', adSetId: 'as2', effectiveStatus: 'ACTIVE' }, // as2 has 2 → no flag
    { id: 'ad4', adSetId: 'as3', effectiveStatus: 'ACTIVE' }, // as3 paused → skip
  ];
  const insightsBundleAdSet = bundle(
    insight({ adSetId: 'as1', spend: 100 }),
    insight({ adSetId: 'as2', spend: 200 }),
  );
  const out = diag.runDiagnostics({ adsets, ads, insightsBundleAdSet });
  const single = out.filter((i) => i.type === 'single_ad_in_set');
  assert.equal(single.length, 1);
  assert.equal(single[0].entityIds[0], 'as1');
  assert.equal(single[0].severity, 'low');
});

test('ruleSingleAdInSet — skips ad set with 1 ad but no meaningful spend', () => {
  const adsets = [{ id: 'as1', effectiveStatus: 'ACTIVE' }];
  const ads = [{ id: 'ad1', adSetId: 'as1', effectiveStatus: 'ACTIVE' }];
  const insightsBundleAdSet = bundle(insight({ adSetId: 'as1', spend: 5 }));
  const out = diag.runDiagnostics({ adsets, ads, insightsBundleAdSet });
  assert.equal(out.filter((i) => i.type === 'single_ad_in_set').length, 0);
});

test('ruleBudgetUnderdelivery — flags ad set spending < 20% of expected', () => {
  const adsets = [
    // dailyBudget stored in minor units (cents); $10/day * 7d = $70 expected
    { id: 'as1', effectiveStatus: 'ACTIVE', dailyBudget: 1000 },
    { id: 'as2', effectiveStatus: 'ACTIVE', dailyBudget: 1000 },
  ];
  const insightsBundleAdSet = bundle(
    insight({ adSetId: 'as1', spend: 5 }),   // 5/70 = 7% → flag
    insight({ adSetId: 'as2', spend: 40 }),  // 40/70 = 57% → no flag
  );
  const out = diag.runDiagnostics({ adsets, insightsBundleAdSet, days: 7 });
  const under = out.filter((i) => i.type === 'budget_underdelivery');
  assert.equal(under.length, 1);
  assert.equal(under[0].entityIds[0], 'as1');
});

test('ruleBudgetUnderdelivery — skipped on windows shorter than 7 days', () => {
  const adsets = [{ id: 'as1', effectiveStatus: 'ACTIVE', dailyBudget: 1000 }];
  const insightsBundleAdSet = bundle(insight({ adSetId: 'as1', spend: 1 }));
  const out = diag.runDiagnostics({ adsets, insightsBundleAdSet, days: 3 });
  assert.equal(out.filter((i) => i.type === 'budget_underdelivery').length, 0);
});

// ============================================================================
// Full pipeline
// ============================================================================

test('runDiagnostics — sorts by severity desc, then id ascending', () => {
  const campaigns = [{ id: 'c1', objective: 'OUTCOME_LEADS' }];
  const insightsBundleAd = bundle(
    insight({ adId: 'a2', frequency: 4.1, impressions: 2000 }), // medium
    insight({ adId: 'a1', frequency: 6, impressions: 2000 }),   // high
  );
  const out = diag.runDiagnostics({ campaigns, insightsBundleAd });
  const hf = out.filter((i) => i.type === 'high_frequency');
  assert.equal(hf[0].severity, 'high');
  assert.equal(hf[1].severity, 'medium');
});

test('runDiagnostics — empty account returns empty array', () => {
  const out = diag.runDiagnostics({});
  assert.deepEqual(out, []);
});

test('runDiagnostics — every issue has the required stable envelope', () => {
  const campaigns = [{ id: 'c1', objective: 'OUTCOME_LEADS', effectiveStatus: 'WITH_ISSUES', issuesInfo: [{ error_summary: 'x', error_message: 'y', error_type: 'HARD_ERROR' }] }];
  const insightsBundleAd = bundle(insight({ adId: 'a1', frequency: 5, impressions: 2000, ctr: 0.3, clicks: 6 }));
  const out = diag.runDiagnostics({ campaigns, insightsBundleAd });
  assert.ok(out.length > 0);
  for (const i of out) {
    assert.ok(i.id, 'id');
    assert.ok(['high', 'medium', 'low'].includes(i.severity), 'severity');
    assert.ok(i.type, 'type');
    assert.ok(i.title, 'title');
    assert.ok(i.guidance, 'guidance');
    assert.ok(i.entityType, 'entityType');
    assert.ok(Array.isArray(i.entityIds), 'entityIds');
    assert.ok(typeof i.metrics === 'object', 'metrics');
    assert.ok(['meta', 'computed'].includes(i.source), 'source');
  }
});
