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

// ---------------------------------------------------------------------------
// Publishing Platform connect methods — one per provider wired end-to-end
// in Phase 1. See backend/src/routes/connections.js for the endpoints.
// ---------------------------------------------------------------------------

const connectWebflow = async ({ apiToken }) => {
  const res = await axios.post('/api/connections/webflow', { apiToken });
  return res.data?.connection;
};

const connectWix = async ({ siteId, apiKey }) => {
  const res = await axios.post('/api/connections/wix', { siteId, apiKey });
  return res.data?.connection;
};

const connectBigCommerce = async ({ storeHash, accessToken, webdavUrl, webdavUser, webdavPass, authorName }) => {
  const res = await axios.post('/api/connections/bigcommerce', {
    storeHash, accessToken, webdavUrl, webdavUser, webdavPass, authorName,
  });
  return res.data?.connection;
};

const connectHubSpot = async ({ accessToken }) => {
  const res = await axios.post('/api/connections/hubspot', { accessToken });
  return res.data?.connection;
};

const connectGoHighLevel = async ({ token, locationId }) => {
  const res = await axios.post('/api/connections/gohighlevel', { token, locationId });
  return res.data?.connection;
};

const connectDuda = async ({ siteName, apiUser, apiPass }) => {
  const res = await axios.post('/api/connections/duda', { siteName, apiUser, apiPass });
  return res.data?.connection;
};

const connectWebhook = async ({ url }) => {
  const res = await axios.post('/api/connections/webhook', { url });
  return res.data?.connection;
};

const connectRssFeeds = async () => {
  const res = await axios.post('/api/connections/rss');
  return res.data?.connection;
};

// WordPress step 1 — just verifies the URL is a WP site. Does NOT create a
// connection row; the wizard advances to step 2 (plugin install) on success.
const verifyWordPress = async (url) => {
  const res = await axios.post('/api/connections/wordpress/verify', { url });
  return res.data; // { ok, url, siteName, description }
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
  connectWebflow,
  connectWix,
  connectBigCommerce,
  connectHubSpot,
  connectGoHighLevel,
  connectDuda,
  connectWebhook,
  connectRssFeeds,
  verifyWordPress,
  remove,
  getFacebookPagePosts,
  getInstagramMedia,
};
export default connectionsService;
