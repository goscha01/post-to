import axios from '../utils/axiosConfig';

const list = async () => {
  const res = await axios.get('/api/automations');
  return res.data?.automations || [];
};

const get = async (id) => {
  const res = await axios.get(`/api/automations/${id}`);
  return res.data?.automation;
};

const create = async (payload) => {
  const res = await axios.post('/api/automations', payload);
  return res.data?.automation;
};

const update = async (id, patch) => {
  const res = await axios.patch(`/api/automations/${id}`, patch);
  return res.data?.automation;
};

const remove = async (id) => {
  const res = await axios.delete(`/api/automations/${id}`);
  return res.data;
};

// Test-run — kicks off the same execution the scheduler uses, but right now.
// Honors auto_publish, so a rule set to draft-only will still just draft.
// Long-running (LLM + image gen + fan-out) — allow up to 2 minutes.
const testRun = async (id) => {
  const res = await axios.post(`/api/automations/${id}/run`, {}, { timeout: 180_000 });
  return res.data?.run;
};

const listRuns = async (id, limit = 20) => {
  const res = await axios.get(`/api/automations/${id}/runs`, { params: { limit } });
  return res.data?.runs || [];
};

export default { list, get, create, update, remove, testRun, listRuns };
