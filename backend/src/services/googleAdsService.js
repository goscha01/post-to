// Google Ads read-only diagnostics service.
//
// Purpose: NOT an ads management tool. Every method here is a SELECT against
// GAQL (Google Ads Query Language) — no mutate, no create, no bid/budget
// changes. The point is to hand ChatGPT enough data to act like a senior
// Google Ads consultant: "look at these keywords, this landing page
// experience, this search-term breakdown — here's what to change in the UI."
//
// Transport: direct REST v18 via axios. We deliberately avoid the
// google-ads-api npm package to match the "no new dep" pattern used by
// aiContentService.js (OpenAI direct axios). REST is officially supported
// and has been GA since v12.
//
// Auth model: reuses the OAuth refresh token stored on users.business_profiles
// (same Google account that granted GMB + GA4; adwords scope was added to
// BUSINESS_SCOPES so a single consent covers all three). Callers pass a live
// access token — the businessTokens helper handles refresh.
//
// Developer token: separate from OAuth. Google Ads REST rejects every call
// without a valid `developer-token` header even with a good access token. Set
// GOOGLE_ADS_DEVELOPER_TOKEN in the environment. Basic access (15k ops/day)
// is plenty for read-only diagnostics.
//
// Manager (MCC) accounts: when a customer is under a manager, calls need a
// `login-customer-id` header set to the manager's CID. We surface this on
// listAccessibleCustomers by walking customer_client_link → we save the
// manager id into connected_accounts.metadata.manager_customer_id so later
// report calls can send it automatically.
//
// All customer IDs are 10 digits, no dashes, always sent as strings. Never
// stringify with commas or dashes anywhere in this file.

const axios = require('axios');
const logger = require('../utils/logger');

// v21 as of 2026-07 — v20 was deprecated (returns UNSUPPORTED_VERSION).
// Whenever a version returns UNSUPPORTED_VERSION, bump this and update the
// Railway env var. Also probe via curl to verify: 401 = alive, 404 = sunset.
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v21';
const BASE_URL = `https://googleads.googleapis.com/${API_VERSION}`;

function developerToken() {
  const t = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!t) {
    const err = new Error('GOOGLE_ADS_DEVELOPER_TOKEN not configured');
    err.status = 503;
    err.code = 'DEVELOPER_TOKEN_MISSING';
    throw err;
  }
  return t;
}

function stripCid(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

function headers(accessToken, loginCustomerId) {
  const h = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken(),
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) h['login-customer-id'] = stripCid(loginCustomerId);
  return h;
}

// ---------- Customer discovery ----------

// GET /vNN/customers:listAccessibleCustomers → returns every CID this OAuth
// token can see (both direct accounts and accounts under any manager the user
// touches). Response is resource names like "customers/1234567890".
async function listAccessibleCustomers(accessToken, { ownerEmail = null } = {}) {
  const url = `${BASE_URL}/customers:listAccessibleCustomers`;
  const { data } = await axios.get(url, { headers: headers(accessToken), timeout: 15000 });
  const resourceNames = data.resourceNames || [];
  const cids = resourceNames.map(rn => stripCid(rn));
  logger.info('googleAds.listAccessibleCustomers.raw', {
    ownerEmail,
    apiVersion: API_VERSION,
    resourceNamesCount: resourceNames.length,
    cids,
    rawKeys: Object.keys(data || {}),
    rawSample: (() => {
      try { return JSON.stringify(data).slice(0, 500); } catch { return String(data).slice(0, 500); }
    })(),
  });
  return cids;
}

// Enrich each accessible customer with name/currency/timezone/manager status
// via a customer-level GAQL. Runs one query per CID — the alternative
// (a single query against a manager) requires knowing the manager up front.
// Skips CIDs that error (cancelled accounts, no permission, etc.).
async function describeCustomers(accessToken, customerIds, { ownerEmail = null } = {}) {
  const out = [];
  const errors = [];
  await Promise.all(customerIds.map(async (cid) => {
    try {
      const rows = await search(accessToken, cid, `
        SELECT
          customer.id,
          customer.descriptive_name,
          customer.currency_code,
          customer.time_zone,
          customer.manager,
          customer.test_account,
          customer.auto_tagging_enabled,
          customer.status
        FROM customer
        LIMIT 1
      `, { loginCustomerId: cid });
      const c = rows[0]?.customer;
      if (c) {
        out.push({
          customerId: String(c.id),
          descriptiveName: c.descriptiveName || `Customer ${c.id}`,
          currencyCode: c.currencyCode || null,
          timeZone: c.timeZone || null,
          manager: !!c.manager,
          testAccount: !!c.testAccount,
          autoTaggingEnabled: !!c.autoTaggingEnabled,
          status: c.status || null,
        });
        logger.info('googleAds.describeCustomers.hit', {
          ownerEmail,
          cid: String(c.id),
          descriptiveName: c.descriptiveName || null,
          manager: !!c.manager,
          status: c.status || null,
        });
      } else {
        logger.warn('googleAds.describeCustomers.no_customer_row', { ownerEmail, cid });
      }
    } catch (err) {
      const detail = err?.response?.data?.error?.details?.[0]?.errors?.[0];
      errors.push({ customerId: cid, status: err?.response?.status || null, message: err?.message });
      logger.warn('googleAds.describeCustomers.error', {
        ownerEmail,
        cid,
        status: err?.response?.status || null,
        apiMessage: err?.response?.data?.error?.message || null,
        errorCode: detail?.errorCode ? JSON.stringify(detail.errorCode) : null,
        errorMessage: detail?.message || null,
      });
    }
  }));
  return { customers: out, errors };
}

