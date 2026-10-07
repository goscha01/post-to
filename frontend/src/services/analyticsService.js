import axios from '../utils/axiosConfig';

// Thin wrapper around /api/analytics. All calls pass `propertyId` (or nothing —
// backend falls back to the most recent connected GA4 property) and a day range.
// Every response returns `{ propertyId, days, <name>: <payload> }` where <name>
// mirrors the resource: overview, traffic, landingPages, events, campaigns,
// devices, geography.

const withPropertyDays = (propertyId, days) => ({
  params: { ...(propertyId ? { propertyId } : {}), ...(days ? { days } : {}) },
});

// ---- Property discovery + selection ----

const listAvailableProperties = async () => {
  const res = await axios.get('/api/analytics/properties');
  return res.data?.properties || [];
};

const selectProperty = async ({ propertyId, displayName, accountId, ownerGoogleId, ownerEmail }) => {
  const res = await axios.post('/api/analytics/properties', {
    propertyId,
    displayName,
    accountId,
    ownerGoogleId,
    ownerEmail,
  });
  return res.data?.connection;
};

const listConnectedProperties = async () => {
  const res = await axios.get('/api/analytics/connected');
  return res.data?.properties || [];
};

const listConnectedAccounts = async () => {
  const res = await axios.get('/api/analytics/accounts');
  return res.data?.accounts || [];
};

// ---- Reports ----

const getOverview = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/overview', withPropertyDays(propertyId, days));
  return res.data;
};

const getTraffic = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/traffic', withPropertyDays(propertyId, days));
  return res.data;
};

const getLandingPages = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/landing-pages', withPropertyDays(propertyId, days));
  return res.data;
};

const getEvents = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/events', withPropertyDays(propertyId, days));
  return res.data;
};

const getCampaigns = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/campaigns', withPropertyDays(propertyId, days));
  return res.data;
};

const getDevices = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/devices', withPropertyDays(propertyId, days));
  return res.data;
};

const getGeography = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/geography', withPropertyDays(propertyId, days));
  return res.data;
};

// Ordered in-app funnel (GA4 runFunnelReport). Returns
// { propertyId, days, inAppFunnel: { funnel: [{ key, label, users, event }], rangeDays } }
const getInAppFunnel = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/in-app-funnel', withPropertyDays(propertyId, days));
  return res.data;
};

// Distinct users per screenName (GA4 built-in dimension). Used by the
// frontend to render screen-level sub-steps under each in-app funnel step.
const getScreenViews = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/screen-views', withPropertyDays(propertyId, days));
  return res.data;
};

// Breakdown of plan_selected events by plan_id + billing_period. Requires
// those params to be registered as event-scoped custom dimensions in GA4
// Admin; backend surfaces an error field if not.
const getPlanBreakdown = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/plan-breakdown', withPropertyDays(propertyId, days));
  return res.data;
};

// Same shape as plan_selected breakdown but for the purchase_started event
// (user tapped Subscribe / Start trial on the paywall). Powers the per-plan
// sub-rows under the Started purchase funnel step and the In trial estimate.
const getPurchaseStartedBreakdown = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/purchase-started-breakdown', withPropertyDays(propertyId, days));
  return res.data;
};

// Same for the purchase event (confirmed paid). Powers the per-plan sub-rows
// under the Paid funnel step.
const getPurchaseBreakdown = async (propertyId, days) => {
  const res = await axios.get('/api/analytics/purchase-breakdown', withPropertyDays(propertyId, days));
  return res.data;
};

// Real subscription state from the RevenueCat webhook ingestion. Returns:
//   { days, subscriptionState: {
//       available: true,
//       windowDays,
//       active: { total, byPlan, endingSoon },
//       postTrial: { windowDays, totalEnded, converted, canceled_in_trial, expired }
//     }
//   }
// Or { subscriptionState: { available: false, reason } } when the RC webhook
// hasn't ingested anything yet — frontend falls back to the arithmetic GA4
// estimate (purchase_started − purchase).
const getSubscriptionState = async (days) => {
  const res = await axios.get('/api/analytics/subscription-state', {
    params: days ? { days } : {},
  });
  return res.data;
};

// App Store Connect helpers — iOS top-of-funnel (impressions → PPVs → installs).
// Kept in this service (not a separate ascService) so the Analytics page has
// one import surface for all its data.
const listAscConnections = async () => {
  const res = await axios.get('/api/asc/connected');
  return res.data?.connections || [];
};

const getAscInstallFunnel = async (connectionId, days) => {
  const res = await axios.get('/api/asc/analytics/funnel', {
    params: { connectionId, ...(days ? { days } : {}) },
  });
  return res.data;
};

// Ad attribution — per (Source Type, Campaign) with PPVs + real installs.
// Answers "of my ad spend, how many installs did each campaign drive?"
const getAscAdAttribution = async (connectionId, days) => {
  const res = await axios.get('/api/asc/analytics/ad-attribution', {
    params: { connectionId, ...(days ? { days } : {}) },
  });
  return res.data;
};

// Meta Ads overlay for the connected ASC app — campaigns promoting this
// specific Apple app, with per-campaign installs/clicks/spend/visits.
// Used on the Analytics page to fill in Impressions / Page Visitors when
// Apple's own engagement data is pending (5-7 day lag).
const getAscMetaAdsOverlay = async (connectionId, days) => {
  const res = await axios.get('/api/asc/analytics/meta-ads', {
    params: { connectionId, ...(days ? { days } : {}) },
    timeout: 180_000,
  });
  return res.data;
};

const getAscGoogleAdsOverlay = async (connectionId, days) => {
  const res = await axios.get('/api/asc/analytics/google-ads', {
    params: { connectionId, ...(days ? { days } : {}) },
    timeout: 180_000,
  });
  return res.data;
};

const analyticsService = {
  listAvailableProperties,
  selectProperty,
  listConnectedProperties,
  listConnectedAccounts,
  getOverview,
  getTraffic,
  getLandingPages,
  getEvents,
  getCampaigns,
  getDevices,
  getGeography,
  getInAppFunnel,
  getScreenViews,
  getPlanBreakdown,
  getPurchaseStartedBreakdown,
  getPurchaseBreakdown,
  getSubscriptionState,
  listAscConnections,
  getAscInstallFunnel,
  getAscAdAttribution,
  getAscMetaAdsOverlay,
  getAscGoogleAdsOverlay,
};

export default analyticsService;
