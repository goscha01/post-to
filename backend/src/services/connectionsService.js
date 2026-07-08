// Shared helpers for the unified `connected_accounts` table.
//
// Providers handled today: 'website' (URL-only) and 'google_business' (rows
// written from the existing OAuth callback so the new picker UI sees them).
// Adding instagram/facebook later will just be another upsert call here.

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const TABLE = 'connected_accounts';

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Tiny HTML scraper — regex-based so no new dependency. Pulls title, meta
// description, og: tags. Best-effort: failures return whatever we found.
function extractMeta(html) {
  const out = {};
  if (!html || typeof html !== 'string') return out;
  const head = html.slice(0, 200000); // cap for safety

  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) out.title = title[1].replace(/\s+/g, ' ').trim();

  const metaRe = /<meta\s+([^>]+)>/gi;
  let m;
  while ((m = metaRe.exec(head)) !== null) {
    const attrs = m[1];
    const nameMatch = attrs.match(/(?:name|property)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = attrs.match(/content\s*=\s*["']([^"']*)["']/i);
    if (!nameMatch || !contentMatch) continue;
    const key = nameMatch[1].toLowerCase();
    const val = contentMatch[1].trim();
    if (key === 'description' && !out.description) out.description = val;
    if (key === 'og:title' && !out.ogTitle) out.ogTitle = val;
    if (key === 'og:description' && !out.ogDescription) out.ogDescription = val;
    if (key === 'og:site_name' && !out.siteName) out.siteName = val;
    if (key === 'og:image' && !out.ogImage) out.ogImage = val;
    if (key === 'keywords' && !out.keywords) out.keywords = val;
  }
  return out;
}

async function fetchSiteMeta(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PostToBot/1.0; +https://post-to.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      validateStatus: s => s >= 200 && s < 400,
    });
    return { ok: true, status: res.status, finalUrl: res.request?.res?.responseUrl || url, meta: extractMeta(res.data) };
  } catch (err) {
    logger.warn('connections.website.fetch_failed', { url, error: err.message, status: err.response?.status });
    return { ok: false, status: err.response?.status || null, error: err.message, meta: {} };
  }
}

async function listForUser(userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getForUser(userId, id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
}

async function deleteForUser(userId, id) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('user_id', userId)
    .eq('id', id);
  if (error) throw error;
}

// Insert or refresh a website connection. We dedupe per user on (provider, external_id).
async function upsertWebsite({ userId, url }) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw new Error('Invalid URL');

  const fetched = await fetchSiteMeta(normalized);
  const host = hostOf(fetched.finalUrl || normalized);

  const displayName =
    fetched.meta.siteName ||
    fetched.meta.ogTitle ||
    fetched.meta.title ||
    host;

  const metadata = {
    url: normalized,
    host,
    fetched_at: new Date().toISOString(),
    fetch_ok: fetched.ok,
    fetch_status: fetched.status,
    fetch_error: fetched.ok ? undefined : fetched.error,
    title: fetched.meta.title,
    description: fetched.meta.description || fetched.meta.ogDescription,
    og_image: fetched.meta.ogImage,
    keywords: fetched.meta.keywords,
  };

  // Upsert by (user_id, provider, external_id). Manual select-then-update so
  // we don't need a Postgres on-conflict target the schema may not expose.
  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'website')
    .eq('external_id', normalized)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        display_name: displayName,
        metadata,
        status: fetched.ok ? 'active' : 'error',
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      provider: 'website',
      display_name: displayName,
      external_id: normalized,
      metadata,
      status: fetched.ok ? 'active' : 'error',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Called from the GMB OAuth callback so the unified list reflects the
// Google Business profile that was just connected. Idempotent per
// (user_id, business_google_id).
async function upsertGoogleBusiness({ userId, businessGoogleId, businessEmail, displayName }) {
  if (!userId || !businessGoogleId) return null;
  const externalId = `google:${businessGoogleId}`;
  const metadata = {
    business_google_id: businessGoogleId,
    business_email: businessEmail || null,
    connected_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'google_business')
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        display_name: displayName || businessEmail || 'Google Business Profile',
        metadata,
        status: 'active',
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      provider: 'google_business',
      display_name: displayName || businessEmail || 'Google Business Profile',
      external_id: externalId,
      metadata,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Called from the analytics property-selection endpoint so a picked GA4
// property shows up alongside GMB / website in the unified list. Tokens live
// on users.business_profiles (same OAuth grant as GMB); this row only mirrors
// the property identity for the UI list + business filter.
async function upsertGoogleAnalytics({ userId, propertyId, displayName, accountId, businessGoogleId, ownerGoogleId, ownerEmail }) {
  if (!userId || !propertyId) throw new Error('userId and propertyId required');
  const externalId = `ga4:${propertyId}`;
  const metadata = {
    property_id: propertyId,
    account_id: accountId || null,
    business_google_id: businessGoogleId || null,
    // Which connected Google account owns this GA4 property. Used to route
    // report API calls to the correct OAuth token when multiple Google
    // accounts are connected. Null for rows saved before multi-account
    // support landed — those fall back to the top-level business token.
    owner_google_id: ownerGoogleId || null,
    owner_email: ownerEmail || null,
    connected_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'google_analytics')
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        display_name: displayName || `GA4 Property ${propertyId}`,
        metadata,
        status: 'active',
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      provider: 'google_analytics',
      display_name: displayName || `GA4 Property ${propertyId}`,
      external_id: externalId,
      metadata,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Called from the Google Ads customer-selection endpoint so a picked Ads
// account shows up alongside GMB / GA4 / website. Tokens live on
// users.business_profiles (same OAuth grant); this row only mirrors the
// customer identity for the UI + business filter.
async function upsertGoogleAds({
  userId,
  customerId,
  descriptiveName,
  managerCustomerId,
  currencyCode,
  timeZone,
  ownerGoogleId,
  ownerEmail,
}) {
  if (!userId || !customerId) throw new Error('userId and customerId required');
  const externalId = `ads:${customerId}`;
  const metadata = {
    customer_id: customerId,
    manager_customer_id: managerCustomerId || null,
    currency_code: currencyCode || null,
    time_zone: timeZone || null,
    // Which connected Google account owns this Ads customer. Used to route
    // report API calls to the correct OAuth token when the user has multiple
    // Google accounts connected. Null for rows saved before multi-account
    // support — fall back to the top-level business token.
    owner_google_id: ownerGoogleId || null,
    owner_email: ownerEmail || null,
    connected_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'google_ads')
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        display_name: descriptiveName || `Google Ads ${customerId}`,
        metadata,
        status: 'active',
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      provider: 'google_ads',
      display_name: descriptiveName || `Google Ads ${customerId}`,
      external_id: externalId,
      metadata,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  listForUser,
  getForUser,
  deleteForUser,
  upsertWebsite,
  upsertGoogleBusiness,
  upsertGoogleAnalytics,
  upsertGoogleAds,
  // exposed for tests / future callers
  _internal: { normalizeUrl, hostOf, extractMeta, fetchSiteMeta },
};