// For each manager CID discovered via listAccessibleCustomers, enumerate the
// customer_client tree beneath it. Returns the flat CID list (children plus
// grandchildren, deduped, non-managers). Uses the manager itself as
// login-customer-id, per Google Ads MCC access rules.
async function enumerateManagerChildren(accessToken, managerCid, { ownerEmail = null } = {}) {
  try {
    const rows = await search(accessToken, managerCid, `
      SELECT
        customer_client.client_customer,
        customer_client.id,
        customer_client.descriptive_name,
        customer_client.currency_code,
        customer_client.time_zone,
        customer_client.manager,
        customer_client.status,
        customer_client.level
      FROM customer_client
    `, { loginCustomerId: managerCid });
    const children = rows
      .map(r => r.customerClient)
      .filter(Boolean)
      .map(cc => ({
        cid: String(cc.id),
        descriptiveName: cc.descriptiveName || `Customer ${cc.id}`,
        currencyCode: cc.currencyCode || null,
        timeZone: cc.timeZone || null,
        manager: !!cc.manager,
        status: cc.status || null,
        level: cc.level != null ? Number(cc.level) : null,
      }));
    logger.info('googleAds.enumerateManagerChildren.ok', {
      ownerEmail,
      managerCid,
      childCount: children.length,
      childCids: children.map(c => c.cid),
    });
    return children;
  } catch (err) {
    const detail = err?.response?.data?.error?.details?.[0]?.errors?.[0];
    logger.warn('googleAds.enumerateManagerChildren.error', {
      ownerEmail,
      managerCid,
      status: err?.response?.status || null,
      apiMessage: err?.response?.data?.error?.message || null,
      errorCode: detail?.errorCode ? JSON.stringify(detail.errorCode) : null,
      errorMessage: detail?.message || null,
    });
    return [];
  }
}

// ---------- Query runner (GAQL search) ----------

// POST /vNN/customers/{cid}/googleAds:search  (paginated JSON) — we use this
// instead of searchStream because searchStream returns newline-delimited
// JSON in a single response which axios doesn't parse natively. Follow
// nextPageToken until empty.
//
// NOTE: v21 removed the `pageSize` parameter — passing it returns
// PAGE_SIZE_NOT_SUPPORTED (400). Do not add it back.
async function search(accessToken, customerId, query, { loginCustomerId } = {}) {
  const cid = stripCid(customerId);
  const login = loginCustomerId ? stripCid(loginCustomerId) : cid;
  const url = `${BASE_URL}/customers/${cid}/googleAds:search`;

  const results = [];
  let pageToken;
  do {
    const body = { query };
    if (pageToken) body.pageToken = pageToken;
    const { data } = await axios.post(url, body, {
      headers: headers(accessToken, login),
      timeout: 30000,
    });
    (data.results || []).forEach(r => results.push(r));
    pageToken = data.nextPageToken || undefined;
    // safety: cap at 50k rows regardless
    if (results.length > 50000) break;
  } while (pageToken);
  return results;
}

// ---------- Date range helper ----------

// GAQL segments.date accepts BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD' or one of
// several named ranges. We compute explicit dates so date-range comparisons
// stay predictable across timezones.
function dateRangeClause(days) {
  const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const end = new Date();
  const start = new Date(end.getTime() - (n - 1) * 24 * 3600 * 1000);
  const iso = d => d.toISOString().slice(0, 10);
  return {
    clause: `segments.date BETWEEN '${iso(start)}' AND '${iso(end)}'`,
    rangeDays: n,
    startDate: iso(start),
    endDate: iso(end),
  };
}

// Emits an `AND campaign.id = X` fragment when a campaign filter is active,
// otherwise returns empty string. Only append this to queries whose FROM
// resource has a campaign relationship (campaign, ad_group, keyword_view,
// search_term_view, ad_group_ad, geographic_view, age_range_view,
// gender_view). Do NOT append to FROM customer queries — Google Ads
// rejects them with UNSUPPORTED_FIELD_IN_WHERE_CLAUSE.
function campaignFilter(campaignId) {
  if (!campaignId) return '';
  const cid = String(campaignId).replace(/[^0-9]/g, '');
  return cid ? ` AND campaign.id = ${cid}` : '';
}

// ---------- Metric helpers ----------

