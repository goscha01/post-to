// Resolves an incoming Host header to the user_id that owns the domain.
//
// Lookup source: connected_accounts where provider='blog_domain', with
// metadata.hostname matching. A tiny in-memory cache avoids hammering
// Supabase on every request; cache TTL is short so a newly-added domain
// starts working within a minute without a service restart.

const supabase = require('./supabase');
const logger = require('./logger');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // hostname -> { userId, connectionId, metadata, expiresAt }

function normalizeHost(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/^www\./, '').split(':')[0];
}

async function resolveHost(hostRaw) {
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
    logger.error('host_resolver.query_failed', { host, error: error.message });
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

function invalidateHost(hostRaw) {
  cache.delete(normalizeHost(hostRaw));
}

module.exports = { resolveHost, invalidateHost, normalizeHost };
