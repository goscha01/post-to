const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const connectionsService = require('../services/connectionsService');
const metaService = require('../services/metaService');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
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

// Business OAuth scopes - for business profile connection.
// One Google consent covers GMB (business.manage), GA4 (analytics.readonly),
// Google Ads (adwords), and Search Console (webmasters.readonly) — all reads
// live on the same refresh token so we don't need a separate consent flow per
// Google product.
const BUSINESS_SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/plus.business.manage', // Add this missing scope
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/webmasters.readonly',
  // drive.readonly: powers the "Pick from Google Drive" image browser in the
  // calendar composer. Existing users must reconnect once to grant it —
  // /api/drive/images returns 403 with needsReauth until they do.
  'https://www.googleapis.com/auth/drive.readonly',
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
    }
  } catch (error) {
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

    res.json({ authUrl });

  } catch (error) {
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

// OAuth callback
router.get('/google/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    if (!code) {
      return res.status(400).json({ error: 'Authorization code not provided' });
    }

    // Validate state parameter for user auth
    if (state && !state.startsWith('auth_') && !state.startsWith('reauth_')) {
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
    

    // Redirect to frontend
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/callback?token=${jwtToken}`;
    res.redirect(redirectUrl);

  } catch (error) {
    console.error('[auth/google/oauth/callback] FAILED:', error.message);
    console.error('cause:', error.cause);
    if (error.cause) {
      console.error('cause.code:', error.cause.code, 'errno:', error.cause.errno);
      console.error('cause.message:', error.cause.message);
    }
    if (error.stack) console.error(error.stack);
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
      console.error('[auth/google/business] user lookup failed', {
        user_id,
        userError_message: userError?.message,
        userError_code: userError?.code,
        userError_details: userError?.details,
        userError_hint: userError?.hint,
        user_is_null: !user
      });
      return res.status(400).json({ error: 'Invalid user ID', _debug: { userError, user_id } });
    }

    // No cache: this URL is cheap to generate and caching bites us hard when
    // BUSINESS_SCOPES changes (e.g. adding analytics.readonly) — a stale cached
    // URL sends users into a consent screen missing the new scope. Also blow
    // away any pre-existing cache entry for this user for the same reason.
    const cacheKey = `business_oauth_${user_id}`;
    await dbCache.delete(cacheKey);

    // Generate business auth URL.
    //   include_granted_scopes: merges any previously-granted scopes onto the
    //     new grant instead of replacing them — matters when the app account
    //     and the business account are the same Google user.
    //   prompt: 'select_account consent' does two things at once:
    //     - select_account forces Google to show its account chooser even when
    //       one Google account is already active in the browser session. This
    //       is essential for a multi-account app — otherwise Google silently
    //       reuses whichever account the browser is currently signed into,
    //       making it impossible to add a *different* Google account without
    //       going incognito.
    //     - consent forces the consent screen so users can approve any newly
    //       added scopes (adwords, analytics.readonly, etc).
    const authUrl = businessOAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: BUSINESS_SCOPES,
      prompt: 'select_account consent',
      include_granted_scopes: true,
      state: `business_${user_id}_${Date.now()}`
    });

    res.json({ authUrl });

  } catch (error) {
    res.status(500).json({ error: 'Failed to generate business authorization URL' });
  }
});

// Business OAuth callback (separate endpoint for business profile access)
router.get('/google/business/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    if (!code) {
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
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/error?error=invalid_state`);
    }

    // Clear business cache for this user
    await dbCache.delete(`business_oauth_${extractedUserId}`);

    // Exchange code for tokens using business OAuth client
    const { tokens } = await businessOAuth2Client.getToken(code);
    businessOAuth2Client.setCredentials(tokens);

    // Log the scopes Google actually granted so we can verify from Loki whether
    // analytics.readonly (or any newly-added scope) actually made it through the
    // consent screen. This is the single most useful signal for debugging
    // "reconnected but analytics still missing".
    const grantedScopes = (tokens.scope || '').split(/\s+/).filter(Boolean);
    logger.info('auth.business.tokens_received', {
      user_id: extractedUserId,
      granted_scopes: grantedScopes,
      requested_scopes: BUSINESS_SCOPES,
      has_analytics: grantedScopes.includes('https://www.googleapis.com/auth/analytics.readonly'),
      has_adwords: grantedScopes.includes('https://www.googleapis.com/auth/adwords'),
      has_webmasters: grantedScopes.includes('https://www.googleapis.com/auth/webmasters.readonly'),
      has_business_manage: grantedScopes.includes('https://www.googleapis.com/auth/business.manage'),
      has_refresh_token: !!tokens.refresh_token,
      expiry_date: tokens.expiry_date,
    });

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
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/error?error=user_not_found`);
    }

    // ---- Multi-profile: append or upsert into business_profiles JSONB ----
    const now = new Date().toISOString();
    const incomingProfile = {
      business_google_id: businessUserInfo.data.id,
      business_email: businessUserInfo.data.email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      connected_at: now
    };

    const existingProfiles = Array.isArray(user.business_profiles) ? user.business_profiles : [];
    const idx = existingProfiles.findIndex(p => p.business_google_id === incomingProfile.business_google_id);
    const merged = [...existingProfiles];
    if (idx >= 0) {
      // Reconnecting same Google account → refresh tokens, keep connected_at.
      merged[idx] = { ...merged[idx], ...incomingProfile, connected_at: merged[idx].connected_at || now };
    } else {
      merged.push(incomingProfile);
    }

    // Keep the single business_* columns pointing at the just-connected profile
    // so the existing requireBusinessAuth middleware keeps working without changes.
    const { error: updateError } = await supabase
      .from('users')
      .update({
        business_profiles: merged,
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
      console.error('[auth/google/business/callback] update_failed', {
        message: updateError.message, code: updateError.code, details: updateError.details, hint: updateError.hint
      });
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/error?error=update_failed`);
    }

    // Mirror into the unified connected_accounts list so the new picker UI
    // shows this Google Business profile alongside website / future providers.
    // Failure here must not block the OAuth flow.
    try {
      await connectionsService.upsertGoogleBusiness({
        userId: user.id,
        businessGoogleId: businessUserInfo.data.id,
        businessEmail: businessUserInfo.data.email,
        displayName: businessUserInfo.data.name || businessUserInfo.data.email || 'Google Business Profile',
      });
    } catch (e) {
      console.error('[auth/google/business/callback] connected_accounts upsert failed:', e.message);
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
    

    // Redirect to frontend with success - include both JWT and Google refresh token
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/success?token=${jwtToken}&refreshToken=${tokens.refresh_token}`;
    res.redirect(redirectUrl);
    
  } catch (error) {
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/business/error?error=callback_failed`);
  }
});

