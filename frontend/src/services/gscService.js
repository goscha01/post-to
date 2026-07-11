import axios from '../utils/axiosConfig';

const listSites = async () => {
  const res = await axios.get('/api/gsc/sites');
  return res.data;
};

const saveSite = async ({ siteUrl, displayName, permissionLevel, ownerGoogleId, ownerEmail }) => {
  const res = await axios.post('/api/gsc/sites', { siteUrl, displayName, permissionLevel, ownerGoogleId, ownerEmail });
  return res.data?.connection;
};

const listConnected = async () => {
  const res = await axios.get('/api/gsc/connected');
  return res.data?.connections || [];
};

const topQueries = async ({ connectionId, siteUrl, days = 7, limit = 25 } = {}) => {
  const params = { days, limit };
  if (connectionId) params.connectionId = connectionId;
  if (siteUrl) params.siteUrl = siteUrl;
  const res = await axios.get('/api/gsc/queries', { params });
  return res.data;
};

const gscService = { listSites, saveSite, listConnected, topQueries };
export default gscService;
