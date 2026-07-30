-- Automation rules + run audit log.
--
-- automation_rules: user-defined "generate + publish X on cadence Y" rules.
--   kind='blog'         → generate an article, optionally publish to verified blog domains
--   kind='social_post'  → generate a caption (+ optional AI image), publish to GMB/FB/IG targets
--
-- automation_runs: one row per scheduler tick that ran a rule.
--
-- Idempotent — safe to re-run. No FKs (keeps parity with ai_pipeline-tables.sql
-- which uses plain user_id UUID to dodge the users vs auth.users ambiguity).

CREATE TABLE IF NOT EXISTS automation_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  kind VARCHAR(32) NOT NULL,                          -- 'blog' | 'social_post'

  -- Cadence: { frequency: 'daily'|'weekly'|'monthly',
  --           day_of_week: 0..6 (Sun=0, weekly only),
  --           day_of_month: 1..28 (monthly only),
  --           time_of_day: 'HH:MM' (UTC),
  --           timezone_offset_minutes: int (optional, default 0 = UTC) }
  cadence JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Targets: array of publish destinations.
  --   [{ type: 'gmb', accountPath: 'accounts/X/locations/Y', label: '...' },
  --    { type: 'facebook', connectionId: '<uuid>', label: '...' },
  --    { type: 'instagram', connectionId: '<uuid>', label: '@handle' },
  --    { type: 'blog' }]   ← blog publishes to all user's verified S3 blog_domain rows
  targets JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Topic selection.
  --   'ai_pick'    → LLM picks a topic from business context each run
  --   'topic_list' → round-robin through `topics` (advances topic_cursor)
  topic_source VARCHAR(32) NOT NULL DEFAULT 'ai_pick',
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  topic_cursor INTEGER NOT NULL DEFAULT 0,

  -- Image generation for social posts.
  --   'ai_generate' → OpenAI Images (gpt-image-1), uploaded to Supabase storage
  --   'fixed'       → reuse fixed_image_url for every generated post
  --   'none'        → no image (text-only post; skips IG which requires one)
  image_source VARCHAR(32) NOT NULL DEFAULT 'none',
  image_prompt_template TEXT,
  fixed_image_url TEXT,

  -- Business context passed into the LLM prompts (businessName, businessType,
  -- city, tone, service, keyword, targetAudience — all optional).
  business_context JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- If false, run generates the draft only and stops (safer default so a
  -- misconfigured rule can't spam a real profile).
  auto_publish BOOLEAN NOT NULL DEFAULT false,

  active BOOLEAN NOT NULL DEFAULT true,

  -- Scheduler race protection: 'idle' | 'running'. Claim by conditional UPDATE.
  status VARCHAR(16) NOT NULL DEFAULT 'idle',

  next_run_at TIMESTAMP WITH TIME ZONE,
  last_run_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_user_id ON automation_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_due ON automation_rules(active, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_automation_rules_kind ON automation_rules(kind);


CREATE TABLE IF NOT EXISTS automation_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_id UUID NOT NULL,
  user_id UUID NOT NULL,
  kind VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running', -- running | ok | failed | partial | skipped
  trigger VARCHAR(32) NOT NULL DEFAULT 'schedule', -- schedule | test | manual

  -- References to generated content (blog_articles.id, ai_generated_posts.id).
  generated_ids JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Per-target publish outcomes: [{ target, ok, error?, publishedId? }]
  publish_results JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Chosen topic / prompt for audit.
  topic TEXT,
  image_url TEXT,

  error TEXT,
  notes TEXT,

  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_rule_id ON automation_runs(rule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_user_id ON automation_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status);


-- updated_at trigger (reuses shared function from gmb setup).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS update_automation_rules_updated_at ON automation_rules;
    CREATE TRIGGER update_automation_rules_updated_at
      BEFORE UPDATE ON automation_rules
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;


-- RLS: permissive (server-side service-role access; mirrors ai_pipeline-tables.sql).
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations on automation_rules" ON automation_rules;
CREATE POLICY "Allow all operations on automation_rules" ON automation_rules FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow all operations on automation_runs" ON automation_runs;
CREATE POLICY "Allow all operations on automation_runs" ON automation_runs FOR ALL USING (true);


-- Public storage bucket for AI-generated images. Meta/GMB fetch images from
-- the URL we send them, so the bucket must be public (no signed URLs — those
-- expire and confuse the platforms). Idempotent.
INSERT INTO storage.buckets (id, name, public)
VALUES ('automation-images', 'automation-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Permissive storage policies (service-role writes; public reads). Object
-- naming includes the user_id prefix so cross-user reads via the public URL
-- are still discoverable only if you know the exact path.
DROP POLICY IF EXISTS "automation-images public read" ON storage.objects;
CREATE POLICY "automation-images public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'automation-images');

DROP POLICY IF EXISTS "automation-images service write" ON storage.objects;
CREATE POLICY "automation-images service write"
  ON storage.objects FOR ALL
  USING (bucket_id = 'automation-images')
  WITH CHECK (bucket_id = 'automation-images');