// Refresh token endpoint
router.post('/refresh', smartRateLimitMiddleware('token_refresh'), async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Find user by business refresh token (since we're using Google refresh token from business auth)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, google_id, name, picture_url, has_business_access, business_refresh_token')
      .eq('business_refresh_token', refreshToken)
      .single();

    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    
    // Use business OAuth client to refresh the Google access token
    businessOAuth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await businessOAuth2Client.refreshAccessToken();

    // Update business tokens in database
    const { error: updateError } = await supabase
      .from('users')
      .update({
        business_access_token: credentials.access_token,
        business_token_expiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null
      })
      .eq('id', user.id);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update tokens' });
    }

    // Generate new JWT token instead of returning Google access token
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


    res.json({
      access_token: jwtToken, // Return JWT instead of Google access token
      expires_in: credentials.expiry_date ? Math.floor((credentials.expiry_date - Date.now()) / 1000) : null
    });

  } catch (error) {
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
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Remove a single connected Google Business OAuth grant from the user's
// business_profiles JSONB array. The `businessGoogleId` is the Google user id
// captured at OAuth time (users.business_profiles[i].business_google_id) —
// NOT the GMB account_id and NOT the connected_accounts row id.
//
// Removes:
//   - the matching entry from users.business_profiles
//   - the mirrored google_business row from connected_accounts (best-effort)
//   - if the removed grant was the "primary" (business_google_id on the
//     users row), promote the most-recently-connected remaining grant so
//     requireBusinessAuth keeps working
router.delete('/business-profile/:businessGoogleId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { businessGoogleId } = req.params;

    if (!businessGoogleId) {
      return res.status(400).json({ error: 'businessGoogleId is required' });
    }

    const { data: user, error: fetchErr } = await supabase
      .from('users')
      .select('business_profiles, business_google_id')
      .eq('id', userId)
      .single();

    if (fetchErr || !user) {
      logger.warn('auth.business_profile.delete_user_not_found', { user_id: userId, error: fetchErr?.message });
      return res.status(404).json({ error: 'User not found' });
    }

    const existing = Array.isArray(user.business_profiles) ? user.business_profiles : [];
    const target = existing.find(p => p.business_google_id === businessGoogleId);
    if (!target) {
      return res.status(404).json({ error: 'Business profile not connected' });
    }
    const kept = existing.filter(p => p.business_google_id !== businessGoogleId);

    // If we removed the "primary" grant, promote the most-recently-connected
    // remaining one so requireBusinessAuth keeps working without a re-login.
    const wasPrimary = user.business_google_id === businessGoogleId;
    const newPrimary = wasPrimary
      ? [...kept].sort((a, b) => new Date(b.connected_at || 0) - new Date(a.connected_at || 0))[0]
      : null;

    const update = { business_profiles: kept };
    if (wasPrimary) {
      if (newPrimary) {
        update.business_google_id = newPrimary.business_google_id;
        update.business_email = newPrimary.business_email;
        update.business_access_token = newPrimary.access_token;
        update.business_refresh_token = newPrimary.refresh_token;
        update.business_token_expiry = newPrimary.token_expiry ? new Date(newPrimary.token_expiry) : null;
        update.has_business_access = true;
      } else {
        update.business_google_id = null;
        update.business_email = null;
        update.business_access_token = null;
        update.business_refresh_token = null;
        update.business_token_expiry = null;
        update.has_business_access = false;
      }
    }

    const { error: updateErr } = await supabase.from('users').update(update).eq('id', userId);
    if (updateErr) {
      logger.error('auth.business_profile.delete_update_failed', { user_id: userId, business_google_id: businessGoogleId, error: updateErr.message });
      return res.status(500).json({ error: 'Failed to remove business profile' });
    }

    // Mirror: drop the corresponding connected_accounts row (best-effort).
    try {
      await supabase
        .from('connected_accounts')
        .delete()
        .eq('user_id', userId)
        .eq('provider', 'google_business')
        .eq('external_id', `google:${businessGoogleId}`);
    } catch (e) {
      logger.warn('auth.business_profile.delete_ca_failed', { user_id: userId, error: e.message });
    }

    logger.info('auth.business_profile.deleted', {
      user_id: userId,
      business_google_id: businessGoogleId,
      business_email: target.business_email || null,
      was_primary: wasPrimary,
      remaining_count: kept.length,
      promoted_email: newPrimary?.business_email || null,
    });

    return res.json({
      ok: true,
      removed: { business_google_id: businessGoogleId, business_email: target.business_email || null },
      remaining: kept.map(p => ({ business_google_id: p.business_google_id, business_email: p.business_email })),
    });
  } catch (err) {
    logger.error('auth.business_profile.delete_unhandled', { error: err?.message, stack: err?.stack?.slice(0, 1500) });
    return res.status(500).json({ error: 'Failed to remove business profile' });
  }
});

