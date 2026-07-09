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

async function generateReport({
  adsAccessToken,
  customerId,
  loginCustomerId,
  campaignId,
  ga4AccessToken,
  propertyId,
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

  const ga4Wrap = (section, fn) => propertyId ? safe(section, fn) : Promise.resolve(null);

  const [
    campaigns, adGroups, keywords, searchTerms, adsList, assets,
    recommendations, conversions, devices, locations, dayHour,
    audience, auctionInsights, quality, changeHistory, diagnostics,
    ga4Overview, ga4LandingPages, ga4TrafficSources, ga4EventsRes,
    ga4Campaigns, ga4Geography, ga4Devices,
  ] = await Promise.all([
    safe('campaigns',        () => ads.getCampaigns(adsAccessToken, customerId, days, opts)),
    safe('adGroups',         () => ads.getAdGroups(adsAccessToken, customerId, days, opts)),
    safe('keywords',         () => ads.getKeywords(adsAccessToken, customerId, days, opts)),
    safe('searchTerms',      () => ads.getSearchTerms(adsAccessToken, customerId, days, opts)),
    safe('ads',              () => ads.getAds(adsAccessToken, customerId, days, opts)),
    safe('assets',           () => ads.getAssets(adsAccessToken, customerId, days, opts)),
    safe('recommendations',  () => ads.getRecommendations(adsAccessToken, customerId, opts)),
    safe('conversions',      () => ads.getConversions(adsAccessToken, customerId, days, opts)),
    safe('devices',          () => ads.getDevices(adsAccessToken, customerId, days, opts)),
    safe('locations',        () => ads.getLocations(adsAccessToken, customerId, days, opts)),
    safe('hourDay',          () => ads.getDayHour(adsAccessToken, customerId, days, opts)),
    safe('audience',         () => ads.getAudience(adsAccessToken, customerId, days, opts)),
    safe('auctionInsights',  () => ads.getAuctionInsights(adsAccessToken, customerId, days, opts)),
    safe('quality',          () => ads.getQuality(adsAccessToken, customerId, days, opts)),
    safe('changeHistory',    () => ads.getChangeHistory(adsAccessToken, customerId, days, opts)),
    safe('diagnostics',      () => ads.getDiagnostics(adsAccessToken, customerId, days, opts)),
    ga4Wrap('ga4.overview',        () => ga4.getOverview(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.landingPages',    () => ga4.getLandingPages(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.trafficSources',  () => ga4.getTrafficSources(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.events',          () => ga4.getEvents(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.campaigns',       () => ga4.getCampaigns(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.geography',       () => ga4.getGeography(ga4AccessToken, propertyId, days)),
    ga4Wrap('ga4.devices',         () => ga4.getDevices(ga4AccessToken, propertyId, days)),
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

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      dateRangeDays: days,
      campaignFilter: campaignId || null,
      ga4PropertyId: propertyId || null,
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
    crossReference,
  };
  if (errors.length) report.errors = errors;
  return report;
}

module.exports = {
  generateReport,
  // exposed for tests
  _internal: { computeSummary, computeAlerts, computeCrossReference, DEFAULTS },
};
