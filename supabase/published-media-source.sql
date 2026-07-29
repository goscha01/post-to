-- Remember the ORIGINAL source URL the user submitted when publishing to
-- FB / IG / GMB, keyed by the provider's returned post ID. Enables "Copy"
-- to re-post at full quality by using the Drive URL we originally sent
-- (instead of the fbcdn / cdninstagram / googleusercontent thumbnail the
-- provider returns when we fetch our own posts back).

CREATE TABLE IF NOT EXISTS published_media_source (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('facebook','instagram','gmb')),
  provider_post_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  drive_file_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, provider, provider_post_id)
);

CREATE INDEX IF NOT EXISTS published_media_source_lookup_idx
  ON published_media_source (user_id, provider, provider_post_id);
