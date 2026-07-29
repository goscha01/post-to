// Blog custom-domain management.
//
// Attaches user-owned subdomains (e.g. blog.spotless.homes) to the
// post-to-blogs Vercel project via Vercel's Domains API. That project is
// a Next.js app that reads the incoming Host header and serves the right
// user's published articles.
//
// Previously implemented against Railway's customDomain API; migrated to
// Vercel because Railway's edge routing never activated custom-domain
// hostnames even with syncStatus=ACTIVE + valid cert (see git log around
// 2026-07-29 for the debugging trail).
//
// The connected_accounts row we persist is authoritative for the blogs
// renderer's host resolver, which reads directly from Supabase.

const dns = require('dns').promises;
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');
const { fetchSiteTheme } = require('./connectionsService');

// Given a blog subdomain like `blog.spotless.homes`, return the URL of the
// most likely main-site homepage to scrape theme signals from. Strips the
// first label so `blog.foo.com` → `https://foo.com/`, `blog.co.uk` → itself
// (weird edge case, best-effort). If the caller already knows a linked
// `website` connection URL, they should pass that instead — this is only the
// fallback when we have nothing else.
function guessMainSiteUrl(hostname) {
  const parts = String(hostname || '').split('.').filter(Boolean);
  if (parts.length < 3) return `https://${hostname}/`;
  return `https://${parts.slice(1).join('.')}/`;
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const VERCEL_API = 'https://api.vercel.com';
const VERCEL_BLOG_PROJECT_ID =
  process.env.VERCEL_BLOG_PROJECT_ID || 'prj_kLuuU37i1AVYwmQ3GTLWGuRJPWf4';
// Vercel's official CNAME target for custom domains. Documented + stable.
const BLOG_CNAME_TARGET = process.env.BLOG_CNAME_TARGET || 'cname.vercel-dns.com';
// Vercel exposes team-scoped resources via ?teamId=. If unset the token's
// personal scope is used.
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || null;

function normalizeHost(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  if (s.split('.').length < 3) return null; // apex like foo.com — deferred
  return s;
}

async function vercelRequest(method, path, body) {
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) throw new Error('VERCEL_API_TOKEN not set — cannot manage blog domains');
  const url = new URL(VERCEL_API + path);
  if (VERCEL_TEAM_ID) url.searchParams.set('teamId', VERCEL_TEAM_ID);
  try {
    const res = await axios({
      method,
      url: url.toString(),
      data: body,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000,
      validateStatus: () => true,
    });
    return { status: res.status, data: res.data };
  } catch (err) {
    throw new Error(`Vercel API network error: ${err.message}`);
  }
}

// Fetch a domain's current state on our project. Returns null if the domain
// isn't attached to this project.
async function getVercelDomain(hostname) {
  const { status, data } = await vercelRequest(
    'GET',
    `/v9/projects/${VERCEL_BLOG_PROJECT_ID}/domains/${encodeURIComponent(hostname)}`
  );
  if (status === 200) return data;
  if (status === 404) return null;
  const msg = data?.error?.message || `Vercel getVercelDomain ${status}`;
  const err = new Error(msg);
  err.vercelStatus = status;
  err.vercelData = data;
  throw err;
}

// Attach hostname to the blog Vercel project. Idempotent — if already
// attached, returns the existing state.
async function attachVercelDomain(hostname) {
  const { status, data } = await vercelRequest(
    'POST',
    `/v10/projects/${VERCEL_BLOG_PROJECT_ID}/domains`,
    { name: hostname }
  );
  if (status === 200 || status === 201) return { ok: true, data };
  if (status === 409) {
    // Already attached to this or another project. If ours, fetch state.
    const existing = await getVercelDomain(hostname).catch(() => null);
    return { ok: !!existing, data: existing, error: existing ? null : (data?.error?.message || 'domain claimed by another project') };
  }
  return { ok: false, error: data?.error?.message || `Vercel attach ${status}` };
}

async function detachVercelDomain(hostname) {
  const { status, data } = await vercelRequest(
    'DELETE',
    `/v9/projects/${VERCEL_BLOG_PROJECT_ID}/domains/${encodeURIComponent(hostname)}`
  );
  if (status === 200 || status === 204 || status === 404) return { ok: true };
  return { ok: false, error: data?.error?.message || `Vercel detach ${status}` };
}

// Force a domain configuration + verification refresh. Called on verify so
// the domain's `verified` + `misconfigured` flags reflect real DNS state
// even if Vercel's poller hasn't caught up yet.
async function verifyVercelDomain(hostname) {
  const { status, data } = await vercelRequest(
    'POST',
    `/v9/projects/${VERCEL_BLOG_PROJECT_ID}/domains/${encodeURIComponent(hostname)}/verify`
  );
  if (status === 200 || status === 201) return { ok: true, data };
  return { ok: false, status, error: data?.error?.message || `Vercel verify ${status}` };
}

