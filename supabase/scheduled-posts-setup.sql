-- Full setup for the scheduled_posts table + the columns the calendar
-- scheduling engine needs. Self-contained and idempotent — safe to run
-- even if scheduled-posts-location.sql or scheduled-posts-schedule-fields.sql
-- were partially applied.

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  content TEXT NOT NULL,
  media JSONB DEFAULT '[]'::JSONB,
  platforms TEXT[] NOT NULL DEFAULT ARRAY['google']::TEXT[],
  scheduled_time TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'scheduled',
  posted_at TIMESTAMPTZ,
  results JSONB DEFAULT '[]'::JSONB,
  error TEXT,
  gmb_account_id TEXT,
  location_id TEXT,
  post_type TEXT DEFAULT 'UPDATE',
  call_to_action JSONB,
  attempts INT DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Additive columns — no-op if the table was already created by an earlier
-- migration.
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS gmb_account_id TEXT,
  ADD COLUMN IF NOT EXISTS location_id TEXT,
  ADD COLUMN IF NOT EXISTS post_type TEXT DEFAULT 'UPDATE',
  ADD COLUMN IF NOT EXISTS call_to_action JSONB,
  ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Status CHECK — recreate to include every value the code uses.
ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_status_check;
ALTER TABLE scheduled_posts
  ADD CONSTRAINT scheduled_posts_status_check
  CHECK (status IN ('scheduled', 'processing', 'posted', 'failed', 'cancelled'));

-- Indexes.
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_user_id
  ON scheduled_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_scheduled_time
  ON scheduled_posts(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status_time
  ON scheduled_posts(status, scheduled_time);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_location_id
  ON scheduled_posts(location_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_gmb_account_id
  ON scheduled_posts(gmb_account_id);

-- updated_at trigger (reuses the function from the base social-media-schema
-- if present, otherwise creates it).
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_scheduled_posts_updated_at ON scheduled_posts;
CREATE TRIGGER update_scheduled_posts_updated_at
  BEFORE UPDATE ON scheduled_posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