// ---------------------------------------------------------------------------
// Meta (Facebook + Instagram Business) OAuth
// ---------------------------------------------------------------------------
// One OAuth grant covers both providers — Instagram Business accounts are
// always linked to a Facebook Page, so we discover them via /me/accounts and
// upsert one connected_accounts row per FB Page + one per linked IG account.

router.get('/facebook', smartRateLimitMiddleware('business_oauth'), async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'User ID required' });

    const { data: user, error: userError } = await supabase
      .from('users').select('id').eq('id', user_id).single();
    if (userError || !user) {
      logger.warn('auth.facebook.user_not_found', { user_id, error: userError?.message });
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // State carries user_id + nonce so the callback can bind the returned
    // token to the right app user. Not signed — anyone forging state can only
    // authenticate as themselves (Meta still validates the OAuth code).
    const state = `meta_${user_id}_${Date.now()}`;
    const authUrl = metaService.buildAuthUrl({ state });
    logger.info('auth.facebook.url_issued', { user_id });
    res.json({ authUrl });
  } catch (err) {
    logger.error('auth.facebook.url_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to generate Facebook authorization URL' });
  }
});

router.get('/facebook/callback', async (req, res) => {
  const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
  try {
    const { code, state, error, error_description } = req.query;

    // User cancelled or Meta rejected — bounce back with the reason.
    if (error) {
      logger.warn('auth.facebook.oauth_error', { error, error_description });
      return res.redirect(
        `${frontend}/connections?meta_error=${encodeURIComponent(error_description || error)}`
      );
    }
    if (!code) return res.redirect(`${frontend}/connections?meta_error=no_code`);

    let extractedUserId = null;
    if (state && state.startsWith('meta_')) {
      const parts = state.split('_');
      if (parts.length >= 3) extractedUserId = parts[1];
    }
    if (!extractedUserId) return res.redirect(`${frontend}/connections?meta_error=invalid_state`);

    // 1. Short-lived user token → 2. Long-lived user token (~60d)
    const short = await metaService.exchangeCodeForToken({ code });
    const long = await metaService.getLongLivedUserToken(short.access_token);
    const longToken = long.access_token;
    const expiresAt = long.expires_in
      ? new Date(Date.now() + long.expires_in * 1000).toISOString()
      : null;

    // 3. Who is this Meta user?
    const me = await metaService.getMe(longToken);

    // 4. Enumerate Pages the user admins + linked IG business accounts
    const pages = await metaService.listPages(longToken);

    logger.info('auth.facebook.callback_ok', {
      user_id: extractedUserId,
      meta_user_id: me?.id,
      pages_count: pages.length,
      pages_with_ig: pages.filter(p => p.instagram_business_account).length,
      token_expires_at: expiresAt,
    });

    const created = { pages: 0, instagrams: 0, errors: [] };
    for (const page of pages) {
      try {
        const pageRow = await connectionsService.upsertFacebookPage({
          userId: extractedUserId,
          pageId: page.id,
          pageName: page.name,
          category: page.category,
          tasks: page.tasks,
          pictureUrl: page.picture?.data?.url,
          pageAccessToken: page.access_token,
          metaUserId: me?.id,
          ownerUserToken: longToken,
          ownerUserTokenExpiresAt: expiresAt,
        });
        created.pages += 1;

        if (page.instagram_business_account?.id) {
          try {
            await connectionsService.upsertInstagramBusiness({
              userId: extractedUserId,
              igBusinessId: page.instagram_business_account.id,
              igUsername: page.instagram_business_account.username,
              linkedPageId: page.id,
              linkedPageConnectionId: pageRow.id,
              pageAccessToken: page.access_token,
              pictureUrl: page.instagram_business_account.profile_picture_url,
            });
            created.instagrams += 1;
          } catch (e) {
            created.errors.push({ page: page.id, kind: 'ig', message: e.message });
            logger.warn('auth.facebook.ig_upsert_failed', { page_id: page.id, error: e.message });
          }
        }
      } catch (e) {
        created.errors.push({ page: page.id, kind: 'page', message: e.message });
        logger.warn('auth.facebook.page_upsert_failed', { page_id: page.id, error: e.message });
      }
    }

    logger.info('auth.facebook.connected', {
      user_id: extractedUserId,
      pages_created: created.pages,
      instagrams_created: created.instagrams,
      error_count: created.errors.length,
    });

    // If the user granted the app but admins zero Pages, still redirect with a
    // hint — otherwise the UI shows a silently-empty Connections list.
    const query = new URLSearchParams({
      meta_connected: '1',
      pages: String(created.pages),
      ig: String(created.instagrams),
    });
    if (created.pages === 0) query.set('meta_warning', 'no_pages_found');
    res.redirect(`${frontend}/connections?${query.toString()}`);
  } catch (err) {
    const normalized = err.response?.data?.error?.message || err.message;
    logger.error('auth.facebook.callback_failed', {
      error: normalized,
      status: err.response?.status,
      stack: err.stack?.slice(0, 1500),
    });
    res.redirect(`${frontend}/connections?meta_error=${encodeURIComponent(normalized)}`);
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