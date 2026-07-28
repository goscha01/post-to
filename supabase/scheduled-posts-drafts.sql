-- Draft support in scheduled_posts:
--   - 'draft' added to the status CHECK enum
--   - scheduled_time made nullable (drafts have no scheduled time yet)
-- Idempotent, safe to re-run.

ALTER TABLE scheduled_posts
  ALTER COLUMN scheduled_time DROP NOT NULL;

ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_status_check;
ALTER TABLE scheduled_posts
  ADD CONSTRAINT scheduled_posts_status_check
  CHECK (status IN ('draft', 'scheduled', 'processing', 'posted', 'failed', 'cancelled'));

-- Drafts are also queried by status='draft' + user_id — the existing
-- idx_scheduled_posts_user_id + idx_scheduled_posts_status_time cover
-- this, no extra index needed.
