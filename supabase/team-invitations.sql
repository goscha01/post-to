-- Team invitations + memberships for Post To.
--
-- Model: each users.id row is its own workspace root. team_memberships links
-- an "owner" (workspace root) to a "member" (invited teammate). An invited
-- member acts as a second seat on the owner's account — every data route
-- filters by req.user.workspaceOwnerId instead of req.user.userId when the
-- member is viewing the shared workspace.
--
-- Owner's own membership row (owner_user_id = member_user_id, role='owner')
-- is inserted lazily on the first send-invite call.

create table if not exists team_memberships (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references users(id) on delete cascade,
  member_user_id uuid not null references users(id) on delete cascade,
  role           text not null check (role in ('owner','admin','member')),
  joined_at      timestamptz not null default now(),
  unique (owner_user_id, member_user_id)
);
create index if not exists team_memberships_member_idx on team_memberships (member_user_id);

create table if not exists team_invitations (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references users(id) on delete cascade,
  email          text not null,
  name           text,
  role           text not null check (role in ('admin','member')),
  token          uuid not null unique default gen_random_uuid(),
  invited_by     uuid not null references users(id) on delete cascade,
  expires_at     timestamptz not null,
  accepted_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (owner_user_id, email)
);
create index if not exists team_invitations_open_token_idx
  on team_invitations (token) where accepted_at is null;
create index if not exists team_invitations_open_email_idx
  on team_invitations (email) where accepted_at is null;

-- Remembers the last-selected workspace so the switcher persists across
-- browser refreshes. Null = user is viewing their own workspace.
alter table users
  add column if not exists active_workspace_owner_id
    uuid references users(id) on delete set null;
