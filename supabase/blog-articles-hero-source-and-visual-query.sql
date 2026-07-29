-- Adds two columns to blog_articles that back the "suggest hero image"
-- feature:
--
--   hero_image_source_id  — where the currently-set hero image came from
--     (e.g. "pexels:12345"). Used to dedupe stock-photo picks so the same
--     image doesn't end up on two articles for the same user.
--
--   visual_search_query   — cached image-search query generated from the
--     article title/content by an LLM. The SEO keyword ("spotless homes")
--     is tuned for search rankings, not visual results; the visual query
--     is what you'd type to find an illustrative photo (e.g.
--     "person cleaning window bright home").
--
-- Both nullable, safe to re-run.

ALTER TABLE blog_articles
  ADD COLUMN IF NOT EXISTS hero_image_source_id TEXT,
  ADD COLUMN IF NOT EXISTS visual_search_query  TEXT;
