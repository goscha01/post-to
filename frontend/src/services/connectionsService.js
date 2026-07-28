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

// Recent posts for social providers. Response shape matches the fields the
// Posts.js post card already renders (id, content, media[], createdAt).
const getFacebookPagePosts = async (connectionId, limit = 10) => {
  const res = await axios.get(`/api/social/facebook/pages/${connectionId}/posts`, { params: { limit } });
  return res.data?.posts || [];
};

const getInstagramMedia = async (connectionId, limit = 10) => {
  const res = await axios.get(`/api/social/instagram/${connectionId}/media`, { params: { limit } });
  return res.data?.posts || [];
};

const connectionsService = {
  list,
  connectWebsite,
  connectOpenAiAds,
  remove,
  getFacebookPagePosts,
  getInstagramMedia,
};
export default connectionsService;
