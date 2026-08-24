// Tests for backend/src/services/metaAttribution.js (Phase 1D).
//
// Covers the four attribution-quality tiers (campaign / partial / channel /
// none), fuzzy-match refusal, unmatched partitioning, and the internal
// row classifier.

const test = require('node:test');
const assert = require('node:assert');
const attr = require('../src/services/metaAttribution');

// -------- helpers --------
function metaCamp({ id, name, spend = 10, objective = 'OUTCOME_LEADS', results = 1, resultActionType = 'lead', costPerResult = 10 }) {
  return { id, name, spend, objective, results, resultActionType, costPerResult };
}
function ga4Row({ source, medium, campaign, sessions = 100, conversions = 5, users = 80, revenue = 0 }) {
  return { source, medium, campaign, sessions, conversions, users, revenue };
}

// ============================================================================
// classifier — internal
// ============================================================================

test('classifyGa4RowForMeta: source keyword facebook → isMeta', () => {
  const r = attr._internal.classifyGa4RowForMeta({ source: 'facebook', medium: 'cpc' });
  assert.equal(r.isMeta, true);
  assert.equal(r.kind, 'source_keyword');
});

test('classifyGa4RowForMeta: source m.facebook.com → isMeta via fragment', () => {
  const r = attr._internal.classifyGa4RowForMeta({ source: 'm.facebook.com', medium: 'referral' });
  assert.equal(r.isMeta, true);
  assert.equal(r.kind, 'source_fragment');
});

test('classifyGa4RowForMeta: campaign hint requires paid medium', () => {
  // campaign contains "facebook" but medium is (none) → do not claim Meta
  const softClaim = attr._internal.classifyGa4RowForMeta({
    source: '(direct)', medium: '(none)', campaign: 'facebook_promo',
  });
  assert.equal(softClaim.isMeta, false);
  // Same but medium=cpc → we accept the hint
  const strongClaim = attr._internal.classifyGa4RowForMeta({
    source: '(direct)', medium: 'cpc', campaign: 'facebook_promo',
  });
  assert.equal(strongClaim.isMeta, true);
  assert.equal(strongClaim.kind, 'campaign_hint');
});

test('classifyGa4RowForMeta: generic social medium alone is NOT claimed as Meta', () => {
  const r = attr._internal.classifyGa4RowForMeta({ source: 'linkedin.com', medium: 'social' });
  assert.equal(r.isMeta, false);
});

// ============================================================================
// A — Campaign-level reliable
// ============================================================================

test('quality=campaign when ≥75% of meta campaigns exact-match GA4', () => {
  const metaCampaigns = [
    metaCamp({ id: 'm1', name: 'Spring Leads FL' }),
    metaCamp({ id: 'm2', name: 'Spring Leads TX' }),
    metaCamp({ id: 'm3', name: 'Spring Leads CA' }),
    metaCamp({ id: 'm4', name: 'Retargeting' }),
  ];
  const ga4Rows = [
    ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'Spring Leads FL' }),
    ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'Spring Leads TX' }),
    ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'Spring Leads CA' }),
    ga4Row({ source: 'google', medium: 'cpc', campaign: 'Google Brand' }),
  ];
  const r = attr.analyzeMetaAttribution({
    metaCampaignsWithSpend: metaCampaigns,
    ga4TrafficSources: ga4Rows,
  });
  assert.equal(r.quality, 'campaign');
  assert.equal(r.matchedCampaigns, 3);
  assert.equal(r.totalMetaCampaigns, 4);
  assert.equal(r.byCampaign.length, 3);
  // Every match must have the required envelope
  for (const m of r.byCampaign) {
    assert.equal(m.matchLevel, 'campaign');
    assert.equal(m.confidence, 'high');
    assert.ok(m.matchReason);
    assert.ok(m.meta);
    assert.ok(m.ga4);
  }
  // The unmatched Meta campaign is preserved separately
  assert.equal(r.unmatchedMetaCampaigns.length, 1);
  assert.equal(r.unmatchedMetaCampaigns[0].campaignId, 'm4');
});

// ============================================================================
// B — Partial campaign-level
// ============================================================================

test('quality=partial when 25-75% match; unmatched left unmatched (no fuzzy)', () => {
  const metaCampaigns = [
    metaCamp({ id: 'm1', name: 'Summer Lead Gen' }),
    metaCamp({ id: 'm2', name: 'Awareness_FL_2026' }),
    metaCamp({ id: 'm3', name: 'Retargeting Q3' }),
    metaCamp({ id: 'm4', name: 'Boost_Post_July' }),
  ];
  const ga4Rows = [
    ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'Summer Lead Gen' }),
    ga4Row({ source: 'instagram', medium: 'cpc', campaign: 'Awareness_FL_2026' }),
    // Nothing for m3 or m4 in GA4
    ga4Row({ source: 'google', medium: 'cpc', campaign: 'Different Campaign' }),
  ];
  const r = attr.analyzeMetaAttribution({
    metaCampaignsWithSpend: metaCampaigns,
    ga4TrafficSources: ga4Rows,
  });
  assert.equal(r.quality, 'partial');
  assert.equal(r.matchedCampaigns, 2);
  assert.equal(r.totalMetaCampaigns, 4);
  assert.equal(r.unmatchedMetaCampaigns.length, 2);
});

