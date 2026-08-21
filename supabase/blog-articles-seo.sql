-- Adds the SEO layer's persisted state to blog_articles.
--
-- Design intent:
--   * seo_metadata JSONB stores the *last computed* analyzer result. It's a
--     cache — always re-derivable from the article fields — carrying
--     analyzerVersion + contentHash so callers can detect stale data.
--   * tags / search_intent / suggested_internal_links / faq / image_suggestions
--     are structured fields the enhanced prompt now returns. They're stored
--     as normal columns (tags is a text[] because publishers actually use it
--     in YAML frontmatter) so the editor can round-trip them.
--   * hero_alt is a first-class column — the analyzer needs it and the S3
--     publisher already writes hero_image; alt should live next to it, not
--     inside seo_metadata.
--
-- Every column is nullable + defaults so legacy rows load unchanged and the
-- SEO analysis endpoint can compute analysis on demand without a backfill.
--
-- Safe to re-run.

ALTER TABLE blog_articles
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS hero_alt TEXT,
  ADD COLUMN IF NOT EXISTS search_intent VARCHAR(64),
  ADD COLUMN IF NOT EXISTS suggested_internal_links JSONB,
  ADD COLUMN IF NOT EXISTS image_suggestions JSONB,
  ADD COLUMN IF NOT EXISTS faq JSONB,
  ADD COLUMN IF NOT EXISTS seo_metadata JSONB;

-- Composite index for the common list query "give me this user's articles
-- with their SEO status" (the frontend lists green/yellow/red badges).
CREATE INDEX IF NOT EXISTS idx_blog_articles_seo_status
  ON blog_articles (user_id, ((seo_metadata->>'status')));
