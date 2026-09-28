// Single source of truth for "which user_id owns the data this request touches."
//
// Post To's single-seat model has been extended to allow team invitations
// (see supabase/team-invitations.sql). An invited teammate can act as a
// second seat on the workspace owner's account. In that case req.user.userId
// is the acting teammate's identity — the row filter still needs to be the
// owner's id. authMiddleware attaches req.user.workspaceOwnerId (the active
// workspace); this helper returns it, falling back to userId for solo users
// or routes that haven't been swept yet.
//
// Convention for callers:
//   - use getWorkspaceOwnerId(req) for `.eq('user_id', ...)` DATA filters
//   - keep req.user.userId for IDENTITY (created_by, updated_by, audit logs)

function getWorkspaceOwnerId(req) {
  return req.user?.workspaceOwnerId || req.user?.userId;
}

module.exports = { getWorkspaceOwnerId };
