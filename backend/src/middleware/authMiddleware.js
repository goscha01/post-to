const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client with service-role key so the per-request
// team_memberships re-check isn't blocked by RLS. If anon-role is used, RLS
// returns an empty result for workspace-member reads, and the middleware
// mistakes a legitimate membership for a revoked one — silently clearing
// users.active_workspace_owner_id and bouncing an invited teammate back to
// their own (empty) workspace on every request. Falls back to anon-key for
// local dev where SERVICE_ROLE_KEY may be unset.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const authMiddleware = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if user exists in database
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, google_id, access_token, active_workspace_owner_id')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // NOTE: Do not gate on `users.access_token` here. It's the initial Google
    // OAuth access_token from signup — short-lived, never renewed by
    // /auth/refresh (which only rotates business_access_token), and never
    // read by any route (grep confirms zero req.user.accessToken usage).
    // Gating on it caused a 401 → refresh-fails → logout() cycle for any
    // user whose Google session went stale, including users trying to use
    // features (ASC, Meta Ads, etc.) that have no relation to Google OAuth.
    // JWT validity above is the real auth artifact.

    // Resolve the workspace the caller is acting inside. Preference order:
    //   1. active_workspace_owner_id on the users row (set by /api/team on
    //      accept + /workspaces/switch). Persists across sessions.
    //   2. workspaceOwnerId claim in the JWT (freshly-minted token from
    //      /invite/accept or /workspaces/switch — usable before the FE
    //      round-trips to refresh state).
    //   3. Fallback to the caller's own userId (solo user).
    //
    // Membership re-check: if the caller was viewing a shared workspace but
    // has since been removed from it, drop back to their own workspace so
    // requests don't 500 on stale-membership.
    let workspaceOwnerId = user.active_workspace_owner_id || decoded.workspaceOwnerId || user.id;
    if (workspaceOwnerId !== user.id) {
      const { data: membership } = await supabase
        .from('team_memberships')
        .select('id')
        .eq('owner_user_id', workspaceOwnerId)
        .eq('member_user_id', user.id)
        .maybeSingle();
      if (!membership) {
        workspaceOwnerId = user.id;
        // Clear the stale pointer so subsequent requests skip this check.
        // Best-effort: don't await the result.
        supabase.from('users')
          .update({ active_workspace_owner_id: null })
          .eq('id', user.id)
          .then(() => {}, () => {});
      }
    }

    // Add user info to request
    req.user = {
      userId: user.id,
      email: user.email,
      googleId: user.google_id,
      accessToken: user.access_token,
      workspaceOwnerId,
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    } else {
      return res.status(500).json({ error: 'Authentication failed' });
    }
  }
};

module.exports = authMiddleware;