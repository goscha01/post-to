-- Campaign Assistant tables.
--
-- Per-user AI chat sessions scoped to a single Google Ads campaign, with the
-- full report snapshot captured on session creation so the assistant sees the
-- same data on every follow-up turn (and so the report is reproducible even
-- after the underlying Ads/GA4 numbers change).
--
-- Each user turn produces TWO assistant messages (one per provider — openai
-- and claude) so users can compare recommendations side by side.
--
-- Safe to re-run: uses IF NOT EXISTS.

-- ============================================================================
-- campaign_assistant_conversations: one row per chat session
-- ============================================================================
CREATE TABLE IF NOT EXISTS campaign_assistant_conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  title VARCHAR(255),                                 -- auto-set on first user turn
  google_ads_customer_id VARCHAR(64),
  google_ads_login_customer_id VARCHAR(64),
  campaign_id VARCHAR(64),
  campaign_name VARCHAR(255),
  ga4_property_id VARCHAR(64),                        -- web-stream GA4 property
  ga4_app_property_id VARCHAR(64),                    -- Firebase-linked app-stream GA4 property
  openai_ads_connection_id UUID,                      -- optional: connected_accounts.id where provider='openai_ads'
  days INTEGER,                                       -- date-range window used to build report_snapshot
  report_snapshot JSONB,                              -- full optimizationReport JSON captured at conversation start
  report_generated_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ca_conversations_user_id ON campaign_assistant_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_ca_conversations_user_created ON campaign_assistant_conversations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_conversations_campaign ON campaign_assistant_conversations(user_id, google_ads_customer_id, campaign_id);

-- ============================================================================
-- campaign_assistant_messages: many rows per conversation
-- ============================================================================
-- role: 'user' | 'assistant'
-- provider: 'openai' | 'claude' | NULL  (NULL only when role='user')
-- rating: -1 (down) | 1 (up) | NULL (unrated)
CREATE TABLE IF NOT EXISTS campaign_assistant_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES campaign_assistant_conversations(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,                        -- 0-based order across the conversation
  role VARCHAR(16) NOT NULL,                          -- 'user' | 'assistant'
  provider VARCHAR(16),                               -- 'openai' | 'claude' | NULL
  model VARCHAR(128),
  content TEXT NOT NULL,
  status VARCHAR(16) DEFAULT 'complete',              -- 'streaming' | 'complete' | 'failed'
  error TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cache_read_tokens INTEGER,                          -- prompt-cache hit tokens (both providers)
  cache_write_tokens INTEGER,                         -- prompt-cache write tokens (claude only)
  cost_usd NUMERIC(10, 6),
  rating SMALLINT,                                    -- -1 | 1 | NULL
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ca_messages_conversation ON campaign_assistant_messages(conversation_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_ca_messages_created ON campaign_assistant_messages(created_at);

-- ============================================================================
-- updated_at trigger
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS update_ca_conversations_updated_at ON campaign_assistant_conversations;
    CREATE TRIGGER update_ca_conversations_updated_at
      BEFORE UPDATE ON campaign_assistant_conversations
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================================================
-- RLS: permissive (server uses service role; mirrors ai_jobs / blog_articles)
-- ============================================================================
ALTER TABLE campaign_assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assistant_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations on campaign_assistant_conversations" ON campaign_assistant_conversations;
CREATE POLICY "Allow all operations on campaign_assistant_conversations"
  ON campaign_assistant_conversations FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow all operations on campaign_assistant_messages" ON campaign_assistant_messages;
CREATE POLICY "Allow all operations on campaign_assistant_messages"
  ON campaign_assistant_messages FOR ALL USING (true);