// Google Ads returns money as micros (1,000,000 = one unit of currency).
function fromMicros(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n / 1_000_000 : 0;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Snake-case protobuf enums come through as strings like "ENABLED", "PAUSED".
function enumLabel(s) {
  if (!s || typeof s !== 'string') return null;
  return s;
}

// ---------- Report methods ----------

async function getCampaigns(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      campaign.bidding_strategy_type,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.cost_per_conversion,
      metrics.conversions_from_interactions_rate,
      metrics.search_impression_share,
      metrics.search_budget_lost_impression_share,
      metrics.search_rank_lost_impression_share,
      metrics.search_absolute_top_impression_share
    FROM campaign
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
    ORDER BY metrics.cost_micros DESC
  `, opts);

  return rows.map(r => {
    const c = r.campaign || {};
    const m = r.metrics || {};
    const b = r.campaignBudget || {};
    const cost = fromMicros(m.costMicros);
    const conv = num(m.conversions);
    return {
      campaignId: String(c.id || ''),
      name: c.name || '',
      status: enumLabel(c.status),
      channel: enumLabel(c.advertisingChannelType),
      channelSubType: enumLabel(c.advertisingChannelSubType),
      biddingStrategy: enumLabel(c.biddingStrategyType),
      budget: fromMicros(b.amountMicros),
      spend: cost,
      cost,
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      avgCpc: fromMicros(m.averageCpc),
      conversions: conv,
      conversionValue: num(m.conversionsValue),
      costPerConversion: fromMicros(m.costPerConversion),
      conversionRate: num(m.conversionsFromInteractionsRate),
      searchImpressionShare: num(m.searchImpressionShare),
      lostIsBudget: num(m.searchBudgetLostImpressionShare),
      lostIsRank: num(m.searchRankLostImpressionShare),
      absoluteTopIs: num(m.searchAbsoluteTopImpressionShare),
      // Shape hooks so client-side can join with GA4 rows on (campaign, source, medium)
      campaign: c.name || '',
      source: 'google',
      medium: 'cpc',
    };
  });
}

async function getAdGroups(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.type,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM ad_group
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
    ORDER BY metrics.cost_micros DESC
    LIMIT 500
  `, opts);

  return rows.map(r => {
    const a = r.adGroup || {};
    const m = r.metrics || {};
    return {
      adGroupId: String(a.id || ''),
      name: a.name || '',
      status: enumLabel(a.status),
      type: enumLabel(a.type),
      campaign: r.campaign?.name || '',
      spend: fromMicros(m.costMicros),
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      cpc: fromMicros(m.averageCpc),
      conversions: num(m.conversions),
      costPerConversion: fromMicros(m.costPerConversion),
    };
  });
}

async function getKeywords(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.post_click_quality_score,
      ad_group_criterion.quality_info.search_predicted_ctr,
      ad_group.name,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM keyword_view
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
    ORDER BY metrics.cost_micros DESC
    LIMIT 1000
  `, opts);

  return rows.map(r => {
    const c = r.adGroupCriterion || {};
    const k = c.keyword || {};
    const q = c.qualityInfo || {};
    const m = r.metrics || {};
    return {
      criterionId: String(c.criterionId || ''),
      keyword: k.text || '',
      matchType: enumLabel(k.matchType),
      status: enumLabel(c.status),
      adGroup: r.adGroup?.name || '',
      campaign: r.campaign?.name || '',
      qualityScore: q.qualityScore != null ? Number(q.qualityScore) : null,
      creativeQualityScore: enumLabel(q.creativeQualityScore),
      landingPageExperience: enumLabel(q.postClickQualityScore),
      expectedCtr: enumLabel(q.searchPredictedCtr),
      clicks: num(m.clicks),
      impressions: num(m.impressions),
      ctr: num(m.ctr),
      avgCpc: fromMicros(m.averageCpc),
      cost: fromMicros(m.costMicros),
      conversions: num(m.conversions),
      costPerConversion: fromMicros(m.costPerConversion),
    };
  });
}

// Search terms are the actual queries users typed — one of the most valuable
// diagnostic reports. `search_term_view` joins the search term back to the
// keyword that matched it.
async function getSearchTerms(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      search_term_view.search_term,
      search_term_view.status,
      segments.keyword.info.text,
      segments.keyword.info.match_type,
      ad_group.name,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
    ORDER BY metrics.cost_micros DESC
    LIMIT 2000
  `, opts);

  return rows.map(r => {
    const stv = r.searchTermView || {};
    const seg = r.segments || {};
    const kw = seg.keyword?.info || {};
    const m = r.metrics || {};
    return {
      searchTerm: stv.searchTerm || '',
      status: enumLabel(stv.status),
      matchedKeyword: kw.text || '',
      matchType: enumLabel(kw.matchType),
      adGroup: r.adGroup?.name || '',
      campaign: r.campaign?.name || '',
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      cost: fromMicros(m.costMicros),
      conversions: num(m.conversions),
      conversionValue: num(m.conversionsValue),
    };
  });
}

