// One-shot Google Ads + GA4 report generator.
//
// The goal isn't to build yet another dashboard: it's to hand ChatGPT a
// single JSON blob with enough of the account to reason about wasted spend,
// weak keywords, poor landing pages, conversion tracking gaps, etc. — no
// screenshots, no OCR, no follow-up API calls.
//
// This service is a thin orchestrator over the existing googleAdsService
// and analyticsService methods. It does NOT invent metrics; every number
// comes from Google's own APIs. The only "computed" additions are:
//   - `summary`  — account-level totals + derived rates (cost/click, CTR,
//                  conversion rate, CPA) that are trivial but tedious for
//                  ChatGPT to redo from raw rows.
//   - `alerts`   — surfacing specific rows that match well-known
//                  optimization patterns (high spend + zero conv, low QS,
//                  weak RSA, missing tracking).
//   - `crossReference.byCampaign` — Ads campaigns joined with GA4 sessions
//                  on (campaign, source='google', medium='cpc'). The
//                  frontend/ChatGPT can then see the funnel end to end.
//
// Every sub-call is wrapped in a safe() so one failure doesn't nuke the
// whole report — the section becomes null and lands in the errors array.

const ads = require('./googleAdsService');
const ga4 = require('./analyticsService');
const metaAds = require('./metaAdsService');
const metaDiagnostics = require('./metaAdsDiagnostics');
const { analyzeMetaAttribution } = require('./metaAttribution');
const logger = require('../utils/logger');

// Defaults for the alert thresholds. Callers can override via query.
const DEFAULTS = {
  searchTermSpendThreshold: 20,       // USD (or whatever currency the acct uses)
  keywordSpendThreshold: 20,
  landingPageSessionThreshold: 50,    // sessions needed to consider a landing page material
  lowQualityScoreCutoff: 4,           // QS ≤ 4
};

function sum(rows, key) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((acc, r) => acc + (Number(r?.[key]) || 0), 0);
}

function safeDiv(numerator, denominator) {
  if (!denominator) return 0;
  return numerator / denominator;
}

function computeSummary({ campaigns, days }) {
  const impressions = sum(campaigns, 'impressions');
  const clicks = sum(campaigns, 'clicks');
  const cost = sum(campaigns, 'cost');
  const conversions = sum(campaigns, 'conversions');
  const conversionValue = sum(campaigns, 'conversionValue');
  return {
    dateRangeDays: days,
    impressions,
    clicks,
    cost,
    conversions,
    conversionValue,
    ctr: safeDiv(clicks, impressions),
    avgCpc: safeDiv(cost, clicks),
    conversionRate: safeDiv(conversions, clicks),
    costPerConversion: safeDiv(cost, conversions),
    roas: safeDiv(conversionValue, cost),
  };
}

