// Resolves an incoming Host header to the user_id that owns the domain.
//
// Lookup source: connected_accounts where provider='blog_domain', with
// external_id matching. A tiny in-memory cache avoids hammering Supabase on
// every request. On Vercel, module-level caches persist across invocations
// that reuse a warm serverless instance.

import supabase from './supabase';

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // hostname -> { userId, connectionId, metadata, hostname, expiresAt }

export function normalizeHost(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/^www\./, '').split(':')[0];
}

export async function resolveHost(hostRaw) {
  const host = normalizeHost(hostRaw);
  if (!host) return null;

  const cached = cache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id, user_id, metadata, status')
    .eq('provider', 'blog_domain')
    .eq('external_id', `blog_domain:${host}`)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('host_resolver.query_failed', host, error.message);
    return null;
  }
  if (!data || data.status !== 'active' || !data.metadata?.verified) {
    cache.set(host, { userId: null, expiresAt: Date.now() + CACHE_TTL_MS });
    return null;
  }

  const record = {
    userId: data.user_id,
    connectionId: data.id,
    metadata: data.metadata,
    hostname: host,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  cache.set(host, record);
  return record;
}
