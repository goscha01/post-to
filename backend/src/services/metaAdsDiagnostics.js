// Meta Ads Diagnostics engine — Phase 1C.
//
// Pure function: takes normalized Phase 1B data (campaigns, adsets, ads,
// insights bundles) and returns a prioritized issue list. No side effects,
// no I/O — the route handler wraps it around service calls.
//
// Every issue emitted here is either:
//   source: 'meta'      → surfaced from a Meta-returned field verbatim
//                          (issues_info, effective_status, etc.)
//   source: 'computed'  → derived by a transparent numeric rule that
//                          operates only on numbers Meta returned directly
//
// Never invent Meta operational rules. Never compare CPA across
// incompatible objectives/action types. When in doubt, surface Meta's own
// wording rather than paraphrase it.
//
// Rule tuning is informed by the live Spotless smoke test — see comments
// on each rule for the observation that shaped it.

const { pickResultForObjective, pickResultActionTypes } = require('./metaAdsService');

// -------- rule thresholds --------
// Kept as module-level constants so tests can spy on them, and so the
// Phase 1E Campaign Assistant can quote them back to the user verbatim.
const THRESHOLDS = {
  // "High frequency" = an ad shown 4+ times to the same user on average, with
  // enough impressions for the number to mean something. 4 is the commonly
  // cited Facebook threshold where CTR starts falling meaningfully.
  frequencyHigh: 4,
  frequencyMinImpressions: 1000,

  // CPA outlier: > 2× the account-average cost per result of the SAME
  // objective. Only fires when we have >= 3 comparable campaigns to
  // establish a stable average and each has >= 10 results.
  cpaOutlierMultiplier: 2,
  cpaOutlierMinResults: 10,
  cpaOutlierMinPeers: 3,

  // Low CTR: < 0.5% with >= 5000 impressions. Below this, the ad is
  // probably not resonating; above 5000 imp we have enough signal to say so.
  ctrLow: 0.5,
  ctrMinImpressions: 5000,

  // No-result spend: spent > $X on a campaign whose mapped result count
  // is 0. Threshold is per-currency-agnostic — we just care about
  // "meaningful spend with nothing to show for it."
  noResultMinSpend: 50,

  // Ad set with only 1 active ad — Meta's own guidance recommends 3-6 for
  // creative rotation. We flag single-ad ad sets as LOW severity.
  singleAdMinSpend: 25,

  // Budget under-delivery: an ad set with a daily_budget that has been
  // spending < 20% of its potential (daily_budget × days) for a full 7d
  // window. Requires we trust the daily_budget field — verified live: it
  // returns as string of minor currency units (e.g. cents for USD).
  //
  // Deliberately conservative: only fires on 7+ day windows because
  // shorter windows are too noisy (weekends, ad approvals, etc).
  budgetUnderdelivery: 0.20,
  budgetUnderdeliveryMinDays: 7,
};

// -------- severity ordering --------
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// -------- id generator --------
// Deterministic ids so diagnostic cards can be dismissed / re-emitted
// across refreshes without duplication in the UI. Not a hash — just
// human-readable enough that a support ticket can reference an id.
function issueId({ type, entityIds }) {
  const key = Array.isArray(entityIds) ? entityIds.slice(0, 5).join(',') : '';
  return `${type}:${key}`;
}

// -------- rule: Meta-returned issues_info --------
//
// Meta populates issues_info on campaign / adset / ad when it can't deliver
// or is delivering with a problem. Live verified: shape is
// { level, error_code, error_summary, error_message, error_type }.
// error_type='HARD_ERROR' is Meta's own signal for "user must fix this
// before delivery resumes" — we map that to HIGH severity, everything
// else to MEDIUM.
function ruleMetaIssuesInfo({ campaigns, adsets, ads }) {
  const issues = [];
  const scan = (entities, entityType) => {
    for (const e of entities || []) {
      for (const info of e.issuesInfo || []) {
        const severity = info.error_type === 'HARD_ERROR' ? 'high' : 'medium';
        issues.push({
          id: `meta_issue:${entityType}:${e.id}:${info.error_code || 'x'}`,
          severity,
          type: 'meta_delivery_issue',
          title: info.error_summary || 'Delivery issue reported by Meta',
          guidance: info.error_message || 'See Meta Ads Manager for details.',
          entityType,
          entityIds: [e.id],
          metrics: {
            errorCode: info.error_code,
            errorType: info.error_type,
            level: info.level,
            effectiveStatus: e.effectiveStatus,
          },
          source: 'meta',
        });
      }
    }
  };
  scan(campaigns, 'campaign');
  scan(adsets, 'adset');
  scan(ads, 'ad');
  return issues;
}