async function getAds(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      ad_group_ad.ad.id,
      ad_group_ad.ad.type,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.ad.responsive_search_ad.path1,
      ad_group_ad.ad.responsive_search_ad.path2,
      ad_group_ad.ad.final_urls,
      ad_group_ad.status,
      ad_group_ad.ad_strength,
      ad_group.name,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions
    FROM ad_group_ad
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
    ORDER BY metrics.impressions DESC
    LIMIT 500
  `, opts);

  return rows.map(r => {
    const aga = r.adGroupAd || {};
    const ad = aga.ad || {};
    const rsa = ad.responsiveSearchAd || {};
    const m = r.metrics || {};
    const headlines = (rsa.headlines || []).map(h => h.text).filter(Boolean);
    const descriptions = (rsa.descriptions || []).map(d => d.text).filter(Boolean);
    return {
      adId: String(ad.id || ''),
      type: enumLabel(ad.type),
      status: enumLabel(aga.status),
      adStrength: enumLabel(aga.adStrength),
      headlines,
      descriptions,
      paths: [rsa.path1, rsa.path2].filter(Boolean),
      finalUrls: ad.finalUrls || [],
      adGroup: r.adGroup?.name || '',
      campaign: r.campaign?.name || '',
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      cost: fromMicros(m.costMicros),
      conversions: num(m.conversions),
    };
  });
}

// Asset performance (sitelinks, callouts, images, structured snippets, calls)
// via campaign_asset. asset.type identifies each row.
async function getAssets(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      asset.id,
      asset.type,
      asset.name,
      asset.sitelink_asset.link_text,
      asset.sitelink_asset.description1,
      asset.sitelink_asset.description2,
      asset.callout_asset.callout_text,
      asset.structured_snippet_asset.header,
      asset.structured_snippet_asset.values,
      asset.call_asset.phone_number,
      asset.image_asset.file_size,
      asset.image_asset.mime_type,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions
    FROM campaign_asset
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
    ORDER BY metrics.impressions DESC
    LIMIT 500
  `, opts);

  return rows.map(r => {
    const a = r.asset || {};
    const m = r.metrics || {};
    let text = a.name || '';
    if (a.sitelinkAsset?.linkText) text = a.sitelinkAsset.linkText;
    else if (a.calloutAsset?.calloutText) text = a.calloutAsset.calloutText;
    else if (a.structuredSnippetAsset?.header) text = `${a.structuredSnippetAsset.header}: ${(a.structuredSnippetAsset.values || []).join(', ')}`;
    else if (a.callAsset?.phoneNumber) text = a.callAsset.phoneNumber;
    return {
      assetId: String(a.id || ''),
      type: enumLabel(a.type),
      text,
      campaign: r.campaign?.name || '',
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      cost: fromMicros(m.costMicros),
      conversions: num(m.conversions),
    };
  });
}

// Google's own recommendations (increase budget, improve RSA, add sitelinks,
// remove redundant keywords, …). This is the goldmine for ChatGPT — surface
// exactly what Google is already flagging.
async function getRecommendations(accessToken, customerId, opts = {}) {
  // v21 removed recommendation.impact.{base,potential}_metrics.* as selectable
  // columns — the impact object still exists on the resource but its child
  // metric fields are no longer queryable. We select only what v21 accepts and
  // expose the recommendation surface (type, campaign, dismissed) which is
  // enough for the "what does Google itself suggest?" diagnostic.
  const rows = await search(accessToken, customerId, `
    SELECT
      recommendation.resource_name,
      recommendation.type,
      recommendation.campaign,
      recommendation.campaign_budget,
      recommendation.dismissed
    FROM recommendation
  `, opts);

  return rows.map(r => {
    const rec = r.recommendation || {};
    return {
      resourceName: rec.resourceName || '',
      type: enumLabel(rec.type),
      campaign: rec.campaign || null,
      campaignBudget: rec.campaignBudget || null,
      dismissed: !!rec.dismissed,
      base: { impressions: 0, clicks: 0, cost: 0, conversions: 0 },
      potential: { impressions: 0, clicks: 0, cost: 0, conversions: 0 },
    };
  });
}

async function getConversions(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  // Conversion actions live at customer level; metrics per action come from
  // segments.conversion_action_name / segments.conversion_action.
  const actions = await search(accessToken, customerId, `
    SELECT
      conversion_action.id,
      conversion_action.name,
      conversion_action.status,
      conversion_action.type,
      conversion_action.primary_for_goal,
      conversion_action.category,
      conversion_action.counting_type,
      conversion_action.click_through_lookback_window_days,
      conversion_action.view_through_lookback_window_days,
      conversion_action.value_settings.default_value,
      conversion_action.value_settings.always_use_default_value
    FROM conversion_action
    LIMIT 500
  `, opts);

  // v21: segments.conversion_action_name / conversion_action_category cannot
  // be combined with metrics.cost_micros in the same query
  // (PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE). We don't use
  // cost_micros in the per-action aggregation, so just drop it.
  const metricsRows = await search(accessToken, customerId, `
    SELECT
      segments.conversion_action_name,
      segments.conversion_action_category,
      metrics.all_conversions,
      metrics.all_conversions_value,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    WHERE ${dr.clause}
  `, opts);

  const perAction = new Map();
  metricsRows.forEach(r => {
    const seg = r.segments || {};
    const m = r.metrics || {};
    const name = seg.conversionActionName;
    if (!name) return;
    const entry = perAction.get(name) || { conversions: 0, conversionsValue: 0, allConversions: 0, allConversionsValue: 0 };
    entry.conversions += num(m.conversions);
    entry.conversionsValue += num(m.conversionsValue);
    entry.allConversions += num(m.allConversions);
    entry.allConversionsValue += num(m.allConversionsValue);
    perAction.set(name, entry);
  });

  return actions.map(r => {
    const ca = r.conversionAction || {};
    const vs = ca.valueSettings || {};
    const metrics = perAction.get(ca.name) || { conversions: 0, conversionsValue: 0, allConversions: 0, allConversionsValue: 0 };
    return {
      conversionActionId: String(ca.id || ''),
      name: ca.name || '',
      status: enumLabel(ca.status),
      type: enumLabel(ca.type),
      category: enumLabel(ca.category),
      primary: !!ca.primaryForGoal,
      countingType: enumLabel(ca.countingType),
      clickThroughLookbackDays: num(ca.clickThroughLookbackWindowDays),
      viewThroughLookbackDays: num(ca.viewThroughLookbackWindowDays),
      defaultValue: num(vs.defaultValue),
      alwaysUseDefaultValue: !!vs.alwaysUseDefaultValue,
      conversions: metrics.conversions,
      conversionValue: metrics.conversionsValue,
      allConversions: metrics.allConversions,
      allConversionsValue: metrics.allConversionsValue,
    };
  });
}

