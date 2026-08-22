-- blog_publish_targets: per-provider fan-out of a blog article.
--
-- One row per (article, connected_account). Tracks whether the article has
-- been pushed to that specific provider, the live URL the provider assigned
-- to it, retry attempts, and the last error. Independent from the existing
-- S3/hosted-domain fanout in routes/blogs.js#publish — that one lives in
-- blog_domains + deploy triggers and stays untouched.
--
-- The design deliberately keeps the connection metadata out of this table
-- so credential rotation doesn't require row migrations: dispatcher reads
-- connected_accounts fresh on every publish.
--
-- Safe to re-run (uses IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS blog_publish_targets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  article_id UUID NOT NULL,
  connection_id UUID NOT NULL,             -- FK-in-spirit to connected_accounts.id
  provider VARCHAR(32) NOT NULL,           -- snapshot of connected_accounts.provider (avoids join for lists)
  status VARCHAR(32) NOT NULL DEFAULT 'queued', -- queued | publishing | published | failed
  published_url TEXT,                      -- live URL on the provider (when known)
  external_id TEXT,                        -- provider's post id (for future updates/deletes)
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  published_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Dedupe per (article, connection). Republishing to the same target is an
-- UPDATE (bumping attempts + status), never a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_blog_publish_targets_article_connection
  ON blog_publish_targets(article_id, connection_id);

-- Fast lookups: "which articles has this user published?" and "what's the
-- status of this article?"
CREATE INDEX IF NOT EXISTS idx_blog_publish_targets_user_created
  ON blog_publish_targets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_publish_targets_article
  ON blog_publish_targets(article_id);
CREATE INDEX IF NOT EXISTS idx_blog_publish_targets_status
  ON blog_publish_targets(status);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS update_blog_publish_targets_updated_at ON blog_publish_targets;
    CREATE TRIGGER update_blog_publish_targets_updated_at
      BEFORE UPDATE ON blog_publish_targets
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

ALTER TABLE blog_publish_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations on blog_publish_targets" ON blog_publish_targets;
CREATE POLICY "Allow all operations on blog_publish_targets" ON blog_publish_targets FOR ALL USING (true);
