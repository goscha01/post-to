-- Adds GMB post metadata to scheduled_posts so the publisher worker has
-- everything it needs to POST to Google My Business at scheduled_time.
-- Idempotent — safe to run repeatedly.

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS post_type TEXT DEFAULT 'UPDATE',
  ADD COLUMN IF NOT EXISTS call_to_action JSONB,
  ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Widen the status CHECK constraint to include 'processing' (worker-held)
-- and 'posted' already exists. Recreate the constraint to include it.
ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_status_check;
ALTER TABLE scheduled_posts
  ADD CONSTRAINT scheduled_posts_status_check
  CHECK (status IN ('scheduled', 'processing', 'posted', 'failed', 'cancelled'));

-- Compound index that the worker queries against.
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status_time
  ON scheduled_posts(status, scheduled_time);
