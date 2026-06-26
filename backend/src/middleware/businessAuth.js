const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const requireBusinessAuth = async (req, res, next) => {
  try {
    // Ensure user is authenticated first (relies on existing authMiddleware)
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'User authentication required' });
    }

    const userId = req.user.userId;

    // Get user's business tokens from database
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('business_access_token, business_refresh_token, business_token_expiry, has_business_access')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.has_business_access || !user.business_access_token) {
      return res.status(403).json({ 
        error: 'Business access not available. Please connect your Google My Business account.',
        needsBusinessAuth: true
      });
    }

    // Check if business token is expired
    const now = new Date();
    const tokenExpiry = user.business_token_expiry ? new Date(user.business_token_expiry) : null;
    
    if (tokenExpiry && tokenExpiry <= now) {
      // Token expired, try to refresh
      try {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );
        
        oauth2Client.setCredentials({
          refresh_token: user.business_refresh_token
        });
        
        const { credentials } = await oauth2Client.refreshAccessToken();
        
        // Update database with new token
        await supabase
          .from('users')
          .update({
            business_access_token: credentials.access_token,
            business_token_expiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null
          })
          .eq('id', userId);
        
        // Set refreshed token
        req.businessToken = credentials.access_token;
        req.businessRefreshToken = user.business_refresh_token;
        
      } catch (refreshError) {
        return res.status(401).json({ 
          error: 'Business authentication expired. Please reconnect your Google My Business account.',
          needsBusinessAuth: true
        });
      }
    } else {
      req.businessToken = user.business_access_token;
      req.businessRefreshToken = user.business_refresh_token;
    }
    
    // Create OAuth client for GMB API calls
    req.businessOAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    
    req.businessOAuth2Client.setCredentials({
      access_token: req.businessToken,
      refresh_token: req.businessRefreshToken
    });
    
    next();
  } catch (error) {
    res.status(500).json({ error: 'Business authentication check failed' });
  }
};

module.exports = requireBusinessAuth;