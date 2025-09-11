const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Google OAuth2 client for user authentication
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL
);

// Initialize separate OAuth2 client for business authentication
const businessOAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.BACKEND_URL || 'http://localhost:3001'}/auth/google/business/callback`
);

// Google OAuth scopes - only for user authentication (no business access)
const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// Business OAuth scopes - for business profile connection
const BUSINESS_SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/plus.business.manage', // Add this missing scope
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// Database Cache Class
class DatabaseCache {
  constructor(supabaseClient) {
    this.supabase = supabaseClient;
    this.memoryCache = new Map();
    this.maxMemoryCacheSize = 50;
  }

  async get(key) {
    try {
      // Check memory first
      if (this.memoryCache.has(key)) {
        const cached = this.memoryCache.get(key);
        if (cached.expiry > Date.now()) {
          return cached.data;
        }
        this.memoryCache.delete(key);
      }

      // Check database
      const { data, error } = await this.supabase
        .from('cache_entries')
        .select('cache_value, expiry')
        .eq('cache_key', key)
        .single();

      if (error || !data || new Date(data.expiry) <= new Date()) {
        return null;
      }

      // Store in memory for next access
      this.memoryCache.set(key, {
        data: data.cache_value,
        expiry: new Date(data.expiry).getTime()
      });

      return data.cache_value;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  async set(key, value, ttlMs = 180000) { // 3 minutes default
    try {
      const expiry = new Date(Date.now() + ttlMs);
      
      // Store in memory
      this.memoryCache.set(key, { data: value, expiry: expiry.getTime() });
      
      // Cleanup memory if too large
      if (this.memoryCache.size > this.maxMemoryCacheSize) {
        const oldestKeys = Array.from(this.memoryCache.keys()).slice(0, 10);
        oldestKeys.forEach(k => this.memoryCache.delete(k));
      }

      // Store in database
      await this.supabase
        .from('cache_entries')
        .upsert({
          cache_key: key,
          cache_value: value,
          expiry: expiry
        });

    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  async delete(key) {
    try {
      this.memoryCache.delete(key);
      await this.supabase
        .from('cache_entries')
        .delete()
        .eq('cache_key', key);
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }
}

// Smart Rate Limiting Class
class SmartRateLimit {
  constructor(cache) {
    this.cache = cache;
    this.limits = {
      oauth_url: { requests: 2, windowMs: 60000 },
      business_oauth: { requests: 2, windowMs: 60000 },
      token_refresh: { requests: 10, windowMs: 60000 } // Increased from 3 to 10 requests per minute
    };
  }

  async checkLimit(clientIP, endpoint = 'general') {
    const limit = this.limits[endpoint] || { requests: 3, windowMs: 60000 };
    const key = `rate_${endpoint}_${clientIP}`;
    const now = Date.now();
    
    let requests = await this.cache.get(key) || [];
    requests = requests.filter(time => time > now - limit.windowMs);
    
    if (requests.length >= limit.requests) {
      return {
        allowed: false,
        retryAfter: Math.ceil((requests[0] + limit.windowMs - now) / 1000)
      };
    }

    requests.push(now);
    await this.cache.set(key, requests, limit.windowMs + 5000);
    return { allowed: true };
  }
}

// Initialize instances (after classes are defined)
const dbCache = new DatabaseCache(supabase);
const smartRateLimit = new SmartRateLimit(dbCache);

// Enhanced rate limiting middleware
const smartRateLimitMiddleware = (endpoint = 'general') => {
  return async (req, res, next) => {
    try {
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
      const result = await smartRateLimit.checkLimit(clientIP, endpoint);
      
      if (!result.allowed) {
        return res.status(429).json({ 
          error: 'Rate limit exceeded. Please wait before trying again.',
          retryAfter: result.retryAfter,
          endpoint: endpoint
        });
      }
      
      next();
    } catch (error) {
      console.error('Rate limiting error:', error);
      next(); // Allow request if rate limiting fails
    }
  };
};

// Clean old cache entries every hour
setInterval(async () => {
  try {
    const { error } = await supabase
      .from('cache_entries')
      .delete()
      .lt('expiry', new Date());
    
    if (!error) {
      console.log('Cache cleanup completed');
    }
  } catch (error) {
    console.error('Cache cleanup error:', error);
  }
}, 3600000); // 1 hour

// Generate OAuth URL with enhanced caching and rate limiting
router.get('/google', smartRateLimitMiddleware('oauth_url'), async (req, res) => {
  try {
    const cacheKey = 'oauth_url_general';
    const forceConsent = req.query.force_consent === 'true';
    
    // Check cache first (skip cache if forcing consent)
    if (!forceConsent) {
      const cachedUrl = await dbCache.get(cacheKey);
      if (cachedUrl) {
        console.log('Returning cached OAuth URL');
        return res.json({ authUrl: cachedUrl });
      }
    }

    // Generate new URL
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      ...(forceConsent && { prompt: 'consent' }),
      state: 'auth_' + Date.now()
    });

    // Cache for 3 minutes (skip caching if forcing consent)
    if (!forceConsent) {
      await dbCache.set(cacheKey, authUrl, 180000);
    }

    console.log('Generated new OAuth URL');
    res.json({ authUrl });

  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

// OAuth callback
router.get('/google/oauth/callback', async (req, res) => {
  console.log('OAuth callback received:', req.query);
  try {
    const { code, state } = req.query;
    
    if (!code) {
      console.log('No authorization code provided');
      return res.status(400).json({ error: 'Authorization code not provided' });
    }

    // Validate state parameter for user auth
    if (state && !state.startsWith('auth_') && !state.startsWith('reauth_')) {
      console.log('Invalid state parameter');
      return res.status(400).json({ error: 'Invalid state parameter' });
    }

    // Clear general OAuth cache since we're processing a callback
    await dbCache.delete('oauth_url_general');

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    // Try to find existing user
    let { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('google_id', userInfo.data.id)
      .single();

    if (userError && userError.code !== 'PGRST116') {
      throw userError;
    }

    if (!user) {
      // Create new user
      console.log('Creating new user:', userInfo.data.email);
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert([{
          google_id: userInfo.data.id,
          email: userInfo.data.email,
          name: userInfo.data.name,
          picture_url: userInfo.data.picture,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          has_business_access: false
        }])
        .select()
        .single();

      if (createError) throw createError;
      user = newUser;
    } else {
      // Update existing user
      const { error: updateError } = await supabase
        .from('users')
        .update({
          email: userInfo.data.email,
          name: userInfo.data.name,
          picture_url: userInfo.data.picture,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null
        })
        .eq('id', user.id);

      if (updateError) throw updateError;
      
      // Update user object for JWT
      user = {
        ...user,
        email: userInfo.data.email,
        name: userInfo.data.name,
        picture_url: userInfo.data.picture
      };
    }

    // Generate JWT token
    const jwtToken = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        googleId: user.google_id,
        name: user.name,
        picture_url: user.picture_url,
        has_business_access: user.has_business_access || false
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    
    console.log('JWT token generated for user:', user.id);

    // Redirect to frontend
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/callback?token=${jwtToken}`;
    console.log('User OAuth callback successful, redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/error?message=${encodeURIComponent(error.message)}`);
  }
});