async function getDevices(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      segments.device,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.cost_per_conversion,
      metrics.conversions_from_interactions_rate
    FROM customer
    WHERE ${dr.clause}
  `, opts);

  return rows.map(r => {
    const seg = r.segments || {};
    const m = r.metrics || {};
    return {
      device: enumLabel(seg.device),
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      avgCpc: fromMicros(m.averageCpc),
      cost: fromMicros(m.costMicros),
      spend: fromMicros(m.costMicros),
      conversions: num(m.conversions),
      cpa: fromMicros(m.costPerConversion),
      conversionRate: num(m.conversionsFromInteractionsRate),
    };
  });
}

// Geographic performance. `geographic_view` gives country_criterion_id which
// is a geo target constant — resolving it to a human name would require a
// second lookup per row. We return the numeric id + resource name so the
// frontend/ChatGPT can either look it up or use the location-view report.
async function getLocations(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      geographic_view.country_criterion_id,
      geographic_view.location_type,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM geographic_view
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
    ORDER BY metrics.cost_micros DESC
    LIMIT 500
  `, opts);

  return rows.map(r => {
    const g = r.geographicView || {};
    const m = r.metrics || {};
    return {
      countryCriterionId: String(g.countryCriterionId || ''),
      locationType: enumLabel(g.locationType),
      campaign: r.campaign?.name || '',
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      cost: fromMicros(m.costMicros),
      conversions: num(m.conversions),
      costPerConversion: fromMicros(m.costPerConversion),
    };
  });
}

async function getDayHour(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      segments.day_of_week,
      segments.hour,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions
    FROM customer
    WHERE ${dr.clause}
  `, opts);

  return rows.map(r => {
    const seg = r.segments || {};
    const m = r.metrics || {};
    return {
      dayOfWeek: enumLabel(seg.dayOfWeek),
      hour: num(seg.hour),
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      cost: fromMicros(m.costMicros),
      conversions: num(m.conversions),
    };
  });
}

// Audience insight (age, gender). Audience segment membership needs a separate
// audience report — we surface age + gender + income here since they're the
// most actionable audience diagnostics.
async function getAudience(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      ad_group_criterion.age_range.type,
      ad_group_criterion.gender.type,
      ad_group_criterion.income_range.type,
      ad_group.name,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions
    FROM age_range_view
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
    LIMIT 200
  `, opts);

  const gender = await search(accessToken, customerId, `
    SELECT
      ad_group_criterion.gender.type,
      ad_group.name,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions
    FROM gender_view
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
    LIMIT 200
  `, opts);

  const shapeRow = r => {
    const c = r.adGroupCriterion || {};
    const m = r.metrics || {};
    return {
      ageRange: enumLabel(c.ageRange?.type),
      gender: enumLabel(c.gender?.type),
      incomeRange: enumLabel(c.incomeRange?.type),
      adGroup: r.adGroup?.name || '',
      campaign: r.campaign?.name || '',
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      cost: fromMicros(m.costMicros),
      conversions: num(m.conversions),
    };
  };

  return {
    ageRanges: rows.map(shapeRow),
    genders: gender.map(shapeRow),
  };
}

// Auction insights — shows other domains you competed against. Available at
// campaign or ad_group level; campaign is usually enough for a diagnostic.
async function getAuctionInsights(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  try {
    const rows = await search(accessToken, customerId, `
      SELECT
        campaign_audience_view.resource_name,
        campaign.name,
        metrics.search_impression_share,
        metrics.search_top_impression_share,
        metrics.search_absolute_top_impression_share,
        metrics.search_rank_lost_impression_share,
        metrics.search_budget_lost_impression_share
      FROM campaign
      WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
      ORDER BY metrics.search_impression_share DESC
      LIMIT 200
    `, opts);
    return rows.map(r => {
      const m = r.metrics || {};
      return {
        campaign: r.campaign?.name || '',
        searchImpressionShare: num(m.searchImpressionShare),
        searchTopImpressionShare: num(m.searchTopImpressionShare),
        searchAbsoluteTopImpressionShare: num(m.searchAbsoluteTopImpressionShare),
        searchRankLostImpressionShare: num(m.searchRankLostImpressionShare),
        searchBudgetLostImpressionShare: num(m.searchBudgetLostImpressionShare),
      };
    });
  } catch (err) {
    // auction_insight has stricter permissioning — return empty rather than 500
    logger.warn('googleAds.auctionInsights.unavailable', { customerId, error: err.message });
    return [];
  }
}

