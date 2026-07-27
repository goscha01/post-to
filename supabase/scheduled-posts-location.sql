-- Adds GMB routing columns to scheduled_posts so the calendar view can
-- attribute a scheduled item to a specific business location.
-- Idempotent — safe to run repeatedly.

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS gmb_account_id TEXT,
  ADD COLUMN IF NOT EXISTS location_id TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_location_id
  ON scheduled_posts(location_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_gmb_account_id
  ON scheduled_posts(gmb_account_id);