function computeAlerts({
  campaigns, searchTerms, keywords, adsList, conversions,
  devices, ga4LandingPages, ga4Events, thresholds,
}) {
  const t = { ...DEFAULTS, ...(thresholds || {}) };

  const highSpendNoConversions = Array.isArray(searchTerms)
    ? searchTerms
        .filter(r => (Number(r.cost) || 0) > t.searchTermSpendThreshold && (Number(r.conversions) || 0) === 0)
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 25)
        .map(r => ({
          searchTerm: r.searchTerm,
          cost: r.cost,
          clicks: r.clicks,
          matchedKeyword: r.matchedKeyword,
          matchType: r.matchType,
          campaign: r.campaign,
        }))
    : [];

  const lowQualityKeywords = Array.isArray(keywords)
    ? keywords
        .filter(k => k.qualityScore != null && k.qualityScore <= t.lowQualityScoreCutoff)
        .sort((a, b) => (b.cost || 0) - (a.cost || 0))
        .slice(0, 25)
        .map(k => ({
          keyword: k.keyword,
          matchType: k.matchType,
          qualityScore: k.qualityScore,
          expectedCtr: k.expectedCtr,
          adRelevance: k.creativeQualityScore,
          landingPageExperience: k.landingPageExperience,
          cost: k.cost,
          clicks: k.clicks,
          conversions: k.conversions,
          campaign: k.campaign,
        }))
    : [];

  const weakAds = Array.isArray(adsList)
    ? adsList
        .filter(a => ['POOR', 'AVERAGE'].includes(a.adStrength))
        .slice(0, 25)
        .map(a => ({
          campaign: a.campaign,
          adGroup: a.adGroup,
          adStrength: a.adStrength,
          headlineCount: (a.headlines || []).length,
          descriptionCount: (a.descriptions || []).length,
          finalUrls: a.finalUrls,
          impressions: a.impressions,
          clicks: a.clicks,
          conversions: a.conversions,
        }))
    : [];

  // Device summary — sum + CTR/CPA per device. Small enough to include as-is.
  const devicePerformance = Array.isArray(devices)
    ? devices.reduce((acc, d) => {
        acc[d.device || 'UNKNOWN'] = {
          impressions: d.impressions,
          clicks: d.clicks,
          ctr: d.ctr,
          cost: d.cost,
          avgCpc: d.avgCpc,
          conversions: d.conversions,
          cpa: d.cpa,
          conversionRate: d.conversionRate,
        };
        return acc;
      }, {})
    : {};

  const landingPagesWithoutConversions = Array.isArray(ga4LandingPages)
    ? ga4LandingPages
        .filter(lp => (Number(lp.sessions) || 0) >= t.landingPageSessionThreshold && (Number(lp.conversions) || 0) === 0)
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, 25)
        .map(lp => ({
          landingPage: lp.landingPage,
          sessions: lp.sessions,
          engagementRate: lp.engagementRate,
          averageEngagementTime: lp.averageEngagementTime,
        }))
    : [];

  // Conversion-tracking sanity check. Two failure modes:
  //   - no conversion actions at all       → Smart Bidding can't optimize.
  //   - no primary conversion action       → Smart Bidding still can't.
  //   - primary present, but zero recorded → tag may be broken.
  const missingConversionTracking = [];
  if (Array.isArray(conversions)) {
    if (conversions.length === 0) {
      missingConversionTracking.push({
        code: 'no_conversion_actions',
        detail: 'No conversion actions are configured on this Google Ads account. Smart Bidding has nothing to optimize toward.',
      });
    } else {
      const primaries = conversions.filter(c => c.primary && c.status === 'ENABLED');
      if (primaries.length === 0) {
        missingConversionTracking.push({
          code: 'no_primary_conversion',
          detail: 'No conversion action is marked "primary". Smart Bidding needs at least one primary action to bid against.',
        });
      }
      const zeroRecorded = conversions.filter(c => c.primary && c.status === 'ENABLED' && (Number(c.conversions) || 0) === 0);
      if (zeroRecorded.length > 0) {
        missingConversionTracking.push({
          code: 'primary_action_zero_conversions',
          detail: 'One or more primary conversion actions have zero recorded conversions in the selected window. Check tag firing.',
          actions: zeroRecorded.map(c => ({ name: c.name, type: c.type })),
        });
      }
    }
  }

  return {
    highSpendNoConversions,
    lowQualityKeywords,
    weakAds,
    devicePerformance,
    landingPagesWithoutConversions,
    missingConversionTracking,
    thresholdsUsed: t,
  };
}

