-- GMB Media Cache Table

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

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_gmb_media_cache_user_id ON gmb_media_cache(user_id);
CREATE INDEX IF NOT EXISTS idx_gmb_media_cache_account_id ON gmb_media_cache(account_id);
CREATE INDEX IF NOT EXISTS idx_gmb_media_cache_location_id ON gmb_media_cache(location_id);
CREATE INDEX IF NOT EXISTS idx_gmb_media_cache_combined ON gmb_media_cache(user_id, account_id, location_id);

-- Create trigger for updated_at
CREATE TRIGGER update_gmb_media_cache_updated_at BEFORE UPDATE ON gmb_media_cache FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS) policies
ALTER TABLE gmb_media_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own GMB media cache" ON gmb_media_cache
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own GMB media cache" ON gmb_media_cache
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own GMB media cache" ON gmb_media_cache
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own GMB media cache" ON gmb_media_cache
  FOR DELETE USING (auth.uid() = user_id);

-- Grant necessary permissions
GRANT ALL ON gmb_media_cache TO authenticated;