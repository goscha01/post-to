-- Add location_id column to social_media_posts table for caching posts by location
-- Also add gmb_account_id column to store GMB account IDs separately (keeping existing account_id as UUID)

ALTER TABLE social_media_posts
ADD COLUMN IF NOT EXISTS location_id VARCHAR(255);

-- Add new column for GMB account ID (string format) instead of changing existing account_id
ALTER TABLE social_media_posts
ADD COLUMN IF NOT EXISTS gmb_account_id VARCHAR(255);

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_social_media_posts_location_id ON social_media_posts(location_id);
CREATE INDEX IF NOT EXISTS idx_social_media_posts_gmb_account_id ON social_media_posts(gmb_account_id);

-- Create index for combined query (gmb_account_id + location_id + user_id)
CREATE INDEX IF NOT EXISTS idx_social_media_posts_gmb_account_location_user ON social_media_posts(gmb_account_id, location_id, user_id);

-- Add comments to explain the columns
COMMENT ON COLUMN social_media_posts.location_id IS 'Google My Business location ID for caching posts by location';
COMMENT ON COLUMN social_media_posts.gmb_account_id IS 'Google My Business account ID (string format)';