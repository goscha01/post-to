-- Image Cache Table for Google Photos URL proxying

CREATE TABLE IF NOT EXISTS image_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  filename VARCHAR(255) NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  type VARCHAR(100) NOT NULL DEFAULT 'image/jpeg',
  data TEXT NOT NULL, -- Base64 encoded image data
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_image_cache_source_url ON image_cache(source_url);
CREATE INDEX IF NOT EXISTS idx_image_cache_uploaded_at ON image_cache(uploaded_at);

-- Create trigger for updated_at
CREATE TRIGGER update_image_cache_updated_at BEFORE UPDATE ON image_cache FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS) policies
ALTER TABLE image_cache ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read cached images (no user-specific data)
CREATE POLICY "Authenticated users can view cached images" ON image_cache
  FOR SELECT USING (auth.role() = 'authenticated');

-- Allow authenticated users to insert cached images
CREATE POLICY "Authenticated users can insert cached images" ON image_cache
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Allow authenticated users to update cached images
CREATE POLICY "Authenticated users can update cached images" ON image_cache
  FOR UPDATE USING (auth.role() = 'authenticated');

-- Grant necessary permissions
GRANT ALL ON image_cache TO authenticated;