// Ads↔GA4 join by (campaign, source='google', medium='cpc'). GA4 rows come
// from sessionCampaignName/sessionSource/sessionMedium — that matches how
// utm_* tags land on Google Ads clicks. Rows are matched on exact campaign
// name (case-insensitive) — anything else is left in `unmatched` so ChatGPT
// can see gaps in tagging.
function computeCrossReference({ adsCampaigns, ga4Campaigns }) {
  if (!Array.isArray(adsCampaigns) || !Array.isArray(ga4Campaigns)) {
    return { byCampaign: [], unmatchedAdsCampaigns: [], unmatchedGa4Campaigns: [] };
  }

  const norm = s => (s || '').toString().trim().toLowerCase();
  const ga4ByName = new Map();
  ga4Campaigns
    .filter(g => norm(g.source) === 'google' && norm(g.medium) === 'cpc')
    .forEach(g => {
      ga4ByName.set(norm(g.campaign), g);
    });

  const matched = [];
  const usedGa4 = new Set();
  adsCampaigns.forEach(a => {
    const key = norm(a.name || a.campaign);
    const g = ga4ByName.get(key);
    if (g) {
      usedGa4.add(key);
      matched.push({
        campaign: a.name || a.campaign,
        ads: {
          impressions: a.impressions,
          clicks: a.clicks,
          cost: a.cost,
          ctr: a.ctr,
          avgCpc: a.avgCpc,
          conversions: a.conversions,
          conversionValue: a.conversionValue,
          costPerConversion: a.costPerConversion,
        },
        ga4: {
          sessions: g.sessions,
          users: g.users,
          conversions: g.conversions,
          revenue: g.revenue,
          // Session-to-conversion rate seen in GA4 (may differ from Ads
          // conversions because attribution + event-count settings differ).
          conversionRate: safeDiv(g.conversions, g.sessions),
        },
        // The "hidden" number: what fraction of clicks became sessions in
        // GA4. Big drop-off here usually means broken auto-tagging or
        // filter rules dropping the traffic.
        clickToSessionRate: safeDiv(g.sessions, a.clicks),
      });
    }
  });

  const unmatchedAdsCampaigns = adsCampaigns
    .filter(a => !ga4ByName.has(norm(a.name || a.campaign)))
    .map(a => ({ campaign: a.name || a.campaign, clicks: a.clicks, cost: a.cost }));

  const unmatchedGa4Campaigns = Array.from(ga4ByName.entries())
    .filter(([key]) => !usedGa4.has(key))
    .map(([, g]) => ({
      campaign: g.campaign,
      source: g.source,
      medium: g.medium,
      sessions: g.sessions,
      conversions: g.conversions,
    }));

  return { byCampaign: matched, unmatchedAdsCampaigns, unmatchedGa4Campaigns };
}

// Normalize a Meta campaigns + campaign-level insights bundle into the
// shape the report exposes. Runs after fetching so the join code, the
// attribution engine and the channel summary all read from the same
// deterministic layout.
function shapeMetaCampaigns({ campaigns, insightsCampaign }) {
  if (!Array.isArray(campaigns)) return [];
  const insByCampaignId = new Map(
    (insightsCampaign?.rows || []).map((r) => [r.campaignId, r])
  );
  return campaigns.map((c) => {
    const ins = insByCampaignId.get(c.id) || null;
    const pick = ins ? metaAds.pickResultForObjective(c.objective, ins) : { results: null, costPerResult: null, resultActionType: null };
    return {
      campaignId: c.id,
      name: c.name || null,
      objective: c.objective || null,
      status: c.effectiveStatus || null,
      spend: ins?.spend || 0,
      impressions: ins?.impressions || 0,
      clicks: ins?.clicks || 0,
      ctr: ins?.ctr ?? null,
      cpc: ins?.cpc ?? null,
      cpm: ins?.cpm ?? null,
      reach: ins?.reach ?? null,
      frequency: ins?.frequency ?? null,
      results: pick.results,
      resultActionType: pick.resultActionType,
      costPerResult: pick.costPerResult,
    };
  });
}

// Meta totals + resultsByObjective from the shaped campaign list. Never
// sums results across incompatible action types.
function computeMetaSummary(shapedCampaigns) {
  const t = { spend: 0, impressions: 0, reach: 0, clicks: 0 };
  let weightedFreqNumerator = 0;
  const buckets = new Map();
  for (const c of shapedCampaigns) {
    t.spend += c.spend || 0;
    t.impressions += c.impressions || 0;
    t.reach += c.reach || 0;
    t.clicks += c.clicks || 0;
    if (c.frequency && c.impressions) weightedFreqNumerator += c.frequency * c.impressions;
    if (c.resultActionType && c.results !== null && c.results !== undefined) {
      const key = `${c.objective}::${c.resultActionType}`;
      const b = buckets.get(key) || {
        objective: c.objective,
        actionType: c.resultActionType,
        results: 0,
        spend: 0,
      };
      b.results += c.results;
      b.spend += c.spend || 0;
      buckets.set(key, b);
    }
  }
  const totals = {
    spend: t.spend,
    impressions: t.impressions,
    reach: t.reach,
    clicks: t.clicks,
    frequency: t.impressions > 0 ? weightedFreqNumerator / t.impressions : null,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
    cpc: t.clicks > 0 ? t.spend / t.clicks : null,
    cpm: t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null,
  };
  const resultsByObjective = Array.from(buckets.values()).map((b) => ({
    ...b,
    costPerResult: b.results > 0 ? b.spend / b.results : null,
  }));
  return { totals, resultsByObjective };
}

