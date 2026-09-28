const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const authMiddleware = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user exists in database
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, google_id, access_token')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // NOTE: Do not gate on `users.access_token` here. It's the initial Google
    // OAuth access_token from signup — short-lived, never renewed by
    // /auth/refresh (which only rotates business_access_token), and never
    // read by any route (grep confirms zero req.user.accessToken usage).
    // Gating on it caused a 401 → refresh-fails → logout() cycle for any
    // user whose Google session went stale, including users trying to use
    // features (ASC, Meta Ads, etc.) that have no relation to Google OAuth.
    // JWT validity above is the real auth artifact.

    // Add user info to request
    req.user = {
      userId: user.id,
      email: user.email,
      googleId: user.google_id,
      accessToken: user.access_token
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    } else {
      return res.status(500).json({ error: 'Authentication failed' });
    }
  }
};

module.exports = authMiddleware;