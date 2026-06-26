-- AI Pipeline Tables
-- Stores AI job tracking, generated blog articles, and AI-generated social/GMB post drafts.
-- Safe to re-run: uses IF NOT EXISTS.

-- ============================================================================
-- ai_jobs: tracks every AI generation request (article, review-post, etc.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  kind VARCHAR(64) NOT NULL,                -- e.g. 'article_generation' | 'review_post_generation'
  status VARCHAR(32) NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  model VARCHAR(128),
  prompt TEXT,
  input_json JSONB,
  output_json JSONB,
  result_table VARCHAR(64),                 -- e.g. 'blog_articles' | 'ai_generated_posts'
  result_id UUID,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd NUMERIC(10, 6),
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_user_id ON ai_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_user_kind_created ON ai_jobs(user_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_jobs(status);

-- ============================================================================
-- blog_articles: AI-generated SEO blog drafts
-- ============================================================================
CREATE TABLE IF NOT EXISTS blog_articles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  business_profile_id UUID,
  business_name VARCHAR(255),
  business_type VARCHAR(255),
  service VARCHAR(255),
  city VARCHAR(255),
  keyword VARCHAR(255),
  title TEXT,
  slug VARCHAR(512),
  meta_description TEXT,
  markdown TEXT,
  suggested_excerpt TEXT,
  suggested_social_post TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'draft', -- draft | published | failed
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_articles_user_id ON blog_articles(user_id);
CREATE INDEX IF NOT EXISTS idx_blog_articles_status ON blog_articles(status);
CREATE INDEX IF NOT EXISTS idx_blog_articles_slug ON blog_articles(slug);

-- ============================================================================
-- ai_generated_posts: AI-generated social/GMB post drafts
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_generated_posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  source_type VARCHAR(32) NOT NULL,         -- e.g. 'review'
  source_id VARCHAR(255),                   -- e.g. gmb_reviews.id or review_id
  business_name VARCHAR(255),
  platform_target VARCHAR(32) NOT NULL DEFAULT 'gmb', -- gmb | facebook | instagram | ...
  caption TEXT,
  short_caption TEXT,
  google_business_post TEXT,
  hashtags JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'draft', -- draft | used | failed
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_generated_posts_user_id ON ai_generated_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_generated_posts_source ON ai_generated_posts(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_ai_generated_posts_status ON ai_generated_posts(status);

-- ============================================================================
-- Triggers for updated_at (assumes update_updated_at_column() exists from gmb setup)
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS update_blog_articles_updated_at ON blog_articles;
    CREATE TRIGGER update_blog_articles_updated_at
      BEFORE UPDATE ON blog_articles
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS update_ai_generated_posts_updated_at ON ai_generated_posts;
    CREATE TRIGGER update_ai_generated_posts_updated_at
      BEFORE UPDATE ON ai_generated_posts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================================================
-- RLS: permissive (server-side service-role access; mirrors other tables here)
-- ============================================================================
ALTER TABLE ai_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_generated_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations on ai_jobs" ON ai_jobs;
CREATE POLICY "Allow all operations on ai_jobs" ON ai_jobs FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow all operations on blog_articles" ON blog_articles;
CREATE POLICY "Allow all operations on blog_articles" ON blog_articles FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow all operations on ai_generated_posts" ON ai_generated_posts;
CREATE POLICY "Allow all operations on ai_generated_posts" ON ai_generated_posts FOR ALL USING (true);
