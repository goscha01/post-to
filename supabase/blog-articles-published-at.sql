-- Adds published_at to blog_articles so the publish endpoint can stamp a
-- timestamp separate from updated_at. The blogs-serve renderer prefers
-- published_at for datePublished / sitemap lastmod and falls back to
-- updated_at / created_at when null.
--
-- Safe to re-run (IF NOT EXISTS on the column + index).

ALTER TABLE blog_articles
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_blog_articles_published_at
  ON blog_articles(user_id, status, published_at DESC);
