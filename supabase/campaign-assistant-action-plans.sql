-- Campaign Assistant — Action Plans + Plan Steps.
--
-- After a user has discussed a campaign with the assistant (main chat +
-- per-card Ask/Steps threads), clicking "Finalize plan" sends the whole
-- transcript to one model (default Claude) with a JSON-schema prompt.
-- The model returns a merged, deduped, dependency-ordered list of
-- concrete actions. Each action is tagged so the UI can offer the right
-- affordance:
--   google_ads_action → future "Apply to Google Ads" button
--   app_code_change   → developer task, copy-instructions button
--   product_change    → human task, notes-only
--   observation       → check-in, notes-only
--   schedule          → future cron/reminder integration
--
-- Steps carry a `status` that lets users check items off manually as
-- they work through the plan (pending → done | skipped | applied |
-- failed). The `applied` status is reserved for actions executed by the
-- backend on the user's behalf (not implemented in this migration —
-- shell only).
--
-- Safe to re-run: IF NOT EXISTS everywhere.

-- ============================================================================
-- campaign_assistant_action_plans
-- ============================================================================
CREATE TABLE IF NOT EXISTS campaign_assistant_action_plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES campaign_assistant_conversations(id) ON DELETE CASCADE,
  title VARCHAR(255),
  summary TEXT,
  generated_by VARCHAR(16),                          -- 'openai' | 'claude'
  model VARCHAR(128),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd NUMERIC(10, 6),
  raw_response TEXT,                                 -- unparsed model output for audit / re-parse
  status VARCHAR(16) DEFAULT 'active',               -- active | archived
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ca_action_plans_conversation
  ON campaign_assistant_action_plans(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_action_plans_user
  ON campaign_assistant_action_plans(user_id, created_at DESC);

-- ============================================================================
-- campaign_assistant_action_plan_steps
-- ============================================================================
CREATE TABLE IF NOT EXISTS campaign_assistant_action_plan_steps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES campaign_assistant_action_plans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,                         -- 0-based order within the plan
  title VARCHAR(500) NOT NULL,
  description TEXT,
  type VARCHAR(32) NOT NULL,                         -- see header comment
  action_type VARCHAR(64),                           -- e.g. 'set_primary_conversion_action', 'add_negative_keywords'
  action_params JSONB,                               -- inputs for future Apply implementation
  priority VARCHAR(16),                              -- high | medium | low
  effort VARCHAR(32),                                -- '5min' | '1h' | 'developer-1d' | etc.
  status VARCHAR(16) DEFAULT 'pending',              -- pending | done | skipped | applied | failed
  notes TEXT,                                        -- user notes accumulated as they work through the step
  applied_at TIMESTAMP WITH TIME ZONE,               -- set when status transitions to 'applied'
  applied_error TEXT,                                -- populated on 'failed' status
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ca_plan_steps_plan
  ON campaign_assistant_action_plan_steps(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_ca_plan_steps_status
  ON campaign_assistant_action_plan_steps(plan_id, status);

-- ============================================================================
-- updated_at trigger
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS update_ca_action_plans_updated_at ON campaign_assistant_action_plans;
    CREATE TRIGGER update_ca_action_plans_updated_at
      BEFORE UPDATE ON campaign_assistant_action_plans
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS update_ca_plan_steps_updated_at ON campaign_assistant_action_plan_steps;
    CREATE TRIGGER update_ca_plan_steps_updated_at
      BEFORE UPDATE ON campaign_assistant_action_plan_steps
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================================================
-- RLS: permissive (server uses service role; mirrors other tables here)
-- ============================================================================
ALTER TABLE campaign_assistant_action_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assistant_action_plan_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations on campaign_assistant_action_plans" ON campaign_assistant_action_plans;
CREATE POLICY "Allow all operations on campaign_assistant_action_plans"
  ON campaign_assistant_action_plans FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow all operations on campaign_assistant_action_plan_steps" ON campaign_assistant_action_plan_steps;
CREATE POLICY "Allow all operations on campaign_assistant_action_plan_steps"
  ON campaign_assistant_action_plan_steps FOR ALL USING (true);