// Metadata fields that must NEVER leave the server. Blog publisher AWS creds
// live inside metadata for now (same pattern as other providers) so we strip
// them here before returning to the frontend.
const SENSITIVE_META_KEYS = ['s3_access_key_secret'];
function stripSensitiveMeta(row) {
  if (!row?.metadata) return row;
  const meta = { ...row.metadata };
  for (const k of SENSITIVE_META_KEYS) delete meta[k];
  return { ...row, metadata: meta };
}

async function listForUser(userId) {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id, provider, display_name, external_id, metadata, status, created_at, updated_at')
    .eq('user_id', userId)
    .eq('provider', 'blog_domain')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(stripSensitiveMeta);
}

// Server-only: returns the full row including sensitive metadata (S3 secret,
// etc.). Only publishers / verifiers should call this. Route handlers should
// go through the stripped equivalents.
async function getForUser({ userId, id }) {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'blog_domain')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Public / route-facing: strips sensitive metadata before returning.
function sanitize(row) { return stripSensitiveMeta(row); }

// Attach the hostname to Vercel first so we know it's accepted, then insert/
// update the DB row. cname_target is always Vercel's shared CNAME —
// simpler than Railway's per-domain unique target.
async function createDomain({ userId, hostname, siteName }) {
  const host = normalizeHost(hostname);
  if (!host) {
    const err = new Error('Invalid hostname. Use a subdomain like blog.yoursite.com');
    err.status = 400;
    throw err;
  }
  const externalId = `blog_domain:${host}`;
  const displayName = siteName || host;

  const attach = await attachVercelDomain(host);
  if (!attach.ok) {
    logger.error('blog_domain.vercel_attach_failed', { userId, hostname: host, error: attach.error });
    const err = new Error(`Failed to register with Vercel: ${attach.error}`);
    err.status = 502;
    throw err;
  }

  const { data: existing } = await supabase
    .from('connected_accounts')
    .select('id, metadata')
    .eq('user_id', userId)
    .eq('provider', 'blog_domain')
    .eq('external_id', externalId)
    .maybeSingle();

  // Auto-populate the theme (primary color / fonts / logo) from the user's
  // main site. We infer the main site URL from the blog subdomain (strip
  // leading label), scrape best-effort. Kept alongside site_name so the
  // renderer has everything it needs from one metadata blob.
  //
  // If the user already had a theme (previous create or manual override),
  // preserve it — re-scraping on re-add shouldn't clobber their tweaks.
  let theme = existing?.metadata?.theme;
  if (!theme || Object.keys(theme).length === 0) {
    const mainSiteUrl = guessMainSiteUrl(host);
    theme = await fetchSiteTheme(mainSiteUrl).catch(() => ({}));
    if (theme && Object.keys(theme).length > 0) {
      theme.scraped_at = new Date().toISOString();
      theme.scraped_from = mainSiteUrl;
      logger.info('blog_domain.theme_scraped', { userId, hostname: host, keys: Object.keys(theme) });
    }
  }

  const commonMetadata = {
    hostname: host,
    site_name: siteName || existing?.metadata?.site_name || null,
    cname_target: BLOG_CNAME_TARGET,
    vercel_project_id: VERCEL_BLOG_PROJECT_ID,
    theme: theme || {},
  };

  if (existing) {
    const mergedMetadata = { ...(existing.metadata || {}), ...commonMetadata };
    const { data, error } = await supabase
      .from('connected_accounts')
      .update({ display_name: displayName, metadata: mergedMetadata, status: 'active' })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    logger.info('blog_domain.updated', { userId, hostname: host, connectionId: data.id });
    return data;
  }

  const { data, error } = await supabase
    .from('connected_accounts')
    .insert({
      user_id: userId,
      provider: 'blog_domain',
      display_name: displayName,
      external_id: externalId,
      status: 'active',
      metadata: { ...commonMetadata, verified: false, created_via: 'dashboard' },
    })
    .select()
    .single();
  if (error) throw error;
  logger.info('blog_domain.created', { userId, hostname: host, connectionId: data.id });
  return data;
}