// Compact placement roll-up. Preserves the raw structure the /placements
// route already returns but cuts it to the top N by spend to keep the
// report payload bounded — the OpenAI ingestion doesn't need every hour
// of every placement.
function shapeMetaPlacements(placementsBundle, limit = 15) {
  const rows = (placementsBundle?.rows || [])
    .filter((r) => (r.spend || 0) > 0)
    .sort((a, b) => (b.spend || 0) - (a.spend || 0))
    .slice(0, limit);
  return rows.map((r) => ({
    publisherPlatform: r.breakdowns?.publisher_platform || null,
    platformPosition: r.breakdowns?.platform_position || null,
    spend: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    cpm: r.cpm,
  }));
}

// Compact delivery-issue roll-up. One entry per unique error_code, with a
// count and one representative example. Full detail lives on the Meta
// dashboard; this is a summary for the report.
function shapeMetaDeliveryIssuesSummary(issues) {
  if (!Array.isArray(issues)) return [];
  const grouped = new Map();
  for (const iss of issues) {
    const key = `${iss.entityType}:${iss.issue?.error_code || iss.issue?.error_summary || 'unknown'}`;
    const g = grouped.get(key) || {
      entityType: iss.entityType,
      errorCode: iss.issue?.error_code || null,
      errorType: iss.issue?.error_type || null,
      errorSummary: iss.issue?.error_summary || null,
      errorMessage: iss.issue?.error_message || null,
      count: 0,
      sampleEntityIds: [],
    };
    g.count += 1;
    if (g.sampleEntityIds.length < 3) g.sampleEntityIds.push(iss.entityId);
    grouped.set(key, g);
  }
  return Array.from(grouped.values());
}

