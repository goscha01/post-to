import axios from '../utils/axiosConfig';

// Thin wrappers around /api/team/*. See backend/src/routes/team.js.

const list = async () => {
  const res = await axios.get('/api/team/members');
  return res.data;
};

const invite = async ({ email, role, name }) => {
  const res = await axios.post('/api/team/invite', { email, role, name });
  return res.data;
};

const resendInvite = async (inviteId) => {
  const res = await axios.post(`/api/team/invite/${inviteId}/resend`);
  return res.data;
};

const revokeInvite = async (inviteId) => {
  const res = await axios.delete(`/api/team/invite/${inviteId}`);
  return res.data;
};

const changeRole = async (memberId, role) => {
  const res = await axios.patch(`/api/team/members/${memberId}/role`, { role });
  return res.data;
};

const removeMember = async (memberId) => {
  const res = await axios.delete(`/api/team/members/${memberId}`);
  return res.data;
};

// Public — used by the accept-invite page before the user is signed in.
const previewInvite = async (token) => {
  const res = await axios.get('/api/team/invite/preview', { params: { token } });
  return res.data;
};

const acceptInvite = async (token) => {
  const res = await axios.post('/api/team/invite/accept', { token });
  return res.data; // { ok, token: newJwt, workspace_owner_id }
};

const listWorkspaces = async () => {
  const res = await axios.get('/api/team/workspaces');
  return res.data?.workspaces || [];
};

const switchWorkspace = async (ownerUserId) => {
  const res = await axios.post('/api/team/workspaces/switch', { owner_user_id: ownerUserId });
  return res.data; // { ok, token: newJwt, workspace_owner_id }
};

const teamService = {
  list,
  invite,
  resendInvite,
  revokeInvite,
  changeRole,
  removeMember,
  previewInvite,
  acceptInvite,
  listWorkspaces,
  switchWorkspace,
};
export default teamService;
