-- Complete GMB Setup - All required tables and schema updates
-- Run this script to set up all GMB-related database tables and columns

-- ============================================================================
-- 1. Update social_media_posts table for GMB compatibility
-- ============================================================================

-- Add location_id column for caching posts by location
ALTER TABLE social_media_posts
ADD COLUMN IF NOT EXISTS location_id VARCHAR(255);

-- Add gmb_account_id column for GMB account IDs (string format)
-- Keep existing account_id as UUID for existing relationships
ALTER TABLE social_media_posts
ADD COLUMN IF NOT EXISTS gmb_account_id VARCHAR(255);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_social_media_posts_location_id ON social_media_posts(location_id);
CREATE INDEX IF NOT EXISTS idx_social_media_posts_gmb_account_id ON social_media_posts(gmb_account_id);
CREATE INDEX IF NOT EXISTS idx_social_media_posts_gmb_account_location_user ON social_media_posts(gmb_account_id, location_id, user_id);

-- Add comments
COMMENT ON COLUMN social_media_posts.location_id IS 'Google My Business location ID for caching posts by location';
COMMENT ON COLUMN social_media_posts.gmb_account_id IS 'Google My Business account ID (string format)';

-- ============================================================================
-- 2. GMB Accounts table
-- ============================================================================

CREATE TABLE IF NOT EXISTS gmb_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id VARCHAR(255) NOT NULL,
  account_name VARCHAR(255),
  account_number VARCHAR(255),
  type VARCHAR(50),
  role VARCHAR(50),
  state VARCHAR(50),
  permission_level VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(user_id, account_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_gmb_accounts_user_id ON gmb_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_gmb_accounts_account_id ON gmb_accounts(account_id);

-- ============================================================================
-- 3. GMB Locations table
-- ============================================================================

CREATE TABLE IF NOT EXISTS gmb_locations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id VARCHAR(255) NOT NULL,
  location_id VARCHAR(255) NOT NULL,
  location_name VARCHAR(500),
  business_name VARCHAR(500),
  address TEXT,
  phone VARCHAR(50),
  website_url VARCHAR(500),
  primary_category VARCHAR(255),
  additional_categories TEXT[],
  store_code VARCHAR(100),
  language_code VARCHAR(10),
  labels TEXT[],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(user_id, account_id, location_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_gmb_locations_user_id ON gmb_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_gmb_locations_account_id ON gmb_locations(account_id);
CREATE INDEX IF NOT EXISTS idx_gmb_locations_location_id ON gmb_locations(location_id);

-- ============================================================================
-- 4. GMB Media Cache table
-- ============================================================================

CREATE TABLE IF NOT EXISTS gmb_media_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id VARCHAR(255) NOT NULL,
  location_id VARCHAR(255) NOT NULL,
  media_data JSONB NOT NULL DEFAULT '[]'::JSONB,
  logos JSONB NOT NULL DEFAULT '[]'::JSONB,
  photos JSONB NOT NULL DEFAULT '[]'::JSONB,
  profile_picture JSONB,
  total_media_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(user_id, account_id, location_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_gmb_media_cache_user_id ON gmb_media_cache(user_id);
CREATE INDEX IF NOT EXISTS idx_gmb_media_cache_account_id ON gmb_media_cache(account_id);
CREATE INDEX IF NOT EXISTS idx_gmb_media_cache_location_id ON gmb_media_cache(location_id);
CREATE INDEX IF NOT EXISTS idx_gmb_media_cache_combined ON gmb_media_cache(user_id, account_id, location_id);

-- ============================================================================
-- 5. Create updated_at triggers (if function exists)
-- ============================================================================

DO $$
BEGIN
  -- Only create triggers if the update function exists
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    -- GMB accounts trigger
    DROP TRIGGER IF EXISTS update_gmb_accounts_updated_at ON gmb_accounts;
    CREATE TRIGGER update_gmb_accounts_updated_at
      BEFORE UPDATE ON gmb_accounts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    -- GMB locations trigger
    DROP TRIGGER IF EXISTS update_gmb_locations_updated_at ON gmb_locations;
    CREATE TRIGGER update_gmb_locations_updated_at
      BEFORE UPDATE ON gmb_locations
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    -- GMB media cache trigger
    DROP TRIGGER IF EXISTS update_gmb_media_cache_updated_at ON gmb_media_cache;
    CREATE TRIGGER update_gmb_media_cache_updated_at
      BEFORE UPDATE ON gmb_media_cache
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================================================
-- 6. Row Level Security (RLS) policies
-- ============================================================================

-- Enable RLS
ALTER TABLE gmb_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmb_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmb_media_cache ENABLE ROW LEVEL SECURITY;

-- GMB accounts policies
DROP POLICY IF EXISTS "Users can view their own GMB accounts" ON gmb_accounts;
CREATE POLICY "Users can view their own GMB accounts" ON gmb_accounts
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own GMB accounts" ON gmb_accounts;
CREATE POLICY "Users can insert their own GMB accounts" ON gmb_accounts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own GMB accounts" ON gmb_accounts;
CREATE POLICY "Users can update their own GMB accounts" ON gmb_accounts
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own GMB accounts" ON gmb_accounts;
CREATE POLICY "Users can delete their own GMB accounts" ON gmb_accounts
  FOR DELETE USING (auth.uid() = user_id);

-- GMB locations policies
DROP POLICY IF EXISTS "Users can view their own GMB locations" ON gmb_locations;
CREATE POLICY "Users can view their own GMB locations" ON gmb_locations
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own GMB locations" ON gmb_locations;
CREATE POLICY "Users can insert their own GMB locations" ON gmb_locations
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own GMB locations" ON gmb_locations;
CREATE POLICY "Users can update their own GMB locations" ON gmb_locations
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own GMB locations" ON gmb_locations;
CREATE POLICY "Users can delete their own GMB locations" ON gmb_locations
  FOR DELETE USING (auth.uid() = user_id);

-- GMB media cache policies
DROP POLICY IF EXISTS "Users can view their own GMB media cache" ON gmb_media_cache;
CREATE POLICY "Users can view their own GMB media cache" ON gmb_media_cache
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own GMB media cache" ON gmb_media_cache;
CREATE POLICY "Users can insert their own GMB media cache" ON gmb_media_cache
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own GMB media cache" ON gmb_media_cache;
CREATE POLICY "Users can update their own GMB media cache" ON gmb_media_cache
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own GMB media cache" ON gmb_media_cache;
CREATE POLICY "Users can delete their own GMB media cache" ON gmb_media_cache
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================================
-- 7. Grant permissions
-- ============================================================================

GRANT ALL ON gmb_accounts TO authenticated;
GRANT ALL ON gmb_locations TO authenticated;
GRANT ALL ON gmb_media_cache TO authenticated;

-- ============================================================================
-- Setup Complete!
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'GMB database setup completed successfully!';
  RAISE NOTICE 'Tables created: gmb_accounts, gmb_locations, gmb_media_cache';
  RAISE NOTICE 'Columns added: social_media_posts.location_id, social_media_posts.gmb_account_id';
  RAISE NOTICE 'All indexes, triggers, and RLS policies configured.';
END $$;