// -------- rule: abnormal effective_status --------
//
// effective_status values that indicate delivery is impaired but Meta
// hasn't populated issues_info yet. WITH_ISSUES is the most direct signal
// (Meta's own admission of a problem). Other values like PENDING_REVIEW /
// DISAPPROVED / PENDING_BILLING_INFO are self-explanatory.
const IMPAIRED_STATUSES = new Set([
  'WITH_ISSUES',
  'DISAPPROVED',
  'PENDING_REVIEW',
  'PENDING_BILLING_INFO',
]);
function ruleAbnormalStatus({ campaigns, adsets, ads }) {
  const issues = [];
  const scan = (entities, entityType) => {
    for (const e of entities || []) {
      if (IMPAIRED_STATUSES.has(e.effectiveStatus)) {
        // Skip if a matching issues_info was already emitted — that path
        // already surfaces the user-actionable guidance.
        if ((e.issuesInfo || []).length) continue;
        issues.push({
          id: `status:${entityType}:${e.id}:${e.effectiveStatus}`,
          severity: e.effectiveStatus === 'DISAPPROVED' ? 'high' : 'medium',
          type: 'abnormal_status',
          title: `${entityType} status: ${e.effectiveStatus}`,
          guidance: 'Meta has flagged this ad as not-fully-delivering. Check Ads Manager for the reason.',
          entityType,
          entityIds: [e.id],
          metrics: { effectiveStatus: e.effectiveStatus },
          source: 'meta',
        });
      }
    }
  };
  scan(campaigns, 'campaign');
  scan(adsets, 'adset');
  scan(ads, 'ad');
  return issues;
}

// -------- rule: high frequency --------
//
// Frequency > 4 with enough impressions to be meaningful. Insights row
// carries `frequency` scalar directly — no derivation.
function ruleHighFrequency({ insightsBundleAd }) {
  const issues = [];
  const rows = insightsBundleAd?.rows || [];
  for (const r of rows) {
    if (
      r.frequency !== null &&
      r.frequency >= THRESHOLDS.frequencyHigh &&
      (r.impressions || 0) >= THRESHOLDS.frequencyMinImpressions
    ) {
      issues.push({
        id: `high_frequency:${r.adId}`,
        severity: r.frequency >= 6 ? 'high' : 'medium',
        type: 'high_frequency',
        title: `Ad shown ${r.frequency.toFixed(1)}× per user`,
        guidance:
          'Refresh the creative or pause. Facebook data shows ad CTR drops meaningfully once frequency crosses 4.',
        entityType: 'ad',
        entityIds: [r.adId].filter(Boolean),
        metrics: {
          frequency: r.frequency,
          impressions: r.impressions,
          reach: r.reach,
          ctr: r.ctr,
        },
        source: 'computed',
      });
    }
  }
  return issues;
}

