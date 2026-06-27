// Helper for multi-profile GMB calls.
//
// `tryWithEachBusinessToken(userId, fallbackToken, fn)` iterates over every
// OAuth token in the user's `business_profiles` JSONB column and calls `fn`
// with each one until one succeeds. "Success" = fn returns without throwing
// AND the returned value isn't `null`/`undefined`. If `fn` throws a 401/403/
// 404 (i.e. "this token can't access this resource"), we try the next token.
// Any other error short-circuits and is returned.
//
// `fallbackToken` is used when the user has no business_profiles entries yet
// (legacy users still on the single-column setup).

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

function statusOf(err) {
  // Prefer the HTTP response status (always numeric) over axios's `err.code`
  // which is a string like 'ERR_BAD_REQUEST' / 'ERR_NETWORK' for HTTP failures.
  if (err?.response?.status) return err.response.status;
  if (typeof err?.status === 'number') return err.status;
  if (typeof err?.code === 'number') return err.code;
  return null;
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

  let lastError = null;
  const tried = [];
  for (const t of tokens) {
    tried.push(t.email || t.google_id || 'unknown');
    try {
      const result = await fn(t.access_token, t);
      if (result === null || result === undefined) {
        // Treat as "this token has no data for this resource"; try next.
        lastError = Object.assign(new Error('no data'), { code: 404 });
        continue;
      }
      return { ok: true, result, profile: t, tried };
    } catch (err) {
      const s = statusOf(err);
      if (s === 401 || s === 403 || s === 404) {
        lastError = err;
        continue;
      }
      console.error('[businessTokens] non-retryable error from', t.email || '(token)', '— status:', s, 'msg:', err.message);
      return { ok: false, error: err, profile: t, tried };
    }
  }
  console.error('[businessTokens] all tokens (' + tried.join(', ') + ') returned 401/403/404; lastError:', lastError?.message);
  return { ok: false, error: lastError, allUnauthorized: true, tried };
}

module.exports = { tryWithEachBusinessToken };
