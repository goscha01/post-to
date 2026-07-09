import axios from '../utils/axiosConfig';

// Thin wrapper around /api/google-ads. Every response returns
// `{ customerId, days?, <name>: <payload> }`.

const withCustomerDays = (customerId, days, campaignId) => ({
  params: {
    ...(customerId ? { customerId } : {}),
    ...(days ? { days } : {}),
    ...(campaignId ? { campaignId } : {}),
  },
});

// ---- Customer discovery + selection ----

const listAvailableCustomers = async () => {
  const res = await axios.get('/api/google-ads/customers');
  return res.data?.customers || [];
};

const selectCustomer = async ({
  customerId,
  descriptiveName,
  managerCustomerId,
  currencyCode,
  timeZone,
  ownerGoogleId,
  ownerEmail,
}) => {
  const res = await axios.post('/api/google-ads/customers', {
    customerId,
    descriptiveName,
    managerCustomerId,
    currencyCode,
    timeZone,
    ownerGoogleId,
    ownerEmail,
  });
  return res.data?.connection;
};

const listConnectedCustomers = async () => {
  const res = await axios.get('/api/google-ads/connected');
  return res.data?.customers || [];
};

const diagnoseAuth = async () => {
  const res = await axios.get('/api/google-ads/_diagnose');
  return res.data;
};

// ---- Reports ----

const getCampaigns       = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/campaigns',        withCustomerDays(cid, days, campaignId))).data;
const getAdGroups        = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/adgroups',         withCustomerDays(cid, days, campaignId))).data;
const getKeywords        = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/keywords',         withCustomerDays(cid, days, campaignId))).data;
const getSearchTerms     = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/search-terms',     withCustomerDays(cid, days, campaignId))).data;
const getAds             = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/ads',              withCustomerDays(cid, days, campaignId))).data;
const getAssets          = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/assets',           withCustomerDays(cid, days, campaignId))).data;
const getRecommendations = async (cid)                         => (await axios.get('/api/google-ads/recommendations',  withCustomerDays(cid))).data;
const getConversions     = async (cid, days)                   => (await axios.get('/api/google-ads/conversions',      withCustomerDays(cid, days))).data;
const getDevices         = async (cid, days)                   => (await axios.get('/api/google-ads/devices',          withCustomerDays(cid, days))).data;
const getLocations       = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/locations',        withCustomerDays(cid, days, campaignId))).data;
const getDayHour         = async (cid, days)                   => (await axios.get('/api/google-ads/day-hour',         withCustomerDays(cid, days))).data;
const getAudience        = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/audience',         withCustomerDays(cid, days, campaignId))).data;
const getAuctionInsights = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/auction-insights', withCustomerDays(cid, days, campaignId))).data;
const getQuality         = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/quality',          withCustomerDays(cid, days, campaignId))).data;
const getChangeHistory   = async (cid, days)                   => (await axios.get('/api/google-ads/change-history',   withCustomerDays(cid, days))).data;
const getDiagnostics     = async (cid, days, campaignId)       => (await axios.get('/api/google-ads/diagnostics',      withCustomerDays(cid, days, campaignId))).data;

const googleAdsService = {
  listAvailableCustomers,
  selectCustomer,
  listConnectedCustomers,
  diagnoseAuth,
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
};

export default googleAdsService;
