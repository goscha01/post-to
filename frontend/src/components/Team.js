import React, { useState, useEffect, useCallback } from 'react';
import { Users, Mail, Trash2, RefreshCw, Send, ShieldCheck, User, Copy, Check, AlertCircle } from 'lucide-react';
import teamService from '../services/teamService';

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function roleBadgeClass(role) {
  if (role === 'owner') return 'bg-amber-100 text-amber-800 border-amber-200';
  if (role === 'admin') return 'bg-blue-100 text-blue-800 border-blue-200';
  return 'bg-gray-100 text-gray-700 border-gray-200';
}

const Team = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null); // { kind: 'ok'|'err', text }
  const [data, setData] = useState({ members: [], pending_invitations: [], your_role: 'member' });
  const [invite, setInvite] = useState({ email: '', name: '', role: 'member' });
  const [sending, setSending] = useState(false);
  const [copiedInviteId, setCopiedInviteId] = useState(null);

  const canManage = data.your_role === 'owner' || data.your_role === 'admin';
  const isOwner = data.your_role === 'owner';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await teamService.list();
      setData(d);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load team');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const showBanner = (kind, text) => {
    setBanner({ kind, text });
    setTimeout(() => setBanner(null), 4000);
  };

  const onInvite = async (e) => {
    e.preventDefault();
    if (!invite.email.trim()) return;
    setSending(true);
    try {
      const res = await teamService.invite({
        email: invite.email.trim(),
        role: invite.role,
        name: invite.name.trim() || undefined,
      });
      showBanner(
        res.email_sent ? 'ok' : 'err',
        res.email_sent
          ? `Invitation sent to ${res.invitation.email}`
          : `Invite created for ${res.invitation.email}, but email delivery failed — copy the link from the pending list.`
      );
      setInvite({ email: '', name: '', role: 'member' });
      await load();
    } catch (e) {
      showBanner('err', e.response?.data?.error || 'Failed to send invitation');
    } finally {
      setSending(false);
    }
  };

  const onResend = async (inviteId) => {
    try {
      const res = await teamService.resendInvite(inviteId);
      showBanner(
        res.email_sent ? 'ok' : 'err',
        res.email_sent ? 'Invitation resent.' : 'Token rotated, but email delivery failed.'
      );
      await load();
    } catch (e) {
      showBanner('err', e.response?.data?.error || 'Failed to resend');
    }
  };

  const onRevoke = async (inviteId) => {
    if (!window.confirm('Revoke this invitation?')) return;
    try {
      await teamService.revokeInvite(inviteId);
      showBanner('ok', 'Invitation revoked.');
      await load();
    } catch (e) {
      showBanner('err', e.response?.data?.error || 'Failed to revoke');
    }
  };

  const onCopyLink = async (invitation) => {
    // The server doesn't return the link in the /members list (no token is
    // exposed for security). Resend the invite to get a fresh link.
    try {
      const res = await teamService.resendInvite(invitation.id);
      if (res.invite_link) {
        await navigator.clipboard.writeText(res.invite_link);
        setCopiedInviteId(invitation.id);
        setTimeout(() => setCopiedInviteId(null), 2000);
      }
    } catch (e) {
      showBanner('err', 'Failed to copy invite link');
    }
  };

  const onChangeRole = async (member, newRole) => {
    try {
      await teamService.changeRole(member.id, newRole);
      showBanner('ok', `${member.name || member.email} is now ${ROLE_LABELS[newRole] || newRole}.`);
      await load();
    } catch (e) {
      showBanner('err', e.response?.data?.error || 'Failed to change role');
    }
  };

  const onRemove = async (member) => {
    if (!window.confirm(`Remove ${member.name || member.email} from the workspace?`)) return;
    try {
      await teamService.removeMember(member.id);
      showBanner('ok', 'Member removed.');
      await load();
    } catch (e) {
      showBanner('err', e.response?.data?.error || 'Failed to remove member');
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-primary-100 text-primary-700">
          <Users size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Team</h1>
          <p className="text-sm text-gray-500">
            Invite teammates to manage this Post To workspace with you.
          </p>
        </div>
      </div>

      {banner && (
        <div className={`mb-4 px-4 py-3 rounded-lg border text-sm ${
          banner.kind === 'ok'
            ? 'bg-green-50 border-green-200 text-green-800'
            : 'bg-red-50 border-red-200 text-red-800'
        }`}>
          {banner.text}
        </div>
      )}

      {/* Invite form */}
      {canManage && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Send size={16} /> Invite a teammate
          </h2>
          <form onSubmit={onInvite} className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              type="email"
              required
              placeholder="teammate@example.com"
              value={invite.email}
              onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              className="md:col-span-2 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              disabled={sending}
            />
            <input
              type="text"
              placeholder="Name (optional)"
              value={invite.name}
              onChange={(e) => setInvite({ ...invite, name: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              disabled={sending}
            />
            <div className="flex gap-2">
              <select
                value={invite.role}
                onChange={(e) => setInvite({ ...invite, role: e.target.value })}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-primary-500"
                disabled={sending}
              >
                <option value="member">Member</option>
                {isOwner && <option value="admin">Admin</option>}
              </select>
              <button
                type="submit"
                disabled={sending || !invite.email.trim()}
                className="px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sending ? 'Sending…' : 'Invite'}
              </button>
            </div>
          </form>
          <p className="text-xs text-gray-500 mt-2">
            Members can use the app under your workspace. Admins can also invite other members.
          </p>
        </div>
      )}

      {/* Loading / error */}
      {loading && (
        <div className="text-center py-10 text-gray-500">
          <RefreshCw className="animate-spin mx-auto mb-2" size={20} />
          Loading team…
        </div>
      )}
      {error && !loading && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Members */}
      {!loading && !error && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Members</h2>
              <span className="text-xs text-gray-500">{data.members.length} total</span>
            </div>
            <ul className="divide-y divide-gray-200">
              {data.members.map((m) => (
                <li key={m.id} className="px-6 py-4 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                    {m.picture_url ? (
                      <img src={m.picture_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <User size={18} className="text-gray-500" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {m.name || m.email || 'Unknown'}
                        {m.is_you && <span className="ml-2 text-xs text-gray-500">(you)</span>}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 truncate">{m.email}</div>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${roleBadgeClass(m.role)}`}>
                    {m.role === 'owner' && <ShieldCheck size={12} />}
                    {ROLE_LABELS[m.role] || m.role}
                  </span>
                  {isOwner && m.role !== 'owner' && (
                    <div className="flex items-center gap-2">
                      <select
                        value={m.role}
                        onChange={(e) => onChangeRole(m, e.target.value)}
                        className="px-2 py-1 border border-gray-300 rounded text-xs bg-white"
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                      <button
                        onClick={() => onRemove(m)}
                        className="p-1.5 text-gray-400 hover:text-red-600"
                        title="Remove member"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )}
                  {!isOwner && canManage && m.role === 'member' && !m.is_you && (
                    <button
                      onClick={() => onRemove(m)}
                      className="p-1.5 text-gray-400 hover:text-red-600"
                      title="Remove member"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </li>
              ))}
              {data.members.length === 0 && (
                <li className="px-6 py-8 text-center text-sm text-gray-500">
                  No members yet — invite someone above.
                </li>
              )}
            </ul>
          </div>

          {/* Pending invitations */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <Mail size={14} /> Pending invitations
              </h2>
              <span className="text-xs text-gray-500">{data.pending_invitations.length}</span>
            </div>
            <ul className="divide-y divide-gray-200">
              {data.pending_invitations.map((inv) => (
                <li key={inv.id} className="px-6 py-4 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{inv.email}</div>
                    <div className="text-xs text-gray-500">
                      Invited by {inv.invited_by_name || 'someone'}
                      {' · '}Expires {new Date(inv.expires_at).toLocaleDateString()}
                    </div>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${roleBadgeClass(inv.role)}`}>
                    {ROLE_LABELS[inv.role] || inv.role}
                  </span>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onCopyLink(inv)}
                        className="p-1.5 text-gray-400 hover:text-primary-600"
                        title="Copy fresh invite link"
                      >
                        {copiedInviteId === inv.id ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
                      </button>
                      <button
                        onClick={() => onResend(inv.id)}
                        className="p-1.5 text-gray-400 hover:text-primary-600"
                        title="Resend email"
                      >
                        <RefreshCw size={16} />
                      </button>
                      <button
                        onClick={() => onRevoke(inv.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600"
                        title="Revoke invitation"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
              {data.pending_invitations.length === 0 && (
                <li className="px-6 py-8 text-center text-sm text-gray-500">
                  No pending invitations.
                </li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
};

export default Team;
