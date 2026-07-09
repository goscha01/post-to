-- Add connection_id to blog_articles so drafts can be scoped/listed per
-- connected account (e.g. all blogs for a specific website). Nullable to
-- keep existing rows valid. Safe to re-run.

ALTER TABLE blog_articles ADD COLUMN IF NOT EXISTS connection_id UUID;
CREATE INDEX IF NOT EXISTS idx_blog_articles_connection_id ON blog_articles(connection_id);
