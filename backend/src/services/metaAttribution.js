// Meta ↔ GA4 attribution engine — Phase 1D.
//
// Pure function. Given Meta campaigns (with spend) + GA4 traffic-source
// rows, classify the attribution quality and produce a cross-reference
// list that Campaign Assistant / the frontend can trust.
//
// The engine deliberately does NOT fuzzy-match on similar-looking campaign
// names. Every emitted match carries an explicit { matchLevel, confidence,
// matchReason } so downstream code can decide when to trust it.
//
// Quality tiers per spec §3:
//   A "campaign" → ≥ 75% of Meta campaigns with spend match a GA4 campaign
//                  by exact name (case-insensitive, trimmed). Full trust.
//   B "partial"  → some (25% ≤ x < 75%) match cleanly, rest unmatched.
//                  Report matches; leave the rest UNMATCHED (never fake).
//   C "channel"  → almost no campaign-level match, but GA4 shows Meta
//                  paid/social traffic. Return channel-level rollup only.
//   D "none"     → no match, no Meta-attributable GA4 traffic. Emit warning.
//
// The Spotless account observed during Gate 1 fell into tier C: Marketplace
// boost campaigns produce auto-generated names Meta doesn't tag with UTMs,
// so GA4 sees only source=m.facebook.com/medium=referral traffic with
// campaign=(not set). The engine emits `quality:'channel'` with a note.

// Signal patterns — kept strict so we never claim "this must be Meta" from
// a generic "social" medium alone.
const META_SOURCE_KEYWORDS = /^(facebook|instagram|meta|fb|ig|paid_social)$/i;
const META_SOURCE_FRAGMENT = /(facebook\.com|instagram\.com|\bmeta\b|paid[_-]?social)/i;
// Looser regex used ONLY on the campaign field. Campaign values are
// user-authored (UTM utm_campaign) and often embed the platform name as a
// prefix/suffix ("facebook_promo", "spring_ig_2026"), so an unanchored
// substring match is safe when paired with a paid medium. Never used on
// source — a URL like "facebookads-tracker.com" would false-positive.
const META_CAMPAIGN_HINT = /(facebook|instagram|\bmeta\b|\bfb\b|\big\b)/i;
// "cpc" alone is Google Ads by default; we treat cpc as Meta only when
// combined with a meta-fragment source.
const PAID_MEDIUM = /(cpc|paid|paidsocial|paid[_-]?social)/i;

// Normalized comparison key. Same rule as the existing Google Ads join —
// case-insensitive, trimmed.
function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Classify a single GA4 row's likelihood of being Meta traffic.
// Returns { isMeta, kind: 'source_keyword' | 'source_fragment' | 'campaign_hint' | null }.
function classifyGa4RowForMeta(row) {
  const src = row.source || '';
  const med = row.medium || '';
  const camp = row.campaign || '';
  // Direct keyword source (facebook / instagram / meta / paid_social)
  if (META_SOURCE_KEYWORDS.test(src)) {
    return { isMeta: true, kind: 'source_keyword' };
  }
  // Source URL/domain fragment (m.facebook.com, l.instagram.com, etc.)
  if (META_SOURCE_FRAGMENT.test(src)) {
    return { isMeta: true, kind: 'source_fragment' };
  }
  // Campaign-name hint. Only trust when medium is paid — otherwise a random
  // organic post referencing "facebook" in the campaign field would be
  // claimed as Meta.
  if (META_CAMPAIGN_HINT.test(camp) && PAID_MEDIUM.test(med)) {
    return { isMeta: true, kind: 'campaign_hint' };
  }
  return { isMeta: false, kind: null };
}