// -------- rule: low CTR --------
//
// Below 0.5% CTR with meaningful impressions. Meta returns ctr as a
// percentage directly (verified live: "6.09" not "0.0609").
function ruleLowCtr({ insightsBundleAd }) {
  const issues = [];
  const rows = insightsBundleAd?.rows || [];
  for (const r of rows) {
    if (
      r.ctr !== null &&
      r.ctr < THRESHOLDS.ctrLow &&
      (r.impressions || 0) >= THRESHOLDS.ctrMinImpressions
    ) {
      issues.push({
        id: `low_ctr:${r.adId}`,
        severity: 'medium',
        type: 'low_ctr',
        title: `CTR ${r.ctr.toFixed(2)}% below 0.5%`,
        guidance:
          'Test a new creative or headline. Ads below 0.5% CTR at scale are almost always a creative problem, not a targeting one.',
        entityType: 'ad',
        entityIds: [r.adId].filter(Boolean),
        metrics: {
          ctr: r.ctr,
          impressions: r.impressions,
          clicks: r.clicks,
        },
        source: 'computed',
      });
    }
  }
  return issues;
}

// -------- rule: CPA outlier within objective peer group --------
//
// For each objective present in the account, compute the account-average
// cost per result on that objective's mapped action_type. Then flag any
// campaign whose CPA is >2× that average, with enough results in the
// campaign to be statistically meaningful. Never compares across
// objectives (leads vs sales vs messages) — that would be nonsense.
function ruleCpaOutlier({ campaigns, insightsBundleCampaign }) {
  const issues = [];
  const rows = insightsBundleCampaign?.rows || [];
  const campaignsById = new Map((campaigns || []).map((c) => [c.id, c]));

  // Bucket rows by (objective + mapped resultActionType). Skip rows whose
  // objective isn't mapped or whose actionType isn't present in the row.
  const buckets = new Map();
  for (const r of rows) {
    const camp = campaignsById.get(r.campaignId);
    if (!camp?.objective) continue;
    const pick = pickResultForObjective(camp.objective, r);
    if (pick.results === null || pick.costPerResult === null) continue;
    const key = `${camp.objective}::${pick.resultActionType}`;
    const arr = buckets.get(key) || [];
    arr.push({ campaign: camp, row: r, results: pick.results, cpr: pick.costPerResult });
    buckets.set(key, arr);
  }

  for (const [key, members] of buckets) {
    if (members.length < THRESHOLDS.cpaOutlierMinPeers) continue;
    // High-signal members = campaigns with >= 10 results in this bucket
    // (throw out low-signal noise). Fall back to all members if we don't
    // have enough high-signal ones for a stable comparison.
    const highSignal = members.filter((m) => m.results >= THRESHOLDS.cpaOutlierMinResults);
    const sample = highSignal.length >= THRESHOLDS.cpaOutlierMinPeers ? highSignal : members;

    for (const m of members) {
      if (m.results < THRESHOLDS.cpaOutlierMinResults) continue;
      // Recompute the peer average EXCLUDING the candidate — otherwise a
      // single high outlier drags the mean up and hides its own extremity.
      const peers = sample.filter((s) => s.campaign.id !== m.campaign.id);
      if (peers.length < THRESHOLDS.cpaOutlierMinPeers - 1) continue;
      const avg = peers.reduce((sum, p) => sum + p.cpr, 0) / peers.length;
      if (!Number.isFinite(avg) || avg <= 0) continue;
      if (m.cpr <= avg * THRESHOLDS.cpaOutlierMultiplier) continue;
      issues.push({
        id: `cpa_outlier:${m.campaign.id}`,
        severity: m.cpr > avg * 3 ? 'high' : 'medium',
        type: 'cpa_outlier',
        title: `Cost per ${m.row.actionsByType[key.split('::')[1]] !== undefined ? key.split('::')[1] : 'result'} ${(m.cpr / avg).toFixed(1)}× the account average`,
        guidance:
          'Pause the outlier so budget can shift to more efficient campaigns targeting the same result.',
        entityType: 'campaign',
        entityIds: [m.campaign.id],
        metrics: {
          costPerResult: m.cpr,
          peerAvgCostPerResult: avg,
          results: m.results,
          spend: m.row.spend,
          objective: m.campaign.objective,
          resultActionType: key.split('::')[1],
        },
        source: 'computed',
      });
    }
  }
  return issues;
}

