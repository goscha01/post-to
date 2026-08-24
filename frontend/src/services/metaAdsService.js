import axios from '../utils/axiosConfig';

// Thin wrapper around /api/meta-ads. Every response returns the shape the
// backend router emits (see backend/src/routes/metaAds.js).
//
// The `interpretMetaError(err)` helper centralizes the error-contract
// decode so components can render appropriate connection-state banners
// (missing_scope, no_selection, needs_reauth, no_accounts) rather than
// hand-rolling code checks in every catch block.

const withParams = (adAccountId, days) => ({
  params: {
    ...(adAccountId ? { adAccountId } : {}),
    ...(days ? { days } : {}),
  },
});

// ---- Connection + account selection ----

const diagnoseAuth = async () => {
  const res = await axios.get('/api/meta-ads/_diagnose');
  return res.data;
};

const listAvailableAccounts = async () => {
  const res = await axios.get('/api/meta-ads/accounts');
  return res.data;
};

const selectAccount = async ({ adAccountIds, defaultAdAccountId }) => {
  const res = await axios.post('/api/meta-ads/accounts', {
    adAccountIds,
    defaultAdAccountId,
  });
  return res.data?.selection;
};

const listConnected = async () => {
  const res = await axios.get('/api/meta-ads/connected');
  return res.data?.selection;
};

// ---- Reports ----

const getOverview        = async (adAccountId, days) => (await axios.get('/api/meta-ads/overview',         withParams(adAccountId, days))).data;
const getCampaigns       = async (adAccountId, days) => (await axios.get('/api/meta-ads/campaigns',        withParams(adAccountId, days))).data;
const getAdSets          = async (adAccountId, days) => (await axios.get('/api/meta-ads/adsets',           withParams(adAccountId, days))).data;
const getAds             = async (adAccountId, days) => (await axios.get('/api/meta-ads/ads',              withParams(adAccountId, days))).data;
const getPlacements      = async (adAccountId, days) => (await axios.get('/api/meta-ads/placements',       withParams(adAccountId, days))).data;
const getDevices         = async (adAccountId, days) => (await axios.get('/api/meta-ads/devices',          withParams(adAccountId, days))).data;
const getDemographics    = async (adAccountId, days) => (await axios.get('/api/meta-ads/demographics',     withParams(adAccountId, days))).data;
const getDayHour         = async (adAccountId, days) => (await axios.get('/api/meta-ads/day-hour',         withParams(adAccountId, days))).data;
const getCreatives       = async (adAccountId)       => (await axios.get('/api/meta-ads/creatives',        withParams(adAccountId))).data;
const getDeliveryIssues  = async (adAccountId)       => (await axios.get('/api/meta-ads/delivery-issues', withParams(adAccountId))).data;
const getDiagnostics     = async (adAccountId, days) => (await axios.get('/api/meta-ads/diagnostics',      withParams(adAccountId, days))).data;

// ---- Error interpretation ----

// Given an axios error, return a stable UX intent code the component can
// switch on. Never throws.
//
//   not_connected     → user needs to connect Meta OAuth
//   missing_scope     → Meta connected but token lacks ads_read; needs reconnect
//   token_invalid     → Meta connected but token is dead; needs reconnect
//   no_accounts       → Meta has zero accessible ad accounts
//   no_selection      → user hasn't picked an ad account via POST /accounts
//   ad_account_forbidden → user asked for an act_id they can't access
//   rate_limited      → Meta throttled; retry later
//   upstream          → Meta returned an error we can't classify
//   generic           → non-Meta error (network, 500, etc.)
const interpretMetaError = (err) => {
  const body = err?.response?.data || {};
  const code = body.code;
  const status = err?.response?.status || 0;
  switch (code) {
    case 'META_NOT_CONNECTED':
      return { intent: 'not_connected', message: body.error || 'Meta not connected', body };
    case 'META_ADS_SCOPE_REQUIRED':
      return { intent: 'missing_scope', message: body.error || 'ads_read permission required', body };
    case 'META_TOKEN_INVALID':
      return { intent: 'token_invalid', message: body.error || 'Meta token expired', body };
    case 'META_NO_AD_ACCOUNTS':
      return { intent: 'no_accounts', message: body.error || 'No accessible ad accounts', body };
    case 'META_NO_SELECTION':
      return { intent: 'no_selection', message: body.error || 'No ad account selected', body };
    case 'META_AD_ACCOUNT_NOT_AUTHORIZED':
      return { intent: 'ad_account_forbidden', message: body.error || 'Ad account not authorized', body };
    case 'META_INVALID_AD_ACCOUNT_ID':
      return { intent: 'ad_account_forbidden', message: body.error || 'Invalid ad account id', body };
    case 'META_INVALID_DAY_RANGE':
      return { intent: 'generic', message: body.error || 'Invalid day range', body };
    case 'META_RATE_LIMITED':
      return { intent: 'rate_limited', message: 'Meta rate limit reached. Wait and retry.', body };
    case 'META_UPSTREAM_ERROR':
      return { intent: 'upstream', message: body.error || 'Meta API error', body };
    default:
      return {
        intent: status === 401 ? 'not_connected' : 'generic',
        message: body.error || err?.message || 'Request failed',
        body,
      };
  }
};

const metaAdsService = {
  diagnoseAuth,
  listAvailableAccounts,
  selectAccount,
  listConnected,
  getOverview,
  getCampaigns,
  getAdSets,
  getAds,
  getPlacements,
  getDevices,
  getDemographics,
  getDayHour,
  getCreatives,
  getDeliveryIssues,
  getDiagnostics,
  interpretMetaError,
};

export default metaAdsService;