// Extract campaign-name index from GA4 traffic-source rows that look
// like Meta traffic. Skips '(not set)' and empty names.
function metaGa4CampaignIndex(ga4TrafficSources) {
  const idx = new Map();
  for (const r of ga4TrafficSources || []) {
    const c = classifyGa4RowForMeta(r);
    if (!c.isMeta) continue;
    const camp = r.campaign || '';
    if (!camp || camp === '(not set)') continue;
    const key = norm(camp);
    // If multiple rows share the same campaign name, sum sessions/conversions.
    const prev = idx.get(key) || { campaign: camp, source: r.source, medium: r.medium, sessions: 0, users: 0, conversions: 0, revenue: 0 };
    idx.set(key, {
      campaign: prev.campaign,
      source: prev.source,
      medium: prev.medium,
      sessions: (prev.sessions || 0) + (Number(r.sessions) || 0),
      users: (prev.users || 0) + (Number(r.users) || 0),
      conversions: (prev.conversions || 0) + (Number(r.conversions) || 0),
      revenue: (prev.revenue || 0) + (Number(r.revenue) || 0),
    });
  }
  return idx;
}

// Sum all Meta-attributable GA4 traffic (any row that classifies as Meta,
// regardless of campaign name). Used for channel-level rollup when we
// can't join at campaign level.
function metaChannelRollup(ga4TrafficSources) {
  const out = { sessions: 0, users: 0, conversions: 0, revenue: 0, rowCount: 0, kinds: {} };
  for (const r of ga4TrafficSources || []) {
    const c = classifyGa4RowForMeta(r);
    if (!c.isMeta) continue;
    out.sessions += Number(r.sessions) || 0;
    out.users += Number(r.users) || 0;
    out.conversions += Number(r.conversions) || 0;
    out.revenue += Number(r.revenue) || 0;
    out.rowCount += 1;
    out.kinds[c.kind] = (out.kinds[c.kind] || 0) + 1;
  }
  return out;
}

// Attribution entry envelope — every emitted record has these fields so
// callers can filter by confidence without inventing rules per site.
function makeMatch({ matchLevel, confidence, matchReason, metaCampaign, ga4Campaign, meta, ga4 }) {
  return {
    matchLevel,
    confidence,
    matchReason,
    metaCampaign: metaCampaign || null,
    ga4Campaign: ga4Campaign || null,
    meta: meta || null,
    ga4: ga4 || null,
  };
}

