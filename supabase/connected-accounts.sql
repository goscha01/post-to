-- Unified "Connected Accounts" table.
-- One row per provider-account a user has connected.
-- Providers planned: 'website', 'google_business', and later 'instagram', 'facebook'.
-- For google_business we don't store OAuth tokens here (they live on users.business_profiles);
-- this table is the user-facing "what's connected" list and a join key for AI features.
-- Safe to re-run: uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS connected_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  provider VARCHAR(32) NOT NULL,            -- 'website' | 'google_business' | 'instagram' | 'facebook'
  display_name TEXT,                        -- "spotlesshomes.com" or "Spotless Homes (Tampa)"
  external_id TEXT,                         -- website URL, GMB location resource name, etc.
  metadata JSONB,                           -- scraped page info / OAuth profile snapshot / GMB account+location ids
  status VARCHAR(32) NOT NULL DEFAULT 'active', -- 'active' | 'disconnected' | 'error'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connected_accounts_user_id ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user_provider ON connected_accounts(user_id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS uq_connected_accounts_user_provider_external
  ON connected_accounts(user_id, provider, external_id)
  WHERE external_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS update_connected_accounts_updated_at ON connected_accounts;
    CREATE TRIGGER update_connected_accounts_updated_at
      BEFORE UPDATE ON connected_accounts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations on connected_accounts" ON connected_accounts;
CREATE POLICY "Allow all operations on connected_accounts" ON connected_accounts FOR ALL USING (true);
