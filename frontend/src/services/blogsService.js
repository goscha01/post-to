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
  // Article generation now includes: initial LLM (10-30s) + optional bounded
  // repair (+10-15s) + auto-hero attach (Pexels + image download + S3 upload,
  // 5-15s). Real median ~25s but tail can hit ~90s under load. Bump to 3 min
  // to keep the UI from tearing when everything runs long. Server-side there
  // are still individual timeouts (90s per LLM call, 15s for image download,
  // etc.) that stop things running away forever.
  const res = await axios.post('/api/ai/articles', body, { timeout: 3 * 60 * 1000 });
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

const setHeroImageFromUrl = async (id, url, sourceId) => {
  const body = sourceId ? { url, sourceId } : { url };
  const res = await axios.post(`/api/blogs/${id}/hero-image/from-url`, body);
  return res.data?.blog;
};

// Recompute the server-authoritative SEO analysis on demand. Cheap on the
// server (analyzer is pure JS) — fine to call after debounced local edits.
const analyzeSeo = async (id) => {
  const res = await axios.post(`/api/blogs/${id}/seo-analyze`);
  return res.data; // { blog, seo }
};

// Targeted "Fix with AI" for a single failed check. Returns the changed
// fields (so the UI can highlight the diff) alongside the fresh analysis.
const fixSeo = async (id, checkId) => {
  const res = await axios.post(`/api/blogs/${id}/seo-fix`, { checkId }, { timeout: 60000 });
  return res.data; // { blog, seo, changed, previous }
};

// Batch "Fix all" — loops through every failing/warning check (up to 8) on
// the server and applies targeted fixes sequentially. Longer timeout since
// each internal call is its own LLM round-trip.
const fixSeoAll = async (id) => {
  const res = await axios.post(`/api/blogs/${id}/seo-fix-all`, {}, { timeout: 5 * 60 * 1000 });
  return res.data; // { blog, seo, applied: [{ checkId, changedFields }] }
};

// -------------------------------------------------------------------------
// Publishing Platform fan-out (Phase 2)
// -------------------------------------------------------------------------

const publishToTargets = async (id, connectionIds) => {
  const res = await axios.post(`/api/blogs/${id}/publish-to`, { connectionIds }, { timeout: 60000 });
  return res.data; // { article_id, results: [{ connectionId, ok, publishedUrl, error, ... }] }
};

const listPublishTargets = async (id) => {
  const res = await axios.get(`/api/blogs/${id}/publish-targets`);
  return res.data?.targets || [];
};

const retryPublishTarget = async (id, targetId) => {
  const res = await axios.post(`/api/blogs/${id}/publish-targets/${targetId}/retry`, {}, { timeout: 60000 });
  return res.data?.result;
};

const blogsService = {
  list, get, update, remove, generate,
  publish, unpublish,
  listDomains, createDomain, verifyDomain, deleteDomain,
  refreshDomainTheme, updateDomainTheme,
  uploadHeroImage, removeHeroImage, suggestHeroImages, setHeroImageFromUrl,
  analyzeSeo, fixSeo, fixSeoAll,
  publishToTargets, listPublishTargets, retryPublishTarget,
};
export default blogsService;
