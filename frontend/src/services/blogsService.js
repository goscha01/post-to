import axios from '../utils/axiosConfig';

const list = async ({ connectionId, status, limit } = {}) => {
  const params = {};
  if (connectionId) params.connectionId = connectionId;
  if (status) params.status = status;
  if (limit) params.limit = limit;
  const res = await axios.get('/api/blogs', { params });
  return res.data?.blogs || [];
};

const get = async (id) => {
  const res = await axios.get(`/api/blogs/${id}`);
  return res.data?.blog;
};

const update = async (id, patch) => {
  const res = await axios.patch(`/api/blogs/${id}`, patch);
  return res.data?.blog;
};

const remove = async (id) => {
  const res = await axios.delete(`/api/blogs/${id}`);
  return res.data;
};

const generate = async ({ connectionId, keyword, businessName, businessType, service, city, tone, targetAudience }) => {
  const body = { keyword };
  if (connectionId) body.connectionId = connectionId;
  if (businessName) body.businessName = businessName;
  if (businessType) body.businessType = businessType;
  if (service) body.service = service;
  if (city) body.city = city;
  if (tone) body.tone = tone;
  if (targetAudience) body.targetAudience = targetAudience;
  const res = await axios.post('/api/ai/articles', body, { timeout: 60000 });
  return res.data;
};

const publish = async (id) => {
  const res = await axios.post(`/api/blogs/${id}/publish`);
  return res.data; // { blog, urls, hasVerifiedDomain }
};

const unpublish = async (id) => {
  const res = await axios.post(`/api/blogs/${id}/unpublish`);
  return res.data?.blog;
};

const listDomains = async () => {
  const res = await axios.get('/api/blogs/domains');
  return res.data; // { domains, cnameTarget }
};

const createDomain = async ({ hostname, siteName }) => {
  const res = await axios.post('/api/blogs/domains', { hostname, siteName });
  return res.data; // { domain, cnameTarget }
};

const verifyDomain = async (id) => {
  const res = await axios.post(`/api/blogs/domains/${id}/verify`);
  return res.data?.domain;
};

const deleteDomain = async (id) => {
  const res = await axios.delete(`/api/blogs/domains/${id}`);
  return res.data;
};

const refreshDomainTheme = async (id) => {
  const res = await axios.post(`/api/blogs/domains/${id}/refresh-theme`);
  return res.data?.domain;
};

const updateDomainTheme = async (id, patch) => {
  const res = await axios.patch(`/api/blogs/domains/${id}/theme`, patch);
  return res.data?.domain;
};

const uploadHeroImage = async (id, file) => {
  const form = new FormData();
  form.append('image', file);
  const res = await axios.post(`/api/blogs/${id}/hero-image`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data?.blog;
};

const removeHeroImage = async (id) => {
  const res = await axios.delete(`/api/blogs/${id}/hero-image`);
  return res.data?.blog;
};

const suggestHeroImages = async (id, q) => {
  const res = await axios.get(`/api/blogs/${id}/suggest-hero-images`, { params: q ? { q } : {} });
  return res.data; // { query, photos: [...] }
};

const setHeroImageFromUrl = async (id, url) => {
  const res = await axios.post(`/api/blogs/${id}/hero-image/from-url`, { url });
  return res.data?.blog;
};

const blogsService = {
  list, get, update, remove, generate,
  publish, unpublish,
  listDomains, createDomain, verifyDomain, deleteDomain,
  refreshDomainTheme, updateDomainTheme,
  uploadHeroImage, removeHeroImage, suggestHeroImages, setHeroImageFromUrl,
};
export default blogsService;
