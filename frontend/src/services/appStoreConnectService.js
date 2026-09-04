import axios from '../utils/axiosConfig';

// Thin wrapper around /api/asc. All calls require an authenticated user
// (JWT via axiosConfig interceptor).

const connect = async ({ issuerId, keyId, p8, vendorNumber, appId }) => {
  const res = await axios.post('/api/asc/connect', {
    issuerId, keyId, p8, vendorNumber, appId,
  });
  return res.data;
};

const listConnected = async () => {
  const res = await axios.get('/api/asc/connected');
  return res.data?.connections || [];
};

const diagnose = async (connectionId) => {
  const res = await axios.get('/api/asc/_diagnose', { params: { connectionId } });
  return res.data;
};

const listApps = async (connectionId) => {
  const res = await axios.get('/api/asc/apps', { params: { connectionId } });
  return res.data;
};

const getReviews = async ({ connectionId, appId, limit = 50, territory }) => {
  const res = await axios.get('/api/asc/reviews', {
    params: {
      connectionId,
      ...(appId ? { appId } : {}),
      limit,
      ...(territory ? { territory } : {}),
    },
  });
  return res.data;
};

const getSales = async ({ connectionId, days = 7 }) => {
  const res = await axios.get('/api/asc/sales', {
    params: { connectionId, days },
  });
  return res.data;
};

const remove = async (connectionId) => {
  const res = await axios.delete(`/api/asc/${connectionId}`);
  return res.data;
};

// ---- Analytics (Phase 2, async report flow) ----

const analyticsStatus = async (connectionId) => {
  const res = await axios.get('/api/asc/analytics/status', { params: { connectionId } });
  return res.data;
};

const analyticsBootstrap = async (connectionId) => {
  const res = await axios.post('/api/asc/analytics/bootstrap', { connectionId });
  return res.data;
};

const analyticsWalk = async (connectionId) => {
  const res = await axios.post('/api/asc/analytics/walk', { connectionId });
  return res.data;
};

const analyticsFunnel = async (connectionId, days = 14) => {
  const res = await axios.get('/api/asc/analytics/funnel', { params: { connectionId, days } });
  return res.data;
};

const analyticsSources = async (connectionId, days = 14) => {
  const res = await axios.get('/api/asc/analytics/sources', { params: { connectionId, days } });
  return res.data;
};

export default {
  connect,
  listConnected,
  diagnose,
  listApps,
  getReviews,
  getSales,
  remove,
  analyticsStatus,
  analyticsBootstrap,
  analyticsWalk,
  analyticsFunnel,
  analyticsSources,
};
