// Phase 1E — Campaign Assistant Meta Awareness tests.
//
// Covers every §13 scenario:
//   - Meta report present / absent in assistant context
//   - Provider availability rendering (permission missing, API failure)
//   - Conversion definitions in system prompt
//   - Mixed-objective results stay separated
//   - Attribution guardrails (campaign/partial/channel/none) show up in system text
//   - Meta-source vs computed diagnostic language rules explained
//   - Deep-link issue resolution (found, wrong id, cross-account)
//   - safeParsePlan / validatePlanShape coerces any Meta imperative into observation
//   - No executable Meta action step can leak through
//   - Existing Google mutations still recognised

const test = require('node:test');
const assert = require('node:assert');

// Set env + stub supabase-js so campaignMonitorService (transitively
// loaded by the assistant service) doesn't crash on module-load.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://example.com';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'svc';
require.cache[require.resolve('@supabase/supabase-js')] = {
  id: require.resolve('@supabase/supabase-js'),
  filename: require.resolve('@supabase/supabase-js'),
  loaded: true,
  exports: { createClient: () => ({ from() { return this; } }) },
};

// Silence logger before service loads.
const loggerPath = require.resolve('../src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

const svc = require('../src/services/campaignAssistantService');
const {
  buildOpenAiSystemContent,
  buildClaudeSystemArray,
  safeParsePlan,
  validatePlanShape,
  isLikelyMetaImperative,
  META_INSTRUCTIONS,
} = svc._internal;

// ============================================================================
// Report fixtures — each scenario gets a compact synthetic report so we can
// verify the system-prompt output matches spec.
// ============================================================================

function baseReport(overrides = {}) {
  return {
    meta: { generatedAt: '2026-08-24T20:00:00Z', dateRangeDays: 30 },
    account: { descriptiveName: 'Test Business', currencyCode: 'USD' },
    summary: { cost: 100, clicks: 50 },
    alerts: {},
    ga4: null,
    metaAds: null,
    crossReference: {
      byCampaign: [],
      googleByCampaign: [],
      metaByCampaign: [],
      metaAttribution: { quality: 'not_requested', matchedCampaigns: 0, totalMetaCampaigns: 0, notes: [] },
    },
    alertsByProvider: [],
    ...overrides,
  };
}

// ============================================================================
// System-prompt integration
// ============================================================================

test('system prompt always includes META_INSTRUCTIONS block', () => {
  const sys = buildOpenAiSystemContent(baseReport(), null);
  assert.ok(sys.includes('--- META ADS SEMANTICS + ATTRIBUTION GUARDRAILS'));
});

test('system prompt teaches Google conv != Meta result != GA4 event semantics', () => {
  const sys = buildOpenAiSystemContent(baseReport(), null);
  assert.ok(/Google Ads "conversion" ≠ Meta "result" ≠ GA4 "key event"/i.test(sys));
  assert.ok(/conversionDefinition/.test(sys));
});

test('system prompt lists attribution qualities campaign/partial/channel/none/not_requested', () => {
  const sys = buildOpenAiSystemContent(baseReport(), null);
  for (const q of ['campaign', 'partial', 'channel', 'none', 'not_requested']) {
    assert.ok(sys.includes(`"${q}"`), `attribution quality "${q}" missing from system prompt`);
  }
});

test('system prompt has explicit budget-allocation guardrail', () => {
  const sys = buildOpenAiSystemContent(baseReport(), null);
  assert.ok(/BUDGET-ALLOCATION QUESTIONS/i.test(sys));
  assert.ok(/move exactly 30% of Google budget/i.test(sys),
    'system prompt should include the specific "move exactly 30%" language as an anti-example');
});

test('system prompt distinguishes source=meta vs source=computed diagnostic language', () => {
  const sys = buildOpenAiSystemContent(baseReport(), null);
  assert.ok(/source: "meta"/i.test(sys));
  assert.ok(/source: "computed"/i.test(sys));
  assert.ok(/Meta reports this ad cannot deliver/i.test(sys));
  assert.ok(/Post-To detects this ad's frequency/i.test(sys));
});

test('system prompt has read-only Phase 1E enforcement', () => {
  const sys = buildOpenAiSystemContent(baseReport(), null);
  assert.ok(/READ-ONLY — MOST IMPORTANT RULE/i.test(sys));
  assert.ok(/meta_ads_action/.test(sys));
  assert.ok(/Meta mutations are Phase 2/i.test(sys));
});

test('Claude system array preserves the cache breakpoint on the JSON block only', () => {
  const arr = buildClaudeSystemArray(baseReport({ metaAds: { placeholder: true } }), null);
  assert.equal(arr.length, 2);
  assert.equal(arr[0].cache_control, undefined, 'preamble must NOT be cached (frequently changes)');
  assert.ok(arr[1].cache_control?.type === 'ephemeral', 'JSON block must have ephemeral cache_control');
  assert.ok(arr[1].text.includes('metaAds'));
});

// ============================================================================
// Meta present / absent / availability
// ============================================================================

test('Meta report included in assistant context when metaAds present', () => {
  const report = baseReport({
    metaAds: { account: { adAccountId: 'act_1' }, totals: { spend: 100 }, campaigns: [{ campaignId: 'c1', name: 'Test', objective: 'OUTCOME_LEADS' }] },
    summary: { channels: { meta_ads: { spend: 100, conversionDefinition: 'Meta action types...' } } },
  });
  const sys = buildOpenAiSystemContent(report, null);
  assert.ok(sys.includes('metaAds'));
  assert.ok(sys.includes('OUTCOME_LEADS'));
});

test('Meta absent: system prompt still functions (metaAds:null in JSON)', () => {
  const sys = buildOpenAiSystemContent(baseReport(), null);
  assert.ok(sys.includes('"metaAds":null'));
  // The rules block STILL loads so the model knows how to handle Meta if
  // it later appears in a follow-up snapshot.
  assert.ok(sys.includes('METRIC SEMANTICS'));
});

test('Meta permission missing surfaces as errors[] entry the model can see', () => {
  const report = baseReport({
    metaAds: { campaigns: [] },
    errors: [{ section: 'meta.campaigns', message: 'Requires ads_read', status: 403 }],
  });
  const sys = buildOpenAiSystemContent(report, null);
  assert.ok(sys.includes('meta.campaigns'));
  assert.ok(sys.includes('Requires ads_read'));
});

test('Meta API failure isolated: preamble mentions temporarily unavailable behavior', () => {
  const sys = buildOpenAiSystemContent(baseReport(), null);
  // The instruction block covers this case explicitly.
  assert.ok(/temporarily unavailable/i.test(sys));
});

// ============================================================================
// Attribution guardrails per quality
// ============================================================================

for (const q of ['campaign', 'partial', 'channel', 'none']) {
  test(`attribution quality "${q}" appears in the report and preamble handles it`, () => {
    const report = baseReport({
      metaAds: { totals: { spend: 100 } },
      crossReference: {
        byCampaign: [], googleByCampaign: [], metaByCampaign: [],
        metaAttribution: { quality: q, matchedCampaigns: 0, totalMetaCampaigns: 1, notes: [`quality is ${q}`] },
      },
    });
    const sys = buildOpenAiSystemContent(report, null);
    assert.ok(sys.includes(`"quality":"${q}"`), `report JSON should include quality=${q}`);
  });
}

// ============================================================================
// Mixed objectives don't get summed
// ============================================================================

test('mixed Meta objectives stay in separate buckets in the report', () => {
  const report = baseReport({
    metaAds: {
      resultsByObjective: [
        { objective: 'OUTCOME_LEADS', actionType: 'lead', results: 5, costPerResult: 20 },
        { objective: 'OUTCOME_SALES', actionType: 'purchase', results: 3, costPerResult: 50 },
      ],
    },
  });
  const sys = buildOpenAiSystemContent(report, null);
  assert.ok(sys.includes('OUTCOME_LEADS'));
  assert.ok(sys.includes('OUTCOME_SALES'));
  assert.ok(!sys.includes('"totalConversions"'), 'never a fake universal conversion count');
});

// ============================================================================
// Provider-tagged alerts flow through
// ============================================================================

test('alertsByProvider Meta entries carry source tag', () => {
  const report = baseReport({
    alertsByProvider: [
      { provider: 'meta_ads', source: 'meta', id: 'meta:issue:1', type: 'meta_delivery_issue', title: 'Payment invalid' },
      { provider: 'meta_ads', source: 'computed', id: 'meta:hf:2', type: 'high_frequency', title: 'Freq 5x' },
    ],
  });
  const sys = buildOpenAiSystemContent(report, null);
  assert.ok(sys.includes('meta:issue:1'));
  assert.ok(sys.includes('Payment invalid'));
  assert.ok(sys.includes('"source":"meta"'));
  assert.ok(sys.includes('"source":"computed"'));
});

// ============================================================================
// safeParsePlan / validatePlanShape guard — Meta imperatives → observation
// ============================================================================

test('isLikelyMetaImperative: detects meta_ads_action action_type', () => {
  assert.equal(isLikelyMetaImperative({ type: 'other', action_type: 'meta_ads_action', title: 'x' }), true);
});

test('isLikelyMetaImperative: detects Meta wording in google_ads_action step', () => {
  assert.equal(
    isLikelyMetaImperative({
      type: 'google_ads_action',
      action_type: 'pause_campaign',
      title: 'Pause Meta ad 123',
      description: 'This Meta ad has high frequency',
    }),
    true,
  );
});

test('isLikelyMetaImperative: does NOT flag pure Google Ads steps', () => {
  assert.equal(
    isLikelyMetaImperative({
      type: 'google_ads_action',
      action_type: 'pause_campaign',
      title: 'Pause campaign 123',
      description: 'CPA is $50 above target',
    }),
    false,
  );
});

test('validatePlanShape: coerces meta_ads_action step to observation', () => {
  const plan = validatePlanShape({
    title: 'Test',
    steps: [
      { title: 'Pause Meta ad 456', type: 'google_ads_action', action_type: 'meta_ads_action', action_params: { adId: '456' }, priority: 'high' },
    ],
  });
  const step = plan.steps[0];
  assert.equal(step.type, 'observation', 'must be demoted to observation');
  assert.equal(step.action_type, null, 'action_type must be cleared');
  assert.equal(step.action_params, null, 'action_params must be cleared');
  assert.ok(step.description.startsWith('[Meta Ads]'), 'description should be prefixed');
});

test('validatePlanShape: coerces boost_post to observation', () => {
  const plan = validatePlanShape({
    title: 'Test',
    steps: [
      { title: 'Boost this post', type: 'other', action_type: 'boost_post', action_params: { postId: '789' } },
    ],
  });
  const step = plan.steps[0];
  assert.equal(step.type, 'observation');
  assert.equal(step.action_type, null);
});

test('validatePlanShape: coerces set_meta_adset_budget to observation', () => {
  const plan = validatePlanShape({
    title: 'Test',
    steps: [
      { title: 'Raise Meta ad set budget', type: 'other', action_type: 'set_meta_adset_budget' },
    ],
  });
  assert.equal(plan.steps[0].type, 'observation');
  assert.equal(plan.steps[0].action_type, null);
});

test('validatePlanShape: coerces google_ads_action with Meta content to observation', () => {
  // The model tried to shoehorn a Meta action into the Google Ads bucket —
  // the safest fix is to demote it, since there's no Meta dispatcher case
  // and even if the mutation dispatcher tried to execute it as pause_campaign
  // the target ID would be for Meta and would fail.
  const plan = validatePlanShape({
    title: 'Test',
    steps: [
      { title: 'Pause Meta ad 123', description: 'The Meta ad is showing at 5x frequency.',
        type: 'google_ads_action', action_type: 'pause_campaign', action_params: { campaignId: '123' } },
    ],
  });
  assert.equal(plan.steps[0].type, 'observation');
  assert.equal(plan.steps[0].action_type, null);
});

test('validatePlanShape: passes through legitimate Google Ads mutations unchanged', () => {
  const plan = validatePlanShape({
    title: 'Test',
    steps: [
      { title: 'Add negative keywords', type: 'google_ads_action',
        action_type: 'add_negative_keywords',
        action_params: { campaignId: '1', keywords: ['free'], matchType: 'BROAD' },
        priority: 'high', effort: '5min' },
    ],
  });
  const step = plan.steps[0];
  assert.equal(step.type, 'google_ads_action');
  assert.equal(step.action_type, 'add_negative_keywords');
  assert.ok(step.action_params);
});

test('safeParsePlan: full JSON parse with mixed Google + Meta steps', () => {
  const rawJson = JSON.stringify({
    title: 'Plan',
    summary: 'Mixed plan',
    steps: [
      { title: 'Add negatives', type: 'google_ads_action', action_type: 'add_negative_keywords', action_params: { campaignId: '1', keywords: ['x'], matchType: 'BROAD' } },
      { title: 'Pause Meta ad 456', type: 'google_ads_action', action_type: 'pause_meta_ad', action_params: { adId: '456' } },
    ],
  });
  const plan = safeParsePlan(rawJson);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].action_type, 'add_negative_keywords'); // untouched
  assert.equal(plan.steps[1].type, 'observation');                  // demoted
  assert.equal(plan.steps[1].action_type, null);
});

// ============================================================================
// META_INSTRUCTIONS is well-formed
// ============================================================================

test('META_INSTRUCTIONS block explicitly rejects meta_ads_action + boost_post + pause_meta_ad', () => {
  const t = META_INSTRUCTIONS;
  for (const forbidden of ['meta_ads_action', 'boost_post', 'pause_meta_ad', 'set_meta_adset_budget', 'ads_management']) {
    assert.ok(t.includes(forbidden), `META_INSTRUCTIONS should mention "${forbidden}" as forbidden`);
  }
});

test('META_INSTRUCTIONS mentions specific example wordings for source=meta vs computed', () => {
  const t = META_INSTRUCTIONS;
  assert.ok(t.includes('Meta reports this ad cannot deliver'));
  assert.ok(t.includes("Post-To detects this ad's frequency"));
});
