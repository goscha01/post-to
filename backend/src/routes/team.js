// Team invitations + membership management.
//
// Model (see supabase/team-invitations.sql):
//   - Each users.id row is its own workspace root. team_memberships links an
//     owner to a member (with role). Owner's own row is inserted lazily on
//     the first invite send.
//   - team_invitations holds pending tokens. Upsert on (owner_user_id, email);
//     resend rotates token + expires_at.
//   - Accepting an invite sets active_workspace_owner_id on the accepting user
//     so they drop straight into the shared workspace on the next request.
//
// Auth: all routes except /invite/preview require a JWT. Owner-only actions
// (role change) additionally check membership role.

const express = require('express');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const { sendInviteEmail } = require('../services/emailService');
const logger = require('../utils/logger');

const router = express.Router();
// Use service-role key so upserts/reads bypass RLS — same pattern as gmb.js,
// calendar.js, etc. Falls back to anon-key locally if the role key isn't set.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const VALID_ROLES = ['owner', 'admin', 'member'];
const INVITE_ROLES = ['admin', 'member']; // Cannot invite as owner

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Returns { role, owner_user_id } for the CALLER inside their currently-active
// workspace, or null when the caller has no membership yet (solo user who has
// never invited anyone). We treat "no membership row" as implicit owner of
// their own workspace — solo users can still POST /invite (which lazily
// inserts the owner row), but read endpoints just return their own data.
async function getCallerRoleInActiveWorkspace(req) {
  const userId = req.user.userId;
  const ownerId = req.user.workspaceOwnerId || userId;
  const { data, error } = await supabase
    .from('team_memberships')
    .select('role, owner_user_id')
    .eq('owner_user_id', ownerId)
    .eq('member_user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;
  // No row. If caller is looking at their own workspace, treat as implicit
  // owner; otherwise they don't belong here.
  if (ownerId === userId) return { role: 'owner', owner_user_id: userId };
  return null;
}

// Owner row is lazily inserted the first time someone invites a teammate.
async function ensureOwnerMembership(userId) {
  const { error } = await supabase
    .from('team_memberships')
    .upsert(
      { owner_user_id: userId, member_user_id: userId, role: 'owner' },
      { onConflict: 'owner_user_id,member_user_id', ignoreDuplicates: true }
    );
  if (error) throw error;
}

async function loadUserSummary(userId) {
  const { data } = await supabase
    .from('users')
    .select('id, email, name, picture_url')
    .eq('id', userId)
    .maybeSingle();
  return data || null;
}

// Sign a fresh JWT for the caller with an updated workspaceOwnerId. Used by
// /workspaces/switch and the invite/accept endpoint so the client can drop
// straight into the new workspace without a full re-login.
function signJwt({ user, workspaceOwnerId }) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      googleId: user.google_id,
      name: user.name,
      picture_url: user.picture_url,
      has_business_access: user.has_business_access || false,
      workspaceOwnerId,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ---------------------------------------------------------------------------
// GET /api/team/members
// Lists the caller's active workspace: members + pending invitations.
// ---------------------------------------------------------------------------
router.get('/members', authMiddleware, async (req, res) => {
  try {
    const callerMembership = await getCallerRoleInActiveWorkspace(req);
    if (!callerMembership) return res.status(403).json({ error: 'Not a member of this workspace' });
    const ownerId = callerMembership.owner_user_id;

    const [{ data: memberships, error: mErr }, { data: invites, error: iErr }] = await Promise.all([
      supabase
        .from('team_memberships')
        .select('id, member_user_id, role, joined_at')
        .eq('owner_user_id', ownerId)
        .order('joined_at', { ascending: true }),
      supabase
        .from('team_invitations')
        .select('id, email, name, role, invited_by, expires_at, created_at')
        .eq('owner_user_id', ownerId)
        .is('accepted_at', null)
        .order('created_at', { ascending: false }),
    ]);
    if (mErr) throw mErr;
    if (iErr) throw iErr;

    // Enrich with user rows in a single query.
    const userIds = Array.from(new Set([
      ...memberships.map(m => m.member_user_id),
      ...invites.map(i => i.invited_by),
    ]));
    let userMap = new Map();
    if (userIds.length > 0) {
      const { data: users, error: uErr } = await supabase
        .from('users')
        .select('id, email, name, picture_url')
        .in('id', userIds);
      if (uErr) throw uErr;
      userMap = new Map(users.map(u => [u.id, u]));
    }

    const members = memberships.map(m => {
      const u = userMap.get(m.member_user_id) || {};
      return {
        id: m.id,
        user_id: m.member_user_id,
        email: u.email || null,
        name: u.name || null,
        picture_url: u.picture_url || null,
        role: m.role,
        joined_at: m.joined_at,
        is_you: m.member_user_id === req.user.userId,
      };
    });
    const pending = invites.map(i => {
      const invitedBy = userMap.get(i.invited_by) || {};
      return {
        id: i.id,
        email: i.email,
        name: i.name,
        role: i.role,
        invited_by_name: invitedBy.name || invitedBy.email || null,
        expires_at: i.expires_at,
        created_at: i.created_at,
      };
    });

    res.json({
      workspace_owner_id: ownerId,
      your_role: callerMembership.role,
      members,
      pending_invitations: pending,
    });
  } catch (err) {
    logger.error('team.members_list_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to load team' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/team/invite
// Body: { email, role: 'admin'|'member', name? }
// ---------------------------------------------------------------------------
router.post('/invite', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const rawEmail = req.body?.email;
    const role = req.body?.role || 'member';
    const name = req.body?.name ? String(req.body.name).trim() : null;

    if (!rawEmail || typeof rawEmail !== 'string') return res.status(400).json({ error: 'email is required' });
    if (!INVITE_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${INVITE_ROLES.join(', ')}` });

    const email = normalizeEmail(rawEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

    // Lazily seed owner membership so solo users can send their first invite.
    await ensureOwnerMembership(userId);

    const caller = await getCallerRoleInActiveWorkspace(req);
    if (!caller) return res.status(403).json({ error: 'Not a member of this workspace' });
    const ownerId = caller.owner_user_id;

    // Only owner + admin can invite; admin can only invite members.
    if (caller.role === 'member') return res.status(403).json({ error: 'Only owner or admin can invite' });
    if (caller.role === 'admin' && role === 'admin') return res.status(403).json({ error: 'Admins can only invite members' });

    // Reject if already a member.
    const { data: existingUser } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existingUser) {
      const { data: existingMembership } = await supabase
        .from('team_memberships')
        .select('id')
        .eq('owner_user_id', ownerId)
        .eq('member_user_id', existingUser.id)
        .maybeSingle();
      if (existingMembership) return res.status(400).json({ error: 'User is already a member' });
    }

    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    const { data: invitation, error: upsertErr } = await supabase
      .from('team_invitations')
      .upsert(
        {
          owner_user_id: ownerId,
          email,
          name,
          role,
          invited_by: userId,
          expires_at: expiresAt,
          accepted_at: null,
        },
        { onConflict: 'owner_user_id,email' }
      )
      .select('id, token, email, role, expires_at')
      .single();
    if (upsertErr) throw upsertErr;

    const [inviter, owner] = await Promise.all([
      loadUserSummary(userId),
      loadUserSummary(ownerId),
    ]);
    const inviterName = inviter?.name?.trim() || inviter?.email || 'A teammate';
    const ownerName = owner?.name?.trim() || owner?.email || 'their';
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const inviteLink = `${frontendUrl}/invite/accept?token=${invitation.token}`;
    const roleLabel = role === 'admin' ? 'Admin' : 'Member';

    const emailSent = await sendInviteEmail({
      to: email,
      inviterName,
      ownerName,
      roleLabel,
      inviteLink,
    });

    logger.info('team.invite_created', {
      workspace_owner_id: ownerId,
      invited_by: userId,
      email,
      role,
      email_sent: emailSent,
    });

    res.json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expires_at: invitation.expires_at,
      },
      invite_link: inviteLink,
      email_sent: emailSent,
    });
  } catch (err) {
    logger.error('team.invite_failed', {
      error: err.message,
      code: err.code,
      details: err.details,
      hint: err.hint,
      stack: err.stack?.slice(0, 800),
    });
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/team/invite/:id/resend — rotate token + expiry, resend email.
// ---------------------------------------------------------------------------
router.post('/invite/:id/resend', authMiddleware, async (req, res) => {
  try {
    const inviteId = req.params.id;
    const caller = await getCallerRoleInActiveWorkspace(req);
    if (!caller || !['owner', 'admin'].includes(caller.role)) {
      return res.status(403).json({ error: 'Only owner or admin can resend' });
    }
    const ownerId = caller.owner_user_id;

    // Fetch + verify scope.
    const { data: invite, error: fetchErr } = await supabase
      .from('team_invitations')
      .select('id, email, role, owner_user_id, accepted_at')
      .eq('id', inviteId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!invite || invite.owner_user_id !== ownerId) return res.status(404).json({ error: 'Invitation not found' });
    if (invite.accepted_at) return res.status(400).json({ error: 'Invitation already accepted' });

    // Rotate token + expiry. Uses gen_random_uuid() default for a fresh token.
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    // Supabase-js doesn't expose a SQL DEFAULT trick — generate a UUID in-app.
    const { randomUUID } = require('crypto');
    const newToken = randomUUID();
    const { data: updated, error: updErr } = await supabase
      .from('team_invitations')
      .update({ token: newToken, expires_at: expiresAt })
      .eq('id', inviteId)
      .select('id, token, email, role, expires_at')
      .single();
    if (updErr) throw updErr;

    const [inviter, owner] = await Promise.all([
      loadUserSummary(req.user.userId),
      loadUserSummary(ownerId),
    ]);
    const inviterName = inviter?.name?.trim() || inviter?.email || 'A teammate';
    const ownerName = owner?.name?.trim() || owner?.email || 'their';
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const inviteLink = `${frontendUrl}/invite/accept?token=${updated.token}`;
    const roleLabel = updated.role === 'admin' ? 'Admin' : 'Member';
    const emailSent = await sendInviteEmail({
      to: updated.email, inviterName, ownerName, roleLabel, inviteLink,
    });

    logger.info('team.invite_resent', {
      workspace_owner_id: ownerId,
      email: updated.email,
      email_sent: emailSent,
    });
    res.json({ invite_link: inviteLink, email_sent: emailSent, expires_at: updated.expires_at });
  } catch (err) {
    logger.error('team.invite_resend_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/team/invite/:id — revoke a pending invite.
// ---------------------------------------------------------------------------
router.delete('/invite/:id', authMiddleware, async (req, res) => {
  try {
    const caller = await getCallerRoleInActiveWorkspace(req);
    if (!caller || !['owner', 'admin'].includes(caller.role)) {
      return res.status(403).json({ error: 'Only owner or admin can revoke' });
    }
    const { error, count } = await supabase
      .from('team_invitations')
      .delete({ count: 'exact' })
      .eq('id', req.params.id)
      .eq('owner_user_id', caller.owner_user_id);
    if (error) throw error;
    if (!count) return res.status(404).json({ error: 'Invitation not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error('team.invite_revoke_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to revoke invitation' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/team/members/:memberId/role — owner only.
// :memberId is the team_memberships.id row (not user id).
// ---------------------------------------------------------------------------
router.patch('/members/:memberId/role', authMiddleware, async (req, res) => {
  try {
    const role = req.body?.role;
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${VALID_ROLES.join(', ')}` });

    const caller = await getCallerRoleInActiveWorkspace(req);
    if (!caller || caller.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change roles' });

    const { data: target, error: fErr } = await supabase
      .from('team_memberships')
      .select('id, owner_user_id, member_user_id, role')
      .eq('id', req.params.memberId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!target || target.owner_user_id !== caller.owner_user_id) {
      return res.status(404).json({ error: 'Member not found' });
    }
    // Owner cannot demote themselves via this endpoint (would strand the workspace).
    if (target.member_user_id === caller.owner_user_id && role !== 'owner') {
      return res.status(400).json({ error: 'Owner cannot change their own role' });
    }
    // No dual-owner: promoting someone to owner is a separate transfer flow — not implemented yet.
    if (role === 'owner') return res.status(400).json({ error: 'Owner transfer is not supported yet' });

    const { error: uErr } = await supabase.from('team_memberships').update({ role }).eq('id', target.id);
    if (uErr) throw uErr;
    logger.info('team.member_role_changed', {
      workspace_owner_id: caller.owner_user_id, member_id: target.member_user_id, new_role: role,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error('team.member_role_change_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to change role' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/team/members/:memberId — remove a member from the workspace.
// Owner + admin can remove. Owner cannot remove themselves.
// ---------------------------------------------------------------------------
router.delete('/members/:memberId', authMiddleware, async (req, res) => {
  try {
    const caller = await getCallerRoleInActiveWorkspace(req);
    if (!caller || !['owner', 'admin'].includes(caller.role)) {
      return res.status(403).json({ error: 'Only owner or admin can remove members' });
    }
    const { data: target, error: fErr } = await supabase
      .from('team_memberships')
      .select('id, owner_user_id, member_user_id, role')
      .eq('id', req.params.memberId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!target || target.owner_user_id !== caller.owner_user_id) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (target.member_user_id === caller.owner_user_id) {
      return res.status(400).json({ error: 'Owner cannot remove themselves' });
    }
    // Admin cannot remove another admin/owner.
    if (caller.role === 'admin' && target.role !== 'member') {
      return res.status(403).json({ error: 'Admins can only remove members' });
    }
    const { error: dErr } = await supabase.from('team_memberships').delete().eq('id', target.id);
    if (dErr) throw dErr;

    // If the removed member had this workspace as their active one, clear it
    // so their next request falls back to their own workspace.
    await supabase
      .from('users')
      .update({ active_workspace_owner_id: null })
      .eq('id', target.member_user_id)
      .eq('active_workspace_owner_id', caller.owner_user_id);

    logger.info('team.member_removed', {
      workspace_owner_id: caller.owner_user_id, member_id: target.member_user_id,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error('team.member_remove_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/team/invite/preview?token=…  (PUBLIC — used by /invite/accept page)
// ---------------------------------------------------------------------------
router.get('/invite/preview', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const { data: invite, error: fErr } = await supabase
      .from('team_invitations')
      .select('email, name, role, expires_at, accepted_at, owner_user_id, invited_by')
      .eq('token', token)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });
    if (invite.accepted_at) return res.status(400).json({ error: 'Invitation already accepted' });
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'Invitation has expired' });

    const [owner, inviter] = await Promise.all([
      loadUserSummary(invite.owner_user_id),
      loadUserSummary(invite.invited_by),
    ]);
    res.json({
      email: invite.email,
      name: invite.name,
      role: invite.role,
      owner_name: owner?.name?.trim() || owner?.email || 'their',
      owner_email: owner?.email || null,
      inviter_name: inviter?.name?.trim() || inviter?.email || null,
      expires_at: invite.expires_at,
    });
  } catch (err) {
    logger.error('team.invite_preview_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to preview invitation' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/team/invite/accept  (JWT required)
// Body: { token }
// Returns a fresh JWT with workspaceOwnerId set to the inviter's workspace.
// ---------------------------------------------------------------------------
router.post('/invite/accept', authMiddleware, async (req, res) => {
  try {
    const token = req.body?.token;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const { data: invite, error: fErr } = await supabase
      .from('team_invitations')
      .select('id, email, name, role, expires_at, accepted_at, owner_user_id')
      .eq('token', token)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });
    if (invite.accepted_at) return res.status(400).json({ error: 'Invitation already accepted' });
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'Invitation has expired' });

    // Verify email match (case-insensitive).
    const { data: user, error: uErr } = await supabase
      .from('users')
      .select('id, email, name, google_id, picture_url, has_business_access')
      .eq('id', req.user.userId)
      .maybeSingle();
    if (uErr) throw uErr;
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
      return res.status(403).json({ error: 'This invitation was sent to a different email address' });
    }

    // Ensure the owner has an implicit owner-membership (in case the invite
    // came from a still-solo owner whose team_memberships row hasn't seeded
    // yet — belt-and-braces since /invite also does this).
    await ensureOwnerMembership(invite.owner_user_id);

    // Create membership (idempotent).
    const { error: mErr } = await supabase
      .from('team_memberships')
      .upsert(
        {
          owner_user_id: invite.owner_user_id,
          member_user_id: user.id,
          role: invite.role,
        },
        { onConflict: 'owner_user_id,member_user_id', ignoreDuplicates: false }
      );
    if (mErr) throw mErr;

    // Copy invite.name → user.name if the accepter doesn't have one.
    if (invite.name && (!user.name || !user.name.trim())) {
      await supabase.from('users').update({ name: invite.name }).eq('id', user.id);
      user.name = invite.name;
    }

    // Drop the accepter straight into the shared workspace.
    await supabase
      .from('users')
      .update({ active_workspace_owner_id: invite.owner_user_id })
      .eq('id', user.id);

    // Mark invite accepted.
    await supabase
      .from('team_invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id);

    logger.info('team.invite_accepted', {
      workspace_owner_id: invite.owner_user_id,
      member_id: user.id,
      role: invite.role,
    });

    // Issue a fresh JWT so the client immediately acts under the new workspace.
    const newJwt = signJwt({ user, workspaceOwnerId: invite.owner_user_id });
    res.json({ ok: true, token: newJwt, workspace_owner_id: invite.owner_user_id });
  } catch (err) {
    logger.error('team.invite_accept_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/team/workspaces
// Lists workspaces the caller can act in: own + every accepted membership.
// ---------------------------------------------------------------------------
router.get('/workspaces', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data: memberships, error: mErr } = await supabase
      .from('team_memberships')
      .select('owner_user_id, role')
      .eq('member_user_id', userId);
    if (mErr) throw mErr;

    // Always include the caller's own workspace, even if they don't yet have
    // an explicit membership row (solo users).
    const ownerIds = new Set(memberships.map(m => m.owner_user_id));
    ownerIds.add(userId);

    const { data: users, error: uErr } = await supabase
      .from('users')
      .select('id, email, name, picture_url')
      .in('id', Array.from(ownerIds));
    if (uErr) throw uErr;
    const userMap = new Map(users.map(u => [u.id, u]));

    const workspaces = Array.from(ownerIds).map(id => {
      const owner = userMap.get(id) || {};
      const membership = memberships.find(m => m.owner_user_id === id);
      const roleForCaller = id === userId ? 'owner' : (membership?.role || 'member');
      return {
        owner_user_id: id,
        owner_name: owner.name || owner.email || 'Workspace',
        owner_email: owner.email || null,
        owner_picture_url: owner.picture_url || null,
        role: roleForCaller,
        is_own: id === userId,
        is_active: id === (req.user.workspaceOwnerId || userId),
      };
    });

    res.json({ workspaces });
  } catch (err) {
    logger.error('team.workspaces_list_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/team/workspaces/switch
// Body: { owner_user_id }
// Returns a fresh JWT with workspaceOwnerId set to the requested workspace.
// ---------------------------------------------------------------------------
router.post('/workspaces/switch', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const targetOwnerId = req.body?.owner_user_id;
    if (!targetOwnerId) return res.status(400).json({ error: 'owner_user_id is required' });

    // Allowed if targetOwnerId === userId (own workspace) OR caller has an
    // accepted membership in the target workspace.
    if (targetOwnerId !== userId) {
      const { data: membership, error } = await supabase
        .from('team_memberships')
        .select('role')
        .eq('owner_user_id', targetOwnerId)
        .eq('member_user_id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!membership) return res.status(403).json({ error: 'You are not a member of that workspace' });
    }

    await supabase
      .from('users')
      .update({ active_workspace_owner_id: targetOwnerId === userId ? null : targetOwnerId })
      .eq('id', userId);

    const { data: user, error: uErr } = await supabase
      .from('users')
      .select('id, email, name, google_id, picture_url, has_business_access')
      .eq('id', userId)
      .single();
    if (uErr) throw uErr;

    const newJwt = signJwt({ user, workspaceOwnerId: targetOwnerId });
    logger.info('team.workspace_switched', { user_id: userId, target_owner_id: targetOwnerId });
    res.json({ ok: true, token: newJwt, workspace_owner_id: targetOwnerId });
  } catch (err) {
    logger.error('team.workspace_switch_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to switch workspace' });
  }
});

module.exports = router;