test('never fuzzy-matches on similar names', () => {
  const metaCampaigns = [metaCamp({ id: 'm1', name: 'Winter Leads' })];
  const ga4Rows = [
    // Similar but not identical — must NOT match
    ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'Winter Leads FL' }),
  ];
  const r = attr.analyzeMetaAttribution({
    metaCampaignsWithSpend: metaCampaigns,
    ga4TrafficSources: ga4Rows,
  });
  assert.equal(r.matchedCampaigns, 0);
  assert.equal(r.byCampaign.length, 0);
  assert.equal(r.unmatchedMetaCampaigns.length, 1);
  assert.equal(r.unmatchedGa4Campaigns.length, 1);
});

// ============================================================================
// C — Channel-level only
// ============================================================================

test('quality=channel when GA4 has meta traffic but campaign names do not join', () => {
  // Matches the observed live Spotless account: Marketplace-boost campaigns
  // with auto-generated names, GA4 sees m.facebook.com/referral traffic
  // with campaign=(not set).
  const metaCampaigns = [
    metaCamp({ id: 'm1', name: '[2011 Toyota Prius] Marketplace listing boosted on 7/28/2026' }),
    metaCamp({ id: 'm2', name: '[Beige Drawers] Marketplace listing boosted on 7/24/2026' }),
  ];
  const ga4Rows = [
    ga4Row({ source: 'm.facebook.com', medium: 'referral', campaign: '(not set)', sessions: 1, conversions: 1 }),
    ga4Row({ source: 'google', medium: 'organic', campaign: '(not set)', sessions: 400 }),
  ];
  const r = attr.analyzeMetaAttribution({
    metaCampaignsWithSpend: metaCampaigns,
    ga4TrafficSources: ga4Rows,
  });
  assert.equal(r.quality, 'channel');
  assert.equal(r.matchedCampaigns, 0);
  assert.equal(r.channelRollup.sessions, 1);
  assert.equal(r.channelRollup.conversions, 1);
  assert.equal(r.channelRollup.rowCount, 1);
  assert.ok(r.notes.some((n) => /channel-level/i.test(n)));
});

// ============================================================================
// D — No useful attribution
// ============================================================================

test('quality=none when no matches AND no meta-source GA4 traffic', () => {
  const metaCampaigns = [metaCamp({ id: 'm1', name: 'Test Camp' })];
  const ga4Rows = [
    ga4Row({ source: 'google', medium: 'cpc', campaign: 'Google Brand', sessions: 500 }),
    ga4Row({ source: '(direct)', medium: '(none)', campaign: '(not set)', sessions: 100 }),
  ];
  const r = attr.analyzeMetaAttribution({
    metaCampaignsWithSpend: metaCampaigns,
    ga4TrafficSources: ga4Rows,
  });
  assert.equal(r.quality, 'none');
  assert.equal(r.channelRollup.sessions, 0);
});

test('quality=none when no meta campaigns spent in the window', () => {
  const r = attr.analyzeMetaAttribution({
    metaCampaignsWithSpend: [],
    ga4TrafficSources: [ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'X' })],
  });
  assert.equal(r.quality, 'none');
  assert.equal(r.totalMetaCampaigns, 0);
});

// ============================================================================
// Envelope invariants
// ============================================================================

test('every matched record carries the full envelope', () => {
  const r = attr.analyzeMetaAttribution({
    metaCampaignsWithSpend: [metaCamp({ id: 'm1', name: 'X' })],
    ga4TrafficSources: [ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'X' })],
  });
  const m = r.byCampaign[0];
  assert.ok(m);
  assert.ok('matchLevel' in m);
  assert.ok('confidence' in m);
  assert.ok('matchReason' in m);
  assert.ok('metaCampaign' in m);
  assert.ok('ga4Campaign' in m);
  assert.ok('meta' in m);
  assert.ok('ga4' in m);
});

test('classifyGa4RowForMeta: exact "instagram" source is Meta', () => {
  const r = attr._internal.classifyGa4RowForMeta({ source: 'instagram', medium: 'cpc' });
  assert.equal(r.isMeta, true);
  assert.equal(r.kind, 'source_keyword');
});

test('metaGa4CampaignIndex sums duplicate campaign-name rows', () => {
  const idx = attr._internal.metaGa4CampaignIndex([
    ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'Same', sessions: 10, conversions: 1 }),
    ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'Same', sessions: 5, conversions: 0 }),
    ga4Row({ source: 'facebook', medium: 'cpc', campaign: '(not set)', sessions: 999 }),
  ]);
  const same = idx.get('same');
  assert.equal(same.sessions, 15);
  assert.equal(same.conversions, 1);
  assert.equal(idx.has('(not set)'), false);
});

test('channelRollup ignores non-meta rows', () => {
  const roll = attr._internal.metaChannelRollup([
    ga4Row({ source: 'google', medium: 'cpc', campaign: 'X', sessions: 100 }),
    ga4Row({ source: 'facebook', medium: 'cpc', campaign: 'Y', sessions: 50 }),
    ga4Row({ source: 'l.instagram.com', medium: 'referral', campaign: '(not set)', sessions: 20 }),
  ]);
  assert.equal(roll.sessions, 70);
  assert.equal(roll.rowCount, 2);
});