async function generateReport({
  adsAccessToken,
  customerId,
  loginCustomerId,
  campaignId,
  ga4AccessToken,
  propertyId,
  firebasePropertyId,          // optional: GA4 property receiving Firebase app events
  firebaseAccessToken,         // optional: token that can read firebasePropertyId (falls back to ga4AccessToken)
  openAiAdsHistory,            // optional: pre-fetched OpenAI Ads context blob (campaigns/insights/ads)
  metaAccessToken,             // optional: long-lived Meta user token (Phase 1D)
  metaAdAccountId,             // optional: act_<numeric> selected by the user
  days,
  thresholds,
  userId,   // for logging
}) {
  const opts = { loginCustomerId, campaignId };
  const errors = [];
  const t0 = Date.now();

  const safe = (section, fn) => fn().catch(err => {
    errors.push({
      section,
      status: err?.response?.status || null,
      message: err?.message || 'unknown',
      apiMessage: err?.response?.data?.error?.message || null,
    });
    logger.warn('optimizationReport.section_failed', {
      userId,
      customerId,
      section,
      status: err?.response?.status || null,
      apiMessage: err?.response?.data?.error?.message || err?.message || null,
    });
    return null;
  });

  // Google Ads wrap: skip cleanly when customerId is null so the Meta-only
  // path doesn't burn Google API calls (which would 400 anyway without a CID).
  // Prior to Phase 1D the route rejected requests without customerId at
  // the boundary, so this wrap always fired; now it's conditional.
  const adsWrap = (section, fn) => customerId ? safe(section, fn) : Promise.resolve(null);
  const ga4Wrap = (section, fn) => propertyId ? safe(section, fn) : Promise.resolve(null);
  const fbWrap = (section, fn) => firebasePropertyId ? safe(section, fn) : Promise.resolve(null);
  const fbToken = firebaseAccessToken || ga4AccessToken;
  // Meta wrap: only fires if both a Meta access token AND an ad account id
  // are supplied. A missing token or missing account id is not an error —
  // Meta is optional. Meta API errors are logged into the same `errors[]`
  // array so the frontend/AI ingestion can see per-provider availability.
  const metaWrap = (section, fn) =>
    metaAccessToken && metaAdAccountId ? safe(section, fn) : Promise.resolve(null);

  const [
    campaigns, adGroups, keywords, searchTerms, adsList, assets,
    recommendations, conversions, devices, locations, hourDay,
    audience, auctionInsights, quality, changeHistory, diagnostics,
    ga4Overview, ga4LandingPages, ga4TrafficSources, ga4EventsRes,
    ga4Campaigns, ga4Geography, ga4Devices,
    fbOverview, fbEvents, fbCampaigns, fbDevices, fbGeography,
    // Meta (Phase 1D). Six parallel fetches per report — same wave as
    // the Google/GA4 calls so we don't add latency.
    metaAccount, metaCampaigns, metaAdSets, metaAdsEntities,
    metaInsCampaign, metaInsAdSet, metaInsAd, metaDeliveryIssues,
    metaPlacements,
  ] = await Promise.all([
    adsWrap('campaigns',        () => ads.getCampaigns(adsAccessToken, customerId, days, opts)),
    adsWrap('adGroups',         () => ads.getAdGroups(adsAccessToken, customerId, days, opts)),
    adsWrap('keywords',         () => ads.getKeywords(adsAccessToken, customerId, days, opts)),
    adsWrap('searchTerms',      () => ads.getSearchTerms(adsAccessToken, customerId, days, opts)),
    adsWrap('ads',              () => ads.getAds(adsAccessToken, customerId, days, opts)),
    adsWrap('assets',           () => ads.getAssets(adsAccessToken, customerId, days, opts)),
    adsWrap('recommendations',  () => ads.getRecommendations(adsAccessToken, customerId, opts)),
    adsWrap('conversions',      () => ads.getConversions(adsAccessToken, customerId, days, opts)),
    adsWrap('devices',          () => ads.getDevices(adsAccessToken, customerId, days, opts)),
    adsWrap('locations',        () => ads.getLocations(adsAccessToken, customerId, days, opts)),
    adsWrap('hourDay',          () => ads.getDayHour(adsAccessToken, customerId, days, opts)),
    adsWrap('audience',         () => ads.getAudience(adsAccessToken, customerId, days, opts)),
    adsWrap('auctionInsights',  () => ads.getAuctionInsights(adsAccessToken, customerId, days, opts)),
    adsWrap('quality',          () => ads.getQuality(adsAccessToken, customerId, days, opts)),
    adsWrap('changeHistory',    () => ads.getChangeHistory(adsAccessToken, customerId, days, opts)),
    adsWrap('diagnostics',      () => ads.getDiagnostics(adsAccessToken, customerId, days, opts)),
    ga4Wrap('ga4.overview',        () => ga4.getOverview(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.landingPages',    () => ga4.getLandingPages(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.trafficSources',  () => ga4.getTrafficSources(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.events',          () => ga4.getEvents(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.campaigns',       () => ga4.getCampaigns(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.geography',       () => ga4.getGeography(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.devices',         () => ga4.getDevices(ga4AccessToken, propertyId, days)),
    // Firebase-linked app-stream GA4 property. Runs the same GA4 API endpoints
    // (Firebase Analytics IS GA4 for apps) — we just point at a different
    // property id. Skip if not supplied.
    fbWrap('firebase.overview',    () => ga4.getOverview(fbToken, firebasePropertyId, days)),
    fbWrap('firebase.events',      () => ga4.getEvents(fbToken, firebasePropertyId, days)),
    fbWrap('firebase.campaigns',   () => ga4.getCampaigns(fbToken, firebasePropertyId, days)),
    fbWrap('firebase.devices',     () => ga4.getDevices(fbToken, firebasePropertyId, days)),
    fbWrap('firebase.geography',   () => ga4.getGeography(fbToken, firebasePropertyId, days)),
    // Meta section (Phase 1D). Each fetch is independently wrapped so a
    // single Meta failure (e.g. rate limit on placements) leaves the rest
    // of the Meta report usable.
    metaWrap('meta.account',           () => metaAds.describeAdAccount({ accessToken: metaAccessToken, adAccountId: metaAdAccountId })),
    metaWrap('meta.campaigns',         () => metaAds.getCampaigns({ accessToken: metaAccessToken, adAccountId: metaAdAccountId, days })),
    metaWrap('meta.adsets',            () => metaAds.getAdSets({ accessToken: metaAccessToken, adAccountId: metaAdAccountId, days })),
    metaWrap('meta.ads',               () => metaAds.getAds({ accessToken: metaAccessToken, adAccountId: metaAdAccountId, days })),
    metaWrap('meta.insights.campaign', () => metaAds.getInsights({ accessToken: metaAccessToken, node: metaAdAccountId, level: 'campaign', days })),
    metaWrap('meta.insights.adset',    () => metaAds.getInsights({ accessToken: metaAccessToken, node: metaAdAccountId, level: 'adset', days })),
    metaWrap('meta.insights.ad',       () => metaAds.getInsights({ accessToken: metaAccessToken, node: metaAdAccountId, level: 'ad', days })),
    metaWrap('meta.deliveryIssues',    () => metaAds.getDeliveryIssues({ accessToken: metaAccessToken, adAccountId: metaAdAccountId })),
    metaWrap('meta.placements',        () => metaAds.getInsights({ accessToken: metaAccessToken, node: metaAdAccountId, level: 'ad', days, breakdowns: ['publisher_platform', 'platform_position'] })),
  ]);

  const summary = computeSummary({ campaigns, days });
  const alerts = computeAlerts({
    campaigns, searchTerms, keywords, adsList, conversions, devices,
    ga4LandingPages, ga4Events: ga4EventsRes, thresholds,
  });
  const crossReference = computeCrossReference({
    adsCampaigns: campaigns,
    ga4Campaigns,
  });

  // ---------- Meta section assembly (Phase 1D) ----------
  //
  // Everything below is derived from the fetched-and-safe()-ed variables
  // above. If Meta wasn't requested, `metaAdSection` stays null. If Meta
  // was requested but a specific sub-fetch failed, its slot in `metaAdSection`
  // stays null and the failure lives in `errors[]`.
  let metaAdSection = null;
  let metaByCampaign = [];
  let metaAttribution = {
    quality: metaAdAccountId ? 'none' : 'not_requested',
    matchedCampaigns: 0,
    totalMetaCampaigns: 0,
    notes: metaAdAccountId ? [] : ['Meta ad account not supplied — attribution join skipped.'],
  };
  const metaProviderAlerts = [];

  if (metaAdAccountId && metaAccessToken) {
    // Shape Meta campaigns even when campaign-level insights failed —
    // `shapeMetaCampaigns` tolerates a null insights bundle. Downstream
    // aggregation lands zeros for those fields.
    const shapedMetaCampaigns = shapeMetaCampaigns({
      campaigns: metaCampaigns,
      insightsCampaign: metaInsCampaign,
    });
    const metaSummary = computeMetaSummary(shapedMetaCampaigns);
    const shapedPlacements = shapeMetaPlacements(metaPlacements);
    const deliveryIssuesSummary = shapeMetaDeliveryIssuesSummary(metaDeliveryIssues);

    // Run the same diagnostics engine the /diagnostics route uses.
    // Provider-tagged so the flattened alertsByProvider array below can
    // include Meta issues without collision.
    let diagIssues = [];
    try {
      diagIssues = metaDiagnostics.runDiagnostics({
        campaigns: metaCampaigns || [],
        adsets: metaAdSets || [],
        ads: metaAdsEntities || [],
        insightsBundleCampaign: metaInsCampaign || { rows: [] },
        insightsBundleAdSet: metaInsAdSet || { rows: [] },
        insightsBundleAd: metaInsAd || { rows: [] },
        days,
      });
    } catch (err) {
      // Diagnostics is pure; a throw here means malformed inputs. Never
      // let it break the whole report.
      errors.push({ section: 'meta.diagnostics', message: err.message });
      logger.warn('optimizationReport.meta.diagnostics_failed', { userId, error: err.message });
    }

    // Wrap each diagnostic issue with an explicit provider tag so the
    // Phase 1E Campaign Assistant can filter/dispatch by provider.
    for (const iss of diagIssues) {
      metaProviderAlerts.push({
        provider: 'meta_ads',
        id: `meta:${iss.id}`,
        severity: iss.severity,
        type: iss.type,
        title: iss.title,
        guidance: iss.guidance,
        entityType: iss.entityType,
        entityIds: iss.entityIds,
        metrics: iss.metrics,
        source: iss.source,
      });
    }

    // Attribution engine — only campaigns with actual spend enter the
    // classifier, so a paused-since-forever campaign doesn't drag the
    // classification into "no match".
    const campaignsWithSpend = shapedMetaCampaigns.filter((c) => (c.spend || 0) > 0);
    const attribution = analyzeMetaAttribution({
      metaCampaignsWithSpend: campaignsWithSpend,
      ga4TrafficSources: ga4TrafficSources || [],
    });
    metaAttribution = {
      quality: attribution.quality,
      matchedCampaigns: attribution.matchedCampaigns,
      totalMetaCampaigns: attribution.totalMetaCampaigns,
      unmatchedMetaCampaigns: attribution.unmatchedMetaCampaigns,
      unmatchedGa4Campaigns: attribution.unmatchedGa4Campaigns,
      channelRollup: attribution.channelRollup,
      notes: attribution.notes,
    };
    metaByCampaign = attribution.byCampaign;

    // Trim the account descriptor to safe / analytically useful fields.
    // Never expose account_status codes without context; never expose
    // amount_spent lifetime (irrelevant for this window and can be
    // surprising in a diagnostic report).
    const safeAccount = metaAccount
      ? {
          adAccountId: metaAccount.id,
          name: metaAccount.name,
          currency: metaAccount.currency,
          timezoneName: metaAccount.timezoneName,
        }
      : { adAccountId: metaAdAccountId };

    metaAdSection = {
      account: safeAccount,
      dateRangeDays: days,
      totals: metaSummary.totals,
      resultsByObjective: metaSummary.resultsByObjective,
      campaigns: shapedMetaCampaigns,
      diagnostics: diagIssues,
      deliveryIssuesSummary,
      placements: shapedPlacements,
      // Counts to help the ingestion side reason about coverage without
      // having to walk arrays.
      counts: {
        totalCampaigns: (metaCampaigns || []).length,
        campaignsWithSpend: campaignsWithSpend.length,
        adSets: (metaAdSets || []).length,
        ads: (metaAdsEntities || []).length,
        issues: (metaDeliveryIssues || []).length,
      },
    };
  }

  // ---------- Cross-channel channel summary ----------
  //
  // Never pretends Google conversions, Meta results, and GA4 key events
  // are interchangeable. Each provider block includes its own
  // `conversionDefinition` so the AI ingestion can reason semantically.
  const channels = {};
  if (customerId) {
    channels.google_ads = {
      spend: summary.cost,
      impressions: summary.impressions,
      clicks: summary.clicks,
      conversions: summary.conversions,
      conversionValue: summary.conversionValue,
      costPerConversion: summary.costPerConversion,
      conversionDefinition:
        'Google Ads configured conversion actions (see conversions[] for setup). Counts include all conversion action categories unless the account explicitly excludes them.',
    };
  }
  if (metaAdSection) {
    channels.meta_ads = {
      spend: metaAdSection.totals.spend,
      impressions: metaAdSection.totals.impressions,
      clicks: metaAdSection.totals.clicks,
      results: metaAdSection.resultsByObjective.map((b) => ({
        objective: b.objective,
        type: b.actionType,
        value: b.results,
        costPerResult: b.costPerResult,
      })),
      conversionDefinition:
        'Meta action types mapped from each campaign objective (see resultsByObjective). Different objectives report different action types; never sum across incompatible types.',
    };
  }
  if (propertyId && ga4Overview) {
    channels.ga4 = {
      sessions: ga4Overview.sessions,
      users: ga4Overview.users,
      conversions: ga4Overview.conversions,
      totalRevenue: ga4Overview.totalRevenue,
      pageViews: ga4Overview.pageViews,
      conversionDefinition:
        'GA4 key-event count across all events flagged as conversions on the property. This is neither the Google Ads nor Meta definition of "conversion"; treat as an independent measurement.',
    };
  }
  summary.channels = channels;

  // ---------- Flatten provider-tagged alerts ----------
  //
  // Original `alerts` OBJECT is preserved for backward compat (existing
  // consumers key off searchTerms/keywords/etc). We ADD a new top-level
  // array `alertsByProvider` that flattens Meta + Google Ads alerts with
  // an explicit provider tag. This is what the Phase 1E Campaign Assistant
  // will iterate over.
  const alertsByProvider = [];
  if (customerId) {
    for (const t of alerts.highSpendNoConversions || []) {
      alertsByProvider.push({ provider: 'google_ads', type: 'high_spend_no_conversions', ...t });
    }
    for (const t of alerts.lowQualityKeywords || []) {
      alertsByProvider.push({ provider: 'google_ads', type: 'low_quality_keyword', ...t });
    }
    for (const t of alerts.weakAds || []) {
      alertsByProvider.push({ provider: 'google_ads', type: 'weak_ad', ...t });
    }
    for (const t of alerts.landingPagesWithoutConversions || []) {
      alertsByProvider.push({ provider: 'google_ads', type: 'landing_page_no_conversions', ...t });
    }
    for (const t of alerts.missingConversionTracking || []) {
      alertsByProvider.push({ provider: 'google_ads', type: 'conversion_tracking', ...t });
    }
  }
  for (const meta of metaProviderAlerts) alertsByProvider.push(meta);

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      dateRangeDays: days,
      campaignFilter: campaignId || null,
      ga4PropertyId: propertyId || null,
      firebasePropertyId: firebasePropertyId || null,
      durationMs: Date.now() - t0,
    },
    summary,
    alerts,
    diagnostics,
    campaigns,
    adGroups,
    keywords,
    searchTerms,
    ads: adsList,
    assets,
    recommendations,
    conversions,
    devices,
    locations,
    hourDay,
    audience,
    auctionInsights,
    quality,
    changeHistory,
    ga4: propertyId ? {
      propertyId,
      overview: ga4Overview,
      landingPages: ga4LandingPages,
      trafficSources: ga4TrafficSources,
      events: ga4EventsRes,
      campaigns: ga4Campaigns,
      geography: ga4Geography,
      devices: ga4Devices,
    } : null,
    firebase: firebasePropertyId ? {
      propertyId: firebasePropertyId,
      overview: fbOverview,
      events: fbEvents,
      campaigns: fbCampaigns,
      devices: fbDevices,
      geography: fbGeography,
    } : null,
    openAiAds: openAiAdsHistory || null,
    // Meta section — Phase 1D. Named `metaAds` (not `meta`, which is
    // this report's metadata field) so backward-compatible consumers of
    // `report.meta` keep working.
    metaAds: metaAdSection,
    crossReference: {
      ...crossReference,
      // `googleByCampaign` is an explicit alias for the existing
      // `byCampaign` to help Phase 1E code disambiguate by provider.
      googleByCampaign: crossReference.byCampaign,
      metaByCampaign,
      metaAttribution,
    },
    alertsByProvider,
  };
  if (errors.length) report.errors = errors;
  return report;
}

module.exports = {
  generateReport,
  // exposed for tests
  _internal: {
    computeSummary,
    computeAlerts,
    computeCrossReference,
    shapeMetaCampaigns,
    computeMetaSummary,
    shapeMetaPlacements,
    shapeMetaDeliveryIssuesSummary,
    DEFAULTS,
  },
};
