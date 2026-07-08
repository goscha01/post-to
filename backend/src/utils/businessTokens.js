// Helper for multi-profile GMB calls.
//
// `tryWithEachBusinessToken(userId, fallbackToken, fn)` iterates over every
// OAuth token in the user's `business_profiles` JSONB column and calls `fn`
// with each one until one succeeds. Returns the first non-null result.
//
// Token freshness:
//   1. PROACTIVE: any token whose `token_expiry` is in the past gets a
//      refresh attempt before the loop, and the user's business_profiles
//      JSONB is patched with the new access_token + expiry.
//   2. REACTIVE: if `fn` throws a 401 we refresh that profile's token and
//      retry once.
//
// `fallbackToken` is used when the user has no business_profiles entries.

const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

function statusOf(err) {
  if (err?.response?.status) return err.response.status;
  if (typeof err?.status === 'number') return err.status;
  if (typeof err?.code === 'number') return err.code;
  return null;
}

function isExpired(token_expiry, skewMs = 60_000) {
  if (!token_expiry) return false; // unknown → assume valid; refresh-on-401 will handle
  return new Date(token_expiry).getTime() <= Date.now() + skewMs;
}

async function refreshOneToken(userId, profile) {
  if (!profile?.refresh_token) {
    throw new Error('no refresh_token for ' + (profile?.email || 'unknown profile'));
  }
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: profile.refresh_token });
  const { credentials } = await oauth2.refreshAccessToken();

  const newAccessToken = credentials.access_token;
  const newExpiry = credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null;

  // Patch the business_profiles array on disk so future requests see the new token.
  if (userId) {
    const { data: row } = await supabase
      .from('users')
      .select('business_profiles')
      .eq('id', userId)
      .single();
    const list = Array.isArray(row?.business_profiles) ? row.business_profiles : [];
    // Match by google_id first, then by stale access_token, then by email.
    const idx = list.findIndex(p =>
      (profile.google_id && p.business_google_id === profile.google_id) ||
      p.access_token === profile.access_token ||
      (profile.email && p.business_email === profile.email)
    );
    if (idx >= 0) {
      list[idx] = { ...list[idx], access_token: newAccessToken, token_expiry: newExpiry };
      await supabase.from('users').update({ business_profiles: list }).eq('id', userId);
    }
  }

  return newAccessToken;
}

async function tryWithEachBusinessToken(userId, fallbackToken, fn) {
  let tokens = [];
  if (userId) {
    const { data } = await supabase
      .from('users')
      .select('business_profiles')
      .eq('id', userId)
      .single();
    if (Array.isArray(data?.business_profiles)) {
      tokens = data.business_profiles
        .filter(p => p && p.access_token)
        .map(p => ({
          access_token: p.access_token,
          refresh_token: p.refresh_token,
          token_expiry: p.token_expiry,
          email: p.business_email || null,
          google_id: p.business_google_id || null
        }));
    }
  }
  if (tokens.length === 0 && fallbackToken) {
    tokens = [{ access_token: fallbackToken }];
  }
  if (tokens.length === 0) {
    return { ok: false, error: new Error('No business OAuth tokens for user') };
  }

  // PROACTIVE refresh: any expired token gets a fresh access_token before we
  // iterate. Failures here are non-fatal — the loop will still try the stale
  // token and the reactive path will catch 401s.
  await Promise.all(tokens.map(async (t, i) => {
    if (!t.refresh_token || !userId) return;
    if (!isExpired(t.token_expiry)) return;
    try {
      const newToken = await refreshOneToken(userId, t);
      tokens[i] = { ...t, access_token: newToken };
    } catch (e) {
      console.warn('[businessTokens] proactive refresh failed for', t.email || '(unknown)', '-', e.message);
    }
  }));

  let lastError = null;
  const tried = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    tried.push(t.email || t.google_id || 'unknown');

    let attemptToken = t.access_token;
    for (let pass = 0; pass < 2; pass++) {
      try {
        const result = await fn(attemptToken, t);
        if (result === null || result === undefined) {
          lastError = Object.assign(new Error('no data'), { code: 404 });
          break; // try next profile (don't refresh on "no data")
        }
        return { ok: true, result, profile: t, tried };
      } catch (err) {
        const s = statusOf(err);
        // REACTIVE refresh: one retry on 401 if we have a refresh_token.
        if (s === 401 && pass === 0 && t.refresh_token && userId) {
          try {
            attemptToken = await refreshOneToken(userId, t);
            console.warn('[businessTokens] refreshed token for', t.email || '(unknown)', '— retrying once');
            continue; // retry pass
          } catch (e) {
            console.warn('[businessTokens] reactive refresh failed for', t.email || '(unknown)', '-', e.message);
            lastError = err;
            break;
          }
        }
        if (s === 401 || s === 403 || s === 404) {
          lastError = err;
          break;
        }
        console.error('[businessTokens] non-retryable error from', t.email || '(token)', '— status:', s, 'msg:', err.message);
        return { ok: false, error: err, profile: t, tried };
      }
    }
  }
  console.error('[businessTokens] all tokens (' + tried.join(', ') + ') failed; lastError:', lastError?.message);
  return { ok: false, error: lastError, allUnauthorized: true, tried };
}

// Returns every business_profile token for the user, with expired ones
// proactively refreshed (patched back to disk). Callers that want to fan
// out an API call across every connected Google account (e.g. GA4 property
// discovery) should use this instead of req.businessToken — which only
// reflects the most-recently-connected account.
async function getAllBusinessTokens(userId) {
  if (!userId) return [];
  const { data } = await supabase
    .from('users')
    .select('business_profiles')
    .eq('id', userId)
    .single();
  const list = Array.isArray(data?.business_profiles) ? data.business_profiles : [];
  const tokens = list
    .filter(p => p && p.access_token)
    .map(p => ({
      access_token: p.access_token,
      refresh_token: p.refresh_token,
      token_expiry: p.token_expiry,
      email: p.business_email || null,
      google_id: p.business_google_id || null,
    }));

  // Proactive refresh — same pattern as tryWithEachBusinessToken above.
  await Promise.all(tokens.map(async (t, i) => {
    if (!t.refresh_token || !isExpired(t.token_expiry)) return;
    try {
      const newToken = await refreshOneToken(userId, t);
      tokens[i] = { ...t, access_token: newToken };
    } catch (e) {
      console.warn('[businessTokens] getAllBusinessTokens refresh failed for', t.email || '(unknown)', '-', e.message);
    }
  }));
  return tokens;
}

module.exports = { tryWithEachBusinessToken, getAllBusinessTokens, refreshOneToken };
