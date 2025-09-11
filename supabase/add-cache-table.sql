-- Add cache_data table to existing database
-- This script adds only the cache table without affecting existing tables

-- Cache data table for persistent caching
CREATE TABLE IF NOT EXISTS cache_data (
  id BIGSERIAL PRIMARY KEY,
  cache_key VARCHAR(500) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_cache_data_key_user ON cache_data(cache_key, user_id);
CREATE INDEX IF NOT EXISTS idx_cache_data_expires ON cache_data(expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_data_user_id ON cache_data(user_id);

-- Create unique constraint to prevent duplicate cache entries
CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_data_unique ON cache_data(cache_key, user_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_cache_data_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at
CREATE TRIGGER trigger_update_cache_data_updated_at
  BEFORE UPDATE ON cache_data
  FOR EACH ROW
  EXECUTE FUNCTION update_cache_data_updated_at();

-- Function to clean expired cache entries
CREATE OR REPLACE FUNCTION clean_expired_cache()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM cache_data 
  WHERE expires_at < NOW();
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Enable RLS for cache_data table
ALTER TABLE cache_data ENABLE ROW LEVEL SECURITY;

-- RLS policies for cache_data table
CREATE POLICY "Users can view their own cache data" ON cache_data
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own cache data" ON cache_data
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own cache data" ON cache_data
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own cache data" ON cache_data
  FOR DELETE USING (auth.uid() = user_id);

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON cache_data TO authenticated;
GRANT USAGE ON SEQUENCE cache_data_id_seq TO authenticated;
GRANT EXECUTE ON FUNCTION clean_expired_cache() TO authenticated;
