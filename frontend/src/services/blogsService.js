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

const blogsService = { list, get, update, remove, generate };
export default blogsService;
