import axios from '../utils/axiosConfig';

const list = async () => {
  const res = await axios.get('/api/connections');
  return res.data?.connections || [];
};

const connectWebsite = async (url) => {
  const res = await axios.post('/api/connections/website', { url });
  return res.data?.connection;
};

const remove = async (id) => {
  const res = await axios.delete(`/api/connections/${id}`);
  return res.data;
};

const connectionsService = { list, connectWebsite, remove };
export default connectionsService;
