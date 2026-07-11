import axios from '../utils/axiosConfig';

const list = async () => {
  const res = await axios.get('/api/connections');
  return res.data?.connections || [];
};

const connectWebsite = async (url) => {
  const res = await axios.post('/api/connections/website', { url });
  return res.data?.connection;
};

const connectOpenAiAds = async ({ apiKey, adAccountId, accountName }) => {
  const res = await axios.post('/api/connections/openai-ads', {
    apiKey,
    adAccountId,
    accountName: accountName || undefined,
  });
  return res.data?.connection;
};

const remove = async (id) => {
  const res = await axios.delete(`/api/connections/${id}`);
  return res.data;
};

const connectionsService = { list, connectWebsite, connectOpenAiAds, remove };
export default connectionsService;
