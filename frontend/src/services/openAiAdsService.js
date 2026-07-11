import axios from '../utils/axiosConfig';

const diagnose = async ({ connectionId } = {}) => {
  const res = await axios.get('/api/openai-ads/_diagnose', { params: { connectionId } });
  return res.data;
};

const listConnected = async () => {
  const res = await axios.get('/api/openai-ads/connected');
  return res.data?.connections || [];
};

const getCampaigns = async ({ connectionId } = {}) => {
  const res = await axios.get('/api/openai-ads/campaigns', { params: { connectionId } });
  return res.data?.campaigns || [];
};

const getAdGroups = async ({ connectionId } = {}) => {
  const res = await axios.get('/api/openai-ads/ad-groups', { params: { connectionId } });
  return res.data?.adGroups || [];
};

const getAds = async ({ connectionId } = {}) => {
  const res = await axios.get('/api/openai-ads/ads', { params: { connectionId } });
  return res.data?.ads || [];
};

const getInsights = async ({ connectionId, scope = 'account', days = 30, granularity = 'daily', aggregationLevel, id } = {}) => {
  const res = await axios.get('/api/openai-ads/insights', {
    params: { connectionId, scope, days, granularity, aggregationLevel, id },
  });
  return res.data?.insights || [];
};

const openAiAdsService = {
  diagnose,
  listConnected,
  getCampaigns,
  getAdGroups,
  getAds,
  getInsights,
};
export default openAiAdsService;