// Verify: check DNS, kick Vercel's verify endpoint, and if Vercel reports
// the domain as verified+configured, mark our row verified. Otherwise throw
// with the specific reason so the UI can guide the user.
async function verifyDomain({ userId, id }) {
  const record = await getForUser({ userId, id });
  if (!record) { const err = new Error('Domain not found'); err.status = 404; throw err; }
  const hostname = record.metadata?.hostname;
  if (!hostname) { const err = new Error('Domain record is missing hostname'); err.status = 400; throw err; }

  // Ensure Vercel still knows about the domain (self-heal if it was detached).
  let vercelDomain = await getVercelDomain(hostname).catch(() => null);
  if (!vercelDomain) {
    const attach = await attachVercelDomain(hostname);
    if (!attach.ok) {
      logger.error('blog_domain.vercel_attach_failed', { userId, hostname, error: attach.error });
      const err = new Error(`Failed to register with Vercel: ${attach.error}`);
      err.status = 502;
      throw err;
    }
    vercelDomain = await getVercelDomain(hostname).catch(() => null);
  }

  // Ping Vercel's own verify endpoint — kicks their DNS revalidation now
  // rather than waiting for their polling cycle.
  const verifyRes = await verifyVercelDomain(hostname);
  const verifiedByVercel = !!verifyRes.data?.verified;
  const misconfigured = vercelDomain?.misconfigured === true || vercelDomain?.verified === false;

  // Also do our own DNS check so we can tell the user what their record
  // currently resolves to in the error message.
  let currentCnames = [];
  let dnsErr = null;
  try {
    currentCnames = await dns.resolveCname(hostname);
  } catch (e) {
    dnsErr = e.code || e.message;
  }
  const expected = BLOG_CNAME_TARGET.toLowerCase().replace(/\.$/, '');
  const dnsOk = currentCnames.some(c => c.toLowerCase().replace(/\.$/, '') === expected);

  const fullyReady = verifiedByVercel && dnsOk;

  const updatedMeta = {
    ...record.metadata,
    cname_target: BLOG_CNAME_TARGET,
    vercel_project_id: VERCEL_BLOG_PROJECT_ID,
    vercel_domain_verified: verifiedByVercel,
    vercel_domain_misconfigured: misconfigured,
    railway_current_cname: currentCnames[0] || null, // legacy field name UI still reads
    verified: fullyReady,
    ...(fullyReady && !record.metadata?.verified_at ? { verified_at: new Date().toISOString() } : {}),
    last_check_at: new Date().toISOString(),
    last_check_cnames: currentCnames,
    last_check_error: fullyReady ? null : (!dnsOk ? (dnsErr || 'dns_not_matching') : 'vercel_not_verified'),
  };

  const { data, error } = await supabase
    .from('connected_accounts')
    .update({ metadata: updatedMeta, status: 'active' })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  if (fullyReady) {
    logger.info('blog_domain.verified', { userId, hostname, connectionId: id });
    return data;
  }

  const msg = !dnsOk
    ? `Waiting for DNS. CNAME for ${hostname} must point to ${BLOG_CNAME_TARGET}. Currently: ${currentCnames.join(', ') || '(none)'}`
    : `DNS is correct. Vercel is provisioning the SSL certificate — usually finishes in 30–90 seconds. Click Verify again shortly.`;
  const err = new Error(msg);
  err.status = 400;
  err.details = { requiredValue: BLOG_CNAME_TARGET, currentValue: currentCnames[0] || null, dnsOk, verifiedByVercel };
  err.domain = data;
  logger.info('blog_domain.verify_pending', { userId, hostname, dnsOk, verifiedByVercel });
  throw err;
}

// Re-run the theme scrape for an existing blog_domain row. Used to backfill
// rows created before theme-scrape shipped, and to let users refresh after
// they change their main site's design. Returns the updated row.
async function refreshTheme({ userId, id }) {
  const record = await getForUser({ userId, id });
  if (!record) { const err = new Error('Domain not found'); err.status = 404; throw err; }
  const hostname = record.metadata?.hostname;
  if (!hostname) { const err = new Error('Domain record is missing hostname'); err.status = 400; throw err; }

  const mainSiteUrl = guessMainSiteUrl(hostname);
  const theme = await fetchSiteTheme(mainSiteUrl).catch(() => ({}));
  const themeWithMeta = {
    ...theme,
    scraped_at: new Date().toISOString(),
    scraped_from: mainSiteUrl,
  };

  const { data, error } = await supabase
    .from('connected_accounts')
    .update({ metadata: { ...record.metadata, theme: themeWithMeta } })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  logger.info('blog_domain.theme_refreshed', { userId, hostname, connectionId: id, keys: Object.keys(theme || {}) });
  return data;
}

// Manual theme override. Accepts a subset of theme fields; unspecified fields
// are left alone. Passing null for a field clears it (falls back to renderer
// default). Field allowlist keeps arbitrary metadata out of the theme blob.
const THEME_FIELDS = ['primaryColor', 'fontFamily', 'fontsUrl', 'logoUrl'];
async function updateTheme({ userId, id, patch }) {
  const record = await getForUser({ userId, id });
  if (!record) { const err = new Error('Domain not found'); err.status = 404; throw err; }
  const current = record.metadata?.theme || {};
  const nextTheme = { ...current };
  for (const key of THEME_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
      const v = patch[key];
      if (v === null || v === '') delete nextTheme[key];
      else nextTheme[key] = String(v);
    }
  }
  nextTheme.overridden_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('connected_accounts')
    .update({ metadata: { ...record.metadata, theme: nextTheme } })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  logger.info('blog_domain.theme_updated', { userId, connectionId: id, keys: Object.keys(patch || {}) });
  return data;
}

async function deleteDomain({ userId, id }) {
  const record = await getForUser({ userId, id });
  if (!record) return { ok: true };
  const hostname = record.metadata?.hostname;
  if (hostname) await detachVercelDomain(hostname); // best-effort
  const { error } = await supabase
    .from('connected_accounts')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
  logger.info('blog_domain.deleted', { userId, connectionId: id, hostname });
  return { ok: true };
}

module.exports = {
  normalizeHost,
  BLOG_CNAME_TARGET,
  listForUser,
  getForUser,
  createDomain,
  verifyDomain,
  deleteDomain,
  refreshTheme,
  updateTheme,
  sanitize,
};