// Main entry point.
//
// Inputs:
//   metaCampaignsWithSpend: [{ id, name, objective, spend, results, resultActionType, costPerResult, ...}]
//     — pre-filtered to campaigns that had spend in the window (0-spend
//        campaigns aren't attribution-worthy).
//   ga4TrafficSources: rows returned by analyticsService.getTrafficSources.
//
// Returns:
//   {
//     quality: 'campaign' | 'partial' | 'channel' | 'none',
//     matchedCampaigns: number,      // count of high-confidence campaign-level matches
//     totalMetaCampaigns: number,    // total campaigns with spend evaluated
//     byCampaign: [makeMatch(...)],  // may include high + medium confidence records
//     unmatchedMetaCampaigns: [...], // campaigns with spend but no GA4 join
//     unmatchedGa4Campaigns: [...],  // GA4 Meta campaigns with no Meta join
//     channelRollup: { sessions, users, conversions, revenue, rowCount, kinds },
//     notes: [string]                // human-readable classification notes
//   }
function analyzeMetaAttribution({ metaCampaignsWithSpend, ga4TrafficSources }) {
  const notes = [];
  const total = Array.isArray(metaCampaignsWithSpend) ? metaCampaignsWithSpend.length : 0;
  const channelRollup = metaChannelRollup(ga4TrafficSources);

  if (total === 0) {
    return {
      quality: 'none',
      matchedCampaigns: 0,
      totalMetaCampaigns: 0,
      byCampaign: [],
      unmatchedMetaCampaigns: [],
      unmatchedGa4Campaigns: [],
      channelRollup,
      notes: ['No Meta campaigns spent in the window; nothing to attribute.'],
    };
  }

  const ga4Index = metaGa4CampaignIndex(ga4TrafficSources);
  const byCampaign = [];
  const unmatchedMetaCampaigns = [];
  const usedGa4Keys = new Set();

  for (const c of metaCampaignsWithSpend) {
    const key = norm(c.name);
    if (ga4Index.has(key)) {
      // Exact case-insensitive name match with a Meta-tagged GA4 row.
      const g = ga4Index.get(key);
      usedGa4Keys.add(key);
      byCampaign.push(
        makeMatch({
          matchLevel: 'campaign',
          confidence: 'high',
          matchReason: 'exact campaign-name match on GA4 Meta-source row',
          metaCampaign: c.name,
          ga4Campaign: g.campaign,
          meta: {
            campaignId: c.id,
            objective: c.objective,
            spend: c.spend,
            results: c.results,
            resultActionType: c.resultActionType,
            costPerResult: c.costPerResult,
          },
          ga4: {
            source: g.source,
            medium: g.medium,
            sessions: g.sessions,
            users: g.users,
            conversions: g.conversions,
            revenue: g.revenue,
          },
        })
      );
    } else {
      unmatchedMetaCampaigns.push({
        campaignId: c.id,
        name: c.name,
        objective: c.objective,
        spend: c.spend,
        results: c.results,
      });
    }
  }

  const unmatchedGa4Campaigns = [];
  for (const [k, g] of ga4Index) {
    if (usedGa4Keys.has(k)) continue;
    unmatchedGa4Campaigns.push({
      campaign: g.campaign,
      source: g.source,
      medium: g.medium,
      sessions: g.sessions,
      conversions: g.conversions,
    });
  }

  const matched = byCampaign.length;
  const matchRatio = matched / total;
  let quality;
  if (matchRatio >= 0.75) {
    quality = 'campaign';
    notes.push(`${matched}/${total} Meta campaigns with spend match a GA4 campaign name (Meta-source rows).`);
  } else if (matchRatio >= 0.25) {
    quality = 'partial';
    notes.push(
      `${matched}/${total} Meta campaigns match GA4; the remaining ${total - matched} campaigns have no GA4 join and are left unmatched (never fuzzy-joined).`
    );
  } else if (channelRollup.sessions > 0 || channelRollup.rowCount > 0) {
    quality = 'channel';
    notes.push(
      `No reliable campaign-level attribution for this account: ${matched}/${total} match. Falling back to channel-level rollup — GA4 reports ${channelRollup.sessions} sessions and ${channelRollup.conversions} conversions attributable to Meta sources across ${channelRollup.rowCount} GA4 rows.`
    );
    if (unmatchedMetaCampaigns.length) {
      notes.push(
        'Meta campaign names do not appear in GA4 acquisition. This usually means the campaigns rely on link tags Meta does not propagate (e.g. Marketplace listing boosts) or UTMs are not set on the landing URLs.'
      );
    }
  } else {
    quality = 'none';
    notes.push(
      `No campaign-level match and no Meta-attributable GA4 traffic detected. Meta spent on ${total} campaign(s) but GA4 does not report any Facebook/Instagram/paid-social sessions in this window. Attribution is unavailable — treat Meta and GA4 as independent data sets.`
    );
  }

  return {
    quality,
    matchedCampaigns: matched,
    totalMetaCampaigns: total,
    byCampaign,
    unmatchedMetaCampaigns,
    unmatchedGa4Campaigns,
    channelRollup,
    notes,
  };
}

module.exports = {
  analyzeMetaAttribution,
  // Exposed for tests / callers who want to compute rollup without full analysis.
  _internal: {
    classifyGa4RowForMeta,
    metaGa4CampaignIndex,
    metaChannelRollup,
    norm,
    META_SOURCE_KEYWORDS,
    META_SOURCE_FRAGMENT,
    META_CAMPAIGN_HINT,
    PAID_MEDIUM,
  },
};
