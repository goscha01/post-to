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

const selectProperty = async ({ propertyId, displayName, accountId }) => {
  const res = await axios.post('/api/analytics/properties', {
    propertyId,
    displayName,
    accountId,
  });
  return res.data?.connection;
};

const listConnectedProperties = async () => {
  const res = await axios.get('/api/analytics/connected');
  return res.data?.properties || [];
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

const analyticsService = {
  listAvailableProperties,
  selectProperty,
  listConnectedProperties,
  getOverview,
  getTraffic,
  getLandingPages,
  getEvents,
  getCampaigns,
  getDevices,
  getGeography,
};

export default analyticsService;
