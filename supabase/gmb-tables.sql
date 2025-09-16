-- GMB Accounts and Locations Tables

-- GMB accounts table
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

-- GMB locations table
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

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_gmb_accounts_user_id ON gmb_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_gmb_accounts_account_id ON gmb_accounts(account_id);

CREATE INDEX IF NOT EXISTS idx_gmb_locations_user_id ON gmb_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_gmb_locations_account_id ON gmb_locations(account_id);
CREATE INDEX IF NOT EXISTS idx_gmb_locations_location_id ON gmb_locations(location_id);

-- Create triggers for updated_at
CREATE TRIGGER update_gmb_accounts_updated_at BEFORE UPDATE ON gmb_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_gmb_locations_updated_at BEFORE UPDATE ON gmb_locations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS) policies
ALTER TABLE gmb_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmb_locations ENABLE ROW LEVEL SECURITY;

-- RLS policies for gmb_accounts
CREATE POLICY "Users can view their own GMB accounts" ON gmb_accounts
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own GMB accounts" ON gmb_accounts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own GMB accounts" ON gmb_accounts
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own GMB accounts" ON gmb_accounts
  FOR DELETE USING (auth.uid() = user_id);

-- RLS policies for gmb_locations
CREATE POLICY "Users can view their own GMB locations" ON gmb_locations
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own GMB locations" ON gmb_locations
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own GMB locations" ON gmb_locations
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own GMB locations" ON gmb_locations
  FOR DELETE USING (auth.uid() = user_id);

-- Grant necessary permissions
GRANT ALL ON gmb_accounts TO authenticated;
GRANT ALL ON gmb_locations TO authenticated;