-- Add image storage columns to social_media_posts table
-- This will store actual image data instead of just URLs

-- Add columns for storing image data
ALTER TABLE social_media_posts 
ADD COLUMN IF NOT EXISTS media_data JSONB DEFAULT '[]'::JSONB,
ADD COLUMN IF NOT EXISTS media_files BYTEA[] DEFAULT '{}'::BYTEA[];

-- Add comment to explain the new columns
COMMENT ON COLUMN social_media_posts.media_data IS 'JSONB array containing image metadata (filename, size, type, base64 data)';
COMMENT ON COLUMN social_media_posts.media_files IS 'Array of binary image data (alternative storage method)';

-- Create index for better performance on media_data queries
CREATE INDEX IF NOT EXISTS idx_social_media_posts_media_data ON social_media_posts USING GIN(media_data);

-- Example of what media_data will contain:
-- [
--   {
--     "filename": "image1.jpg",
--     "size": 1024000,
--     "type": "image/jpeg",
--     "data": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD...",
--     "uploaded_at": "2025-01-09T10:30:00Z"
--   }
-- ]