// Generate OAuth URL for business profile connection
router.get('/google/business', smartRateLimitMiddleware('business_oauth'), async (req, res) => {
  try {
    const { user_id } = req.query;
    
    if (!user_id) {
      return res.status(400).json({ error: 'User ID required for business authentication' });
    }

    // Verify user exists in your database
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('id', user_id)
      .single();

    if (userError || !user) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const cacheKey = `business_oauth_${user_id}`;
    
    // Check cache first
    const cachedUrl = await dbCache.get(cacheKey);
    if (cachedUrl) {
      console.log('Returning cached business OAuth URL');
      return res.json({ authUrl: cachedUrl });
    }

    // Generate new business auth URL
    const authUrl = businessOAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: BUSINESS_SCOPES,
      prompt: 'consent',
      state: `business_${user_id}_${Date.now()}`
    });

    // Cache for 3 minutes
    await dbCache.set(cacheKey, authUrl, 180000);

    console.log('Generated new business OAuth URL for user:', user_id);
    res.json({ authUrl });

  } catch (error) {
    console.error('Error generating business auth URL:', error);
    res.status(500).json({ error: 'Failed to generate business authorization URL' });
  }
});

// Business OAuth callback (separate endpoint for business profile access)
router.get('/google/business/callback', async (req, res) => {
  console.log('Business OAuth callback received:', req.query);
  try {
    const { code, state } = req.query;
    
    if (!code) {
      console.log('No authorization code provided for business auth');
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/error?error=no_code`);
    }

    // Extract user_id from state parameter
    let extractedUserId = null;
    if (state && state.startsWith('business_')) {
      const parts = state.split('_');
      if (parts.length >= 3) {
        extractedUserId = parts[1];
      }
    }

    if (!extractedUserId) {
      console.error('No user_id found in state parameter for business authentication');
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/error?error=invalid_state`);
    }

    // Clear business cache for this user
    await dbCache.delete(`business_oauth_${extractedUserId}`);

    // Exchange code for tokens using business OAuth client
    const { tokens } = await businessOAuth2Client.getToken(code);
    businessOAuth2Client.setCredentials(tokens);

    // Get business user info from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: businessOAuth2Client });
    const businessUserInfo = await oauth2.userinfo.get();

    // Find the existing user by ID
    let { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', extractedUserId)
      .single();

    if (userError || !user) {
      console.error('Business authentication attempted for non-existent user:', extractedUserId);
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/error?error=user_not_found`);
    }

    // Update user with business tokens and info
    const { error: updateError } = await supabase
      .from('users')
      .update({
        business_access_token: tokens.access_token,
        business_refresh_token: tokens.refresh_token,
        business_token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        business_google_id: businessUserInfo.data.id,
        business_email: businessUserInfo.data.email,
        has_business_access: true,
        business_connected_at: new Date()
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Error updating user with business tokens:', updateError);
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/error?error=update_failed`);
    }

    // Generate JWT token with updated user info
    const jwtToken = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        googleId: user.google_id,
        name: user.name,
        picture_url: user.picture_url,
        has_business_access: true
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    
    console.log('Business connection successful for user:', user.id);

    // Redirect to frontend with success - include both JWT and Google refresh token
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/success?token=${jwtToken}&refreshToken=${tokens.refresh_token}`;
    console.log('Business OAuth callback successful, redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
    
  } catch (error) {
    console.error('Business OAuth callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/error?error=callback_failed`);
  }
});

