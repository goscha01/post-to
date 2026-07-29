-- Adds hero_image to blog_articles. Stored as a root-relative URL (e.g.
-- "/assets/blog/<slug>-hero.jpg") so the same value works on any of the
-- customer's published domains — the frontmatter emitter passes it through
-- verbatim and the customer's site renders it under their own domain.
--
-- Safe to re-run.

ALTER TABLE blog_articles
  ADD COLUMN IF NOT EXISTS hero_image TEXT;