// Quality Score summary — one row per keyword with quality component breakdown.
// Overlaps with keywords but focused: only keywords with a QS attached, sorted
// worst-first so ChatGPT can target the fixes.
async function getQuality(accessToken, customerId, days, opts = {}) {
  const dr = dateRangeClause(days);
  const rows = await search(accessToken, customerId, `
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.post_click_quality_score,
      ad_group_criterion.quality_info.search_predicted_ctr,
      ad_group.name,
      campaign.name,
      metrics.impressions,
      metrics.clicks
    FROM keyword_view
    WHERE ${dr.clause}${campaignFilter(opts.campaignId)}
      AND ad_group_criterion.quality_info.quality_score IS NOT NULL
    ORDER BY ad_group_criterion.quality_info.quality_score ASC
    LIMIT 500
  `, opts);

  return rows.map(r => {
    const c = r.adGroupCriterion || {};
    const q = c.qualityInfo || {};
    const m = r.metrics || {};
    return {
      criterionId: String(c.criterionId || ''),
      keyword: c.keyword?.text || '',
      matchType: enumLabel(c.keyword?.matchType),
      qualityScore: q.qualityScore != null ? Number(q.qualityScore) : null,
      creativeQualityScore: enumLabel(q.creativeQualityScore),
      landingPageExperience: enumLabel(q.postClickQualityScore),
      expectedCtr: enumLabel(q.searchPredictedCtr),
      adGroup: r.adGroup?.name || '',
      campaign: r.campaign?.name || '',
      impressions: num(m.impressions),
      clicks: num(m.clicks),
    };
  });
}