// Refresh token endpoint
router.post('/refresh', smartRateLimitMiddleware('token_refresh'), async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    console.log('🔄 Refresh endpoint called');
    console.log('🔄 Refresh token received:', !!refreshToken);
    console.log('🔄 Refresh token length:', refreshToken ? refreshToken.length : 0);
    console.log('🔄 Refresh token starts with:', refreshToken ? refreshToken.substring(0, 20) + '...' : 'null');
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Find user by business refresh token (since we're using Google refresh token from business auth)
    console.log('🔄 Looking up user by business_refresh_token...');
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, google_id, name, picture_url, has_business_access, business_refresh_token')
      .eq('business_refresh_token', refreshToken)
      .single();

    if (userError || !user) {
      console.error('🔄 Token refresh error:', userError);
      console.error('🔄 User found:', !!user);
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    console.log('🔄 User found:', user.id);
    console.log('🔄 User has business access:', user.has_business_access);
    
    // Use business OAuth client to refresh the Google access token
    console.log('🔄 Refreshing Google access token...');
    businessOAuth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await businessOAuth2Client.refreshAccessToken();
    console.log('🔄 Google token refreshed successfully');

    // Update business tokens in database
    const { error: updateError } = await supabase
      .from('users')
      .update({
        business_access_token: credentials.access_token,
        business_token_expiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Error updating business tokens:', updateError);
      return res.status(500).json({ error: 'Failed to update tokens' });
    }

    // Generate new JWT token instead of returning Google access token
    console.log('🔄 Generating new JWT token...');
    const jwtToken = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        googleId: user.google_id,
        name: user.name,
        picture_url: user.picture_url,
        has_business_access: user.has_business_access || false
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    console.log('🔄 JWT token generated successfully');
    console.log('🔄 JWT token length:', jwtToken.length);
    console.log('🔄 JWT token starts with:', jwtToken.substring(0, 20) + '...');

    res.json({
      access_token: jwtToken, // Return JWT instead of Google access token
      expires_in: credentials.expiry_date ? Math.floor((credentials.expiry_date - Date.now()) / 1000) : null
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// Logout endpoint
router.post('/logout', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (userId) {
      // Clear user's tokens in database
      await supabase
        .from('users')
        .update({
          access_token: null,
          refresh_token: null,
          token_expiry: null
        })
        .eq('id', userId);
    }

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Endpoint to force consent screen (for re-authorization)
router.get('/google/reauth', smartRateLimitMiddleware('oauth_url'), (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent screen
    state: 'reauth_' + Date.now()
  });
  
  res.json({ authUrl });
});

module.exports = router;