// -------- rule: meaningful spend with no mapped result --------
//
// If a campaign spent > $50 in the window but the mapped result action_type
// returned zero, flag it. This is honest even when the objective/action
// mapping isn't perfect: we're just saying "you spent real money and Meta
// reports zero of the thing you optimized for."
//
// Skip campaigns whose objective isn't mapped at all — that's a
// coverage gap in pickResultForObjective, not a customer problem.
function ruleNoResultSpend({ campaigns, insightsBundleCampaign }) {
  const issues = [];
  const rows = insightsBundleCampaign?.rows || [];
  const campaignsById = new Map((campaigns || []).map((c) => [c.id, c]));
  for (const r of rows) {
    if ((r.spend || 0) < THRESHOLDS.noResultMinSpend) continue;
    const camp = campaignsById.get(r.campaignId);
    if (!camp?.objective) continue;
    // Skip campaigns whose objective isn't in our mapping — that's a
    // coverage gap in pickResultForObjective, not a customer problem.
    const candidates = pickResultActionTypes(camp.objective);
    if (!candidates || candidates.length === 0) continue;
    const pick = pickResultForObjective(camp.objective, r);
    // Skip if there ARE mapped results in the row.
    if (pick.results !== null && pick.results > 0) continue;
    // The rule fires when: objective is mapped, candidate action_types are
    // known, but NONE of them show up in the row's actionsByType (result
    // count is null) OR they show up with 0 count. Both mean "money spent,
    // Meta reports no results of the expected type."
    const primaryActionType = candidates[0];
    issues.push({
      id: `no_result_spend:${camp.id}`,
      severity: 'high',
      type: 'no_result_spend',
      title: `$${(r.spend || 0).toFixed(2)} spent with 0 ${primaryActionType} results`,
      guidance:
        'Check that the Meta Pixel (or CAPI) is firing the expected event, and confirm the campaign objective still matches your business goal.',
      entityType: 'campaign',
      entityIds: [camp.id],
      metrics: {
        spend: r.spend,
        objective: camp.objective,
        resultActionType: primaryActionType,
        results: pick.results || 0,
      },
      source: 'computed',
    });
  }
  return issues;
}

// -------- rule: ad set with only one active ad --------
//
// Meta's own guidance is to run 3-6 ads per ad set so the algorithm has
// creative variety to pick from. One ad = no rotation.
function ruleSingleAdInSet({ adsets, ads, insightsBundleAdSet }) {
  const issues = [];
  const activeAdsByAdSet = new Map();
  for (const a of ads || []) {
    if (a.effectiveStatus !== 'ACTIVE') continue;
    const list = activeAdsByAdSet.get(a.adSetId) || [];
    list.push(a);
    activeAdsByAdSet.set(a.adSetId, list);
  }
  const insightsByAdSet = new Map(
    (insightsBundleAdSet?.rows || []).map((r) => [r.adSetId, r])
  );
  for (const set of adsets || []) {
    if (set.effectiveStatus !== 'ACTIVE') continue;
    const activeAds = activeAdsByAdSet.get(set.id) || [];
    if (activeAds.length !== 1) continue;
    const insight = insightsByAdSet.get(set.id);
    // Only flag if the ad set has meaningful spend — a fresh, low-spend
    // set with 1 ad might just be in setup.
    if ((insight?.spend || 0) < THRESHOLDS.singleAdMinSpend) continue;
    issues.push({
      id: `single_ad_in_set:${set.id}`,
      severity: 'low',
      type: 'single_ad_in_set',
      title: 'Ad set has only 1 active ad',
      guidance:
        'Add 2-5 more creatives so Meta can rotate and optimize. Single-ad sets can\'t benefit from creative optimization.',
      entityType: 'adset',
      entityIds: [set.id],
      metrics: {
        activeAdCount: 1,
        spend: insight?.spend || 0,
      },
      source: 'computed',
    });
  }
  return issues;
}

