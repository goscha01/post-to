-- Complete schema for Google My Business Manager
-- Drop existing tables if they exist (in correct order due to foreign keys)
DROP TABLE IF EXISTS social_media_posts CASCADE;
DROP TABLE IF EXISTS social_media_accounts CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Users table for authentication and business profile management
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  google_id VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  picture_url TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TIMESTAMP WITH TIME ZONE,
  business_access_token TEXT,
  business_refresh_token TEXT,
  business_token_expiry TIMESTAMP WITH TIME ZONE,
  business_connected_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for google_id
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- Enable RLS for users table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- RLS policies for users table (permissive for backend operations)
CREATE POLICY "Allow all operations on users table" ON users
  FOR ALL USING (true);

-- Social Media Integration Tables
CREATE TABLE social_media_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  account_name VARCHAR(255),
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, platform, account_id)
);

CREATE TABLE social_media_posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES social_media_accounts(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  post_id VARCHAR(255),
  content TEXT,
  media_urls TEXT[],
  scheduled_at TIMESTAMP WITH TIME ZONE,
  published_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS for social media tables
ALTER TABLE social_media_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_media_posts ENABLE ROW LEVEL SECURITY;

-- RLS policies for social media tables
CREATE POLICY "Allow all operations on social_media_accounts" ON social_media_accounts
  FOR ALL USING (true);

CREATE POLICY "Allow all operations on social_media_posts" ON social_media_posts
  FOR ALL USING (true);
