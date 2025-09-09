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

// Initialize Google OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL
);

// Google OAuth scopes - only for user authentication (no business access)
const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// Business OAuth scopes - for business profile connection
const BUSINESS_SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// Cache for auth URLs to reduce Google API calls
let authUrlCache = {
  url: null,
  expiry: 0,
  lastRequestTime: 0
};

// Rate limiting: track requests per IP
const requestTracker = new Map();

// Rate limiting middleware
const rateLimitMiddleware = (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 5; // Max 5 requests per minute per IP

  if (!requestTracker.has(clientIP)) {
    requestTracker.set(clientIP, []);
  }

  const requests = requestTracker.get(clientIP);
  
  // Remove old requests outside the window
  while (requests.length > 0 && requests[0] < now - windowMs) {
    requests.shift();
  }

  if (requests.length >= maxRequests) {
    return res.status(429).json({ 
      error: 'Too many requests. Please wait a moment before trying again.' 
    });
  }

  requests.push(now);
  next();
};

// Generate OAuth URL with caching and rate limiting
router.get('/google', rateLimitMiddleware, (req, res) => {
  try {
    const now = Date.now();
    const cacheExpiry = 5 * 60 * 1000; // Cache for 5 minutes
    const minRequestInterval = 2000; // Minimum 2 seconds between requests

    // Check if we have a valid cached URL
    if (authUrlCache.url && now < authUrlCache.expiry) {
      console.log('Returning cached auth URL');
      return res.json({ authUrl: authUrlCache.url });
    }

    // Check minimum request interval to prevent rapid successive calls
    if (now - authUrlCache.lastRequestTime < minRequestInterval) {
      const waitTime = minRequestInterval - (now - authUrlCache.lastRequestTime);
      console.log(`Rate limiting: requests too frequent, waiting ${waitTime}ms`);
      return res.status(429).json({ 
        error: 'Requests too frequent. Please wait a moment.',
        retryAfter: Math.ceil(waitTime / 1000)
      });
    }

    authUrlCache.lastRequestTime = now;

    // Generate new auth URL
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      // Remove 'prompt: consent' to reduce rate limiting
      // Only add it when explicitly needed for re-authorization
      ...(req.query.force_consent === 'true' && { prompt: 'consent' }),
      // Add state parameter for security
      state: 'auth_' + Date.now()
    });

    // Cache the URL
    authUrlCache = {
      url: authUrl,
      expiry: now + cacheExpiry,
      lastRequestTime: now
    };

    console.log('Generated new auth URL');
    res.json({ authUrl });

  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

// OAuth callback
router.get('/google/oauth/callback', async (req, res) => {
  console.log('OAuth callback received with query params:', req.query);
  try {
    const { code, state } = req.query;
    
    if (!code) {
      console.log('No authorization code provided');
      return res.status(400).json({ error: 'Authorization code not provided' });
    }

    // Basic state validation (optional but recommended)
    if (state && !state.startsWith('auth_') && !state.startsWith('business_')) {
      console.log('Invalid state parameter');
      return res.status(400).json({ error: 'Invalid state parameter' });
    }

    // Clear auth URL cache since we're processing a callback
    authUrlCache = { url: null, expiry: 0, lastRequestTime: 0 };

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    // Check if user exists in database
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
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({
          google_id: userInfo.data.id,
          email: userInfo.data.email,
          name: userInfo.data.name,
          picture_url: userInfo.data.picture,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null
        })
        .select()
        .single();

      if (createError) throw createError;
      user = newUser;
    } else {
      // Update existing user's tokens
      const { error: updateError } = await supabase
        .from('users')
        .update({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          name: userInfo.data.name,
          picture_url: userInfo.data.picture
        })
        .eq('id', user.id);

      if (updateError) throw updateError;
    }

    // Generate JWT token
    const jwtToken = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        googleId: user.google_id 
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
    
    console.log('JWT token generated for user:', user.id);

    // Determine if this is a business OAuth callback based on state
    const isBusinessOAuth = state && state.startsWith('business_');
    
    // Redirect to frontend with both JWT and Google tokens
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/callback?token=${jwtToken}&google_access_token=${tokens.access_token}&google_refresh_token=${tokens.refresh_token}${isBusinessOAuth ? '&business_connected=true' : ''}`;
    console.log('OAuth callback successful, redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/error`);
  }
});

// Refresh token endpoint
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();

    // Update user's tokens in database
    const { error } = await supabase
      .from('users')
      .update({
        access_token: credentials.access_token,
        token_expiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null
      })
      .eq('refresh_token', refreshToken);

    if (error) throw error;

    res.json({
      access_token: credentials.access_token,
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

// Generate OAuth URL for business profile connection
router.get('/google/business', rateLimitMiddleware, (req, res) => {
  try {
    const now = Date.now();
    const cacheExpiry = 5 * 60 * 1000; // Cache for 5 minutes
    const minRequestInterval = 2000; // Minimum 2 seconds between requests

    // Check if we have a valid cached URL
    if (authUrlCache.url && now < authUrlCache.expiry) {
      console.log('Returning cached business auth URL');
      return res.json({ authUrl: authUrlCache.url });
    }

    // Check minimum request interval to prevent rapid successive calls
    if (now - authUrlCache.lastRequestTime < minRequestInterval) {
      const waitTime = minRequestInterval - (now - authUrlCache.lastRequestTime);
      console.log(`Rate limiting: requests too frequent, waiting ${waitTime}ms`);
      return res.status(429).json({ 
        error: 'Requests too frequent. Please wait a moment.',
        retryAfter: Math.ceil(waitTime / 1000)
      });
    }

    authUrlCache.lastRequestTime = now;

    // Generate new auth URL with business scopes
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: BUSINESS_SCOPES,
      prompt: 'consent', // Force consent screen for business access
      state: 'business_' + Date.now()
    });

    // Cache the URL
    authUrlCache = {
      url: authUrl,
      expiry: now + cacheExpiry,
      lastRequestTime: now
    };

    console.log('Generated new business auth URL');
    res.json({ authUrl });

  } catch (error) {
    console.error('Error generating business auth URL:', error);
    res.status(500).json({ error: 'Failed to generate business authorization URL' });
  }
});

// Endpoint to force consent screen (for re-authorization)
router.get('/google/reauth', rateLimitMiddleware, (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent screen
    state: 'reauth_' + Date.now()
  });
  
  res.json({ authUrl });
});

module.exports = router;