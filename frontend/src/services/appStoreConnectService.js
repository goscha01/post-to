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
  // Sales & Trends fetches one Apple API call per day. Backend parallelizes
  // in batches of 5, but 365-day windows still take ~15-40s. Override the
  // 60s default so the long views don't spuriously error out.
  const res = await axios.get('/api/asc/sales', {
    params: { connectionId, days },
    timeout: 180_000,
  });
  return res.data;
};

const remove = async (connectionId) => {
  const res = await axios.delete(`/api/asc/${connectionId}`);
  return res.data;
};

// PATCH — used when the user rotates their .p8 key (e.g. upgrading a
// Developer-role key to Admin so App Analytics works). Issuer ID is
// immutable via this endpoint — delete + re-add if you truly need to
// change it. Passing a new p8 requires a new keyId (each .p8 is bound
// to one key id).
const updateCreds = async (connectionId, { keyId, p8, vendorNumber, appId }) => {
  const res = await axios.patch(`/api/asc/${connectionId}`, {
    ...(keyId ? { keyId } : {}),
    ...(p8 ? { p8 } : {}),
    ...(vendorNumber !== undefined ? { vendorNumber } : {}),
    ...(appId ? { appId } : {}),
  });
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
  // Walk downloads N daily instances × M segments from Apple sequentially —
  // legitimate cold-cache walks routinely take 60-180s. Override the 60s
  // default so "Refresh from Apple" doesn't spuriously error out.
  const res = await axios.post('/api/asc/analytics/walk', { connectionId }, { timeout: 240_000 });
  return res.data;
};

const analyticsFunnel = async (connectionId, days = 14) => {
  // Funnel includes a live Sales & Trends overlay (one Apple call per day
  // in the window, batched 5-at-a-time in the backend). 365-day windows
  // take longer than the 60s default axios timeout — override to 180s.
  const res = await axios.get('/api/asc/analytics/funnel', {
    params: { connectionId, days },
    timeout: 180_000,
  });
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
  updateCreds,
  analyticsStatus,
  analyticsBootstrap,
  analyticsWalk,
  analyticsFunnel,
  analyticsSources,
};