// GAQL date-time literal helper. Format: 'YYYY-MM-DD HH:MM:SS' (UTC).
function gaqlDatetime(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Detailed change events (per-field, who/when/what). Google caps
// change_event at 30 days from now. We stay 5 minutes inside that boundary
// to survive clock skew between our clock and Google's.
async function getChangeEventDetails(accessToken, customerId, days, opts = {}) {
  const requested = Math.max(1, parseInt(days, 10) || 30);
  const capped = Math.min(30, requested);
  const end = new Date();
  const start = new Date(end.getTime() - (capped * 24 * 3600 * 1000 - 5 * 60 * 1000));
  const rows = await search(accessToken, customerId, `
    SELECT
      change_event.change_date_time,
      change_event.user_email,
      change_event.client_type,
      change_event.change_resource_type,
      change_event.resource_change_operation,
      change_event.campaign,
      change_event.ad_group,
      change_event.asset,
      change_event.changed_fields
    FROM change_event
    WHERE change_event.change_date_time >= '${gaqlDatetime(start)}'
      AND change_event.change_date_time <= '${gaqlDatetime(end)}'
    ORDER BY change_event.change_date_time DESC
    LIMIT 500
  `, opts);

  return rows.map(r => {
    const e = r.changeEvent || {};
    return {
      changeDateTime: e.changeDateTime || null,
      userEmail: e.userEmail || null,
      clientType: enumLabel(e.clientType),
      resourceType: enumLabel(e.changeResourceType),
      operation: enumLabel(e.resourceChangeOperation),
      campaign: e.campaign || null,
      adGroup: e.adGroup || null,
      changedFields: e.changedFields || null,
    };
  });
}

// Summary-only change tracking. change_status returns which resources
// were ADDED/CHANGED/REMOVED and when — but NOT the field-level detail or
// user email. Google caps this at 90 days. We stay 5 minutes inside.
async function getChangeStatusSummary(accessToken, customerId, days, opts = {}) {
  const requested = Math.max(1, parseInt(days, 10) || 90);
  const capped = Math.min(90, requested);
  const end = new Date();
  const start = new Date(end.getTime() - (capped * 24 * 3600 * 1000 - 5 * 60 * 1000));
  const rows = await search(accessToken, customerId, `
    SELECT
      change_status.last_change_date_time,
      change_status.resource_type,
      change_status.resource_status,
      change_status.campaign,
      change_status.ad_group,
      change_status.ad_group_ad,
      change_status.ad_group_criterion,
      change_status.campaign_criterion
    FROM change_status
    WHERE change_status.last_change_date_time >= '${gaqlDatetime(start)}'
      AND change_status.last_change_date_time <= '${gaqlDatetime(end)}'
    ORDER BY change_status.last_change_date_time DESC
    LIMIT 10000
  `, opts);

  return rows.map(r => {
    const s = r.changeStatus || {};
    return {
      changeDateTime: s.lastChangeDateTime || null,
      resourceType: enumLabel(s.resourceType),
      resourceStatus: enumLabel(s.resourceStatus),
      campaign: s.campaign || null,
      adGroup: s.adGroup || null,
      adGroupAd: s.adGroupAd || null,
      adGroupCriterion: s.adGroupCriterion || null,
      campaignCriterion: s.campaignCriterion || null,
    };
  });
}

// Combined change history — the frontend renders both halves.
//
// Google Ads API has two separate change-tracking resources with different
// windows and detail levels:
//   change_event  — field-by-field, user email, up to 30 days
//   change_status — resource-level summary, up to 90 days
//
// A single "give me the last N days" request maps to:
//   N ≤ 30 → detailed events only
//   30 < N ≤ 90 → detailed events (last 30d) + summary (30-N days)
//   N > 90 → same as N=90; anything older is unavailable via the API and
//            surfaced to the UI via unavailableBeyondDays.
async function getChangeHistory(accessToken, customerId, days, opts = {}) {
  const requested = Math.max(1, Math.min(365, parseInt(days, 10) || 30));

  const events = await getChangeEventDetails(accessToken, customerId, Math.min(requested, 30), opts).catch(err => {
    logger.warn('googleAds.changeHistory.events_failed', {
      customerId,
      status: err?.response?.status || null,
      apiMessage: err?.response?.data?.error?.message || err.message,
    });
    return [];
  });

  let summary = [];
  if (requested > 30) {
    summary = await getChangeStatusSummary(accessToken, customerId, Math.min(requested, 90), opts).catch(err => {
      logger.warn('googleAds.changeHistory.summary_failed', {
        customerId,
        status: err?.response?.status || null,
        apiMessage: err?.response?.data?.error?.message || err.message,
      });
      return [];
    });
  }

  return {
    events,
    summary,
    caps: { eventMaxDays: 30, summaryMaxDays: 90 },
    requestedDays: requested,
    availableDays: Math.min(requested, 90),
    unavailableBeyondDays: requested > 90 ? 90 : null,
  };
}

// ---------- Diagnostics aggregator ----------
//
// Runs a subset of the reports and boils them down to a single JSON blob of
// concrete issues. The frontend shows this as a punch list; ChatGPT reads it
// as a starting point for recommendations. Each issue includes enough context
// (counts, campaign names, sample data) to be actionable without a further API
// call.
async function getDiagnostics(accessToken, customerId, days, opts = {}) {
  const [campaigns, keywords, searchTerms, ads, conversions, recommendations] = await Promise.all([
    getCampaigns(accessToken, customerId, days, opts),
    getKeywords(accessToken, customerId, days, opts),
    getSearchTerms(accessToken, customerId, days, opts),
    getAds(accessToken, customerId, days, opts),
    getConversions(accessToken, customerId, days, opts),
    getRecommendations(accessToken, customerId, opts).catch(() => []),
  ]);

  const issues = [];

  // 1. Search Impression Share lost to budget
  const lostBudget = campaigns.filter(c => c.status === 'ENABLED' && c.lostIsBudget >= 0.05);
  if (lostBudget.length > 0) {
    const worst = lostBudget.slice().sort((a, b) => b.lostIsBudget - a.lostIsBudget).slice(0, 5);
    const totalLost = lostBudget.reduce((s, c) => s + c.lostIsBudget, 0) / lostBudget.length;
    issues.push({
      severity: totalLost > 0.2 ? 'high' : 'medium',
      title: 'Search impression share lost due to budget',
      value: `${(totalLost * 100).toFixed(0)}%`,
      campaigns: lostBudget.length,
      details: worst.map(c => ({ name: c.name, lostIsBudget: c.lostIsBudget, spend: c.spend })),
      guidance: 'Consider raising budgets on campaigns where lost IS (budget) >5% AND the ROAS is healthy.',
    });
  }

  // 2. SIS lost to rank
  const lostRank = campaigns.filter(c => c.status === 'ENABLED' && c.lostIsRank >= 0.1);
  if (lostRank.length > 0) {
    const worst = lostRank.slice().sort((a, b) => b.lostIsRank - a.lostIsRank).slice(0, 5);
    issues.push({
      severity: 'medium',
      title: 'Search impression share lost due to rank',
      campaigns: lostRank.length,
      details: worst.map(c => ({ name: c.name, lostIsRank: c.lostIsRank })),
      guidance: 'Improve Quality Score (ad relevance, landing page, expected CTR) or increase max CPC.',
    });
  }

  // 3. Low ad strength
  const weakAds = ads.filter(a => ['POOR', 'AVERAGE'].includes(a.adStrength));
  if (weakAds.length > 0) {
    issues.push({
      severity: 'medium',
      title: 'Ad strength below Good',
      count: weakAds.length,
      details: weakAds.slice(0, 10).map(a => ({
        campaign: a.campaign,
        adGroup: a.adGroup,
        strength: a.adStrength,
        headlineCount: a.headlines.length,
        descriptionCount: a.descriptions.length,
      })),
      guidance: 'Add more headlines/descriptions to reach Good/Excellent. Google recommends 15 headlines + 4 descriptions per RSA.',
    });
  }

  // 4. Low quality scores
  const lowQs = keywords.filter(k => k.qualityScore != null && k.qualityScore <= 4);
  if (lowQs.length > 0) {
    issues.push({
      severity: 'medium',
      title: 'Keywords with low Quality Score',
      count: lowQs.length,
      details: lowQs.slice(0, 15).map(k => ({
        keyword: k.keyword,
        qualityScore: k.qualityScore,
        expectedCtr: k.expectedCtr,
        adRelevance: k.creativeQualityScore,
        landingPageExperience: k.landingPageExperience,
        clicks: k.clicks,
        cost: k.cost,
      })),
      guidance: 'For each low-QS keyword, check which component is BELOW_AVERAGE and fix that first (ad copy, landing page, or expected CTR).',
    });
  }

  // 5. Zero-conversion keywords burning spend
  const wastedSpend = keywords
    .filter(k => k.conversions === 0 && k.cost > 20)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 15);
  if (wastedSpend.length > 0) {
    const totalWasted = wastedSpend.reduce((s, k) => s + k.cost, 0);
    issues.push({
      severity: totalWasted > 500 ? 'high' : 'medium',
      title: 'Keywords with zero conversions burning spend',
      count: wastedSpend.length,
      value: `$${totalWasted.toFixed(0)}`,
      details: wastedSpend.map(k => ({ keyword: k.keyword, cost: k.cost, clicks: k.clicks, campaign: k.campaign })),
      guidance: 'Pause or lower bids on keywords with meaningful spend but zero conversions. Check whether the intent actually matches your offer.',
    });
  }

  // 6. Search terms with meaningful spend, zero conversions — often the
  // signal you need to add negative keywords.
  const wastedTerms = searchTerms
    .filter(t => t.conversions === 0 && t.cost > 10)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20);
  if (wastedTerms.length > 0) {
    issues.push({
      severity: 'high',
      title: 'Search terms with spend but no conversions',
      count: wastedTerms.length,
      value: `$${wastedTerms.reduce((s, t) => s + t.cost, 0).toFixed(0)}`,
      details: wastedTerms.map(t => ({
        searchTerm: t.searchTerm,
        cost: t.cost,
        clicks: t.clicks,
        matchedKeyword: t.matchedKeyword,
      })),
      guidance: 'Add these as negative keywords if intent is off, or write more targeted ads if the intent is right but conversion rate is low.',
    });
  }

  // 7. No primary conversion actions configured
  const primaryConversions = conversions.filter(c => c.primary && c.status === 'ENABLED');
  if (primaryConversions.length === 0 && conversions.length > 0) {
    issues.push({
      severity: 'high',
      title: 'No primary conversion actions enabled',
      count: conversions.length,
      guidance: 'Mark at least one conversion action as primary — Smart Bidding uses primary actions to optimize.',
    });
  }
  if (conversions.length === 0) {
    issues.push({
      severity: 'high',
      title: 'No conversion actions configured',
      guidance: 'Without conversion tracking, Google can\'t optimize bids or report ROAS. Set up at least one conversion action (form submit, phone call, purchase).',
    });
  }

  // 8. Google\'s own recommendations
  if (recommendations.length > 0) {
    const grouped = new Map();
    recommendations.forEach(r => {
      if (r.dismissed) return;
      const t = r.type || 'UNSPECIFIED';
      grouped.set(t, (grouped.get(t) || 0) + 1);
    });
    if (grouped.size > 0) {
      issues.push({
        severity: 'medium',
        title: 'Google Ads recommendations available',
        count: recommendations.filter(r => !r.dismissed).length,
        details: Array.from(grouped.entries()).map(([type, count]) => ({ type, count })),
        guidance: 'Review Google\'s own recommendations — they often surface budget, RSA, and asset improvements before manual audit would find them.',
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    days,
    issues,
    counts: {
      campaigns: campaigns.length,
      keywords: keywords.length,
      searchTerms: searchTerms.length,
      ads: ads.length,
      conversions: conversions.length,
      recommendations: recommendations.length,
    },
  };
}

// ---------- Error normalization ----------

function normalizeApiError(err, context) {
  // Explicit code we set (e.g., DEVELOPER_TOKEN_MISSING) wins over http status.
  if (err?.code === 'DEVELOPER_TOKEN_MISSING') {
    logger.error('googleAds.developer_token_missing', context || {});
    const out = new Error('Google Ads developer token not configured on the server');
    out.status = 503;
    out.code = 'DEVELOPER_TOKEN_MISSING';
    return out;
  }
  const status = err?.response?.status || err?.status || err?.code || null;
  // Google Ads returns error details in response.data.error.details[0].errors
  const apiError = err?.response?.data?.error;
  const detail = apiError?.details?.[0]?.errors?.[0];
  const message = detail?.message || apiError?.message || err?.message || 'google_ads_api_error';
  logger.error('googleAds.api_error', {
    ...(context || {}),
    status,
    message,
    detail: detail || null,
  });
  const out = new Error(message);
  out.status = typeof status === 'number' ? status : 500;
  return out;
}

module.exports = {
  listAccessibleCustomers,
  describeCustomers,
  enumerateManagerChildren,
  getCampaigns,
  getAdGroups,
  getKeywords,
  getSearchTerms,
  getAds,
  getAssets,
  getRecommendations,
  getConversions,
  getDevices,
  getLocations,
  getDayHour,
  getAudience,
  getAuctionInsights,
  getQuality,
  getChangeHistory,
  getDiagnostics,
  normalizeApiError,
  _internal: { search, dateRangeClause, fromMicros, stripCid, BASE_URL, API_VERSION },
};