// -------- rule: budget under-delivery --------
//
// Ad set spending < 20% of its daily_budget × elapsed days for a full
// 7d+ window. Live verified: daily_budget returns as string of minor
// currency units (cents for USD), so we divide by 100 to compare to spend.
// Skips CBO campaigns (where budget lives on the campaign, not the adset)
// by requiring daily_budget > 0 on the ad set itself.
function ruleBudgetUnderdelivery({ adsets, insightsBundleAdSet, days }) {
  if (!days || days < THRESHOLDS.budgetUnderdeliveryMinDays) return [];
  const issues = [];
  const insightsByAdSet = new Map(
    (insightsBundleAdSet?.rows || []).map((r) => [r.adSetId, r])
  );
  for (const set of adsets || []) {
    if (set.effectiveStatus !== 'ACTIVE') continue;
    // daily_budget is in minor currency units (cents for USD).
    const dailyBudgetMajor = (set.dailyBudget || 0) / 100;
    if (dailyBudgetMajor <= 0) continue;
    const insight = insightsByAdSet.get(set.id);
    const spend = insight?.spend || 0;
    const expected = dailyBudgetMajor * days;
    if (expected <= 0) continue;
    const ratio = spend / expected;
    if (ratio >= THRESHOLDS.budgetUnderdelivery) continue;
    issues.push({
      id: `budget_underdelivery:${set.id}`,
      severity: 'medium',
      type: 'budget_underdelivery',
      title: `Ad set spent ${(ratio * 100).toFixed(0)}% of budget over ${days} days`,
      guidance:
        'The audience may be too narrow, the bid too low, or the ad set is stuck in review. Meta is not spending the money you allocated.',
      entityType: 'adset',
      entityIds: [set.id],
      metrics: {
        dailyBudget: dailyBudgetMajor,
        expectedSpend: expected,
        actualSpend: spend,
        deliveryRatio: ratio,
        days,
      },
      source: 'computed',
    });
  }
  return issues;
}

// -------- top-level entry point --------
//
// Input shape (all fields optional; missing sections just yield no rules):
//   {
//     campaigns:              [{id, name, objective, effectiveStatus, ...}],
//     adsets:                 [{id, name, campaignId, effectiveStatus, ...}],
//     ads:                    [{id, name, adSetId, effectiveStatus, ...}],
//     insightsBundleCampaign: { rows: [normalized insight rows] },
//     insightsBundleAdSet:    { rows: [normalized insight rows] },
//     insightsBundleAd:       { rows: [normalized insight rows] },
//     days:                   30,
//   }
//
// Output: sorted (severity desc, then id) list of issue objects. Empty
// array on empty input.
function runDiagnostics(input) {
  const {
    campaigns = [],
    adsets = [],
    ads = [],
    insightsBundleCampaign = { rows: [] },
    insightsBundleAdSet = { rows: [] },
    insightsBundleAd = { rows: [] },
    days = 30,
  } = input || {};

  const all = [
    ...ruleMetaIssuesInfo({ campaigns, adsets, ads }),
    ...ruleAbnormalStatus({ campaigns, adsets, ads }),
    ...ruleHighFrequency({ insightsBundleAd }),
    ...ruleLowCtr({ insightsBundleAd }),
    ...ruleCpaOutlier({ campaigns, insightsBundleCampaign }),
    ...ruleNoResultSpend({ campaigns, insightsBundleCampaign }),
    ...ruleSingleAdInSet({ adsets, ads, insightsBundleAdSet }),
    ...ruleBudgetUnderdelivery({ adsets, insightsBundleAdSet, days }),
  ];
  all.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return String(a.id).localeCompare(String(b.id));
  });
  return all;
}

module.exports = {
  runDiagnostics,
  THRESHOLDS,
  // Individual rules exposed for targeted tests.
  _rules: {
    ruleMetaIssuesInfo,
    ruleAbnormalStatus,
    ruleHighFrequency,
    ruleLowCtr,
    ruleCpaOutlier,
    ruleNoResultSpend,
    ruleSingleAdInSet,
    ruleBudgetUnderdelivery,
  },
  _helpers: { issueId, IMPAIRED_STATUSES, SEVERITY_ORDER },
};
