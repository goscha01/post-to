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
    // Brand color hint used by mobile chrome / installed PWAs. Good proxy
    // for "the site's accent color" when they have one set.
    if (key === 'theme-color' && !out.themeColor) out.themeColor = val;
  }
  return out;
}

// Extract theme signals (accent color, fonts URL, logo URL) from a page's HTML
// head. Best-effort regex — never throws, returns partial data. Used to
// auto-populate the base look of a customer's blog subdomain so it looks
// recognizably like their main site without manual configuration.
function extractTheme(html, baseUrl) {
  const out = {};
  if (!html || typeof html !== 'string') return out;
  const head = html.slice(0, 200000);

  // Absolutize relative URLs against the fetched page URL.
  const absolutize = (url) => {
    try { return new URL(url, baseUrl).toString(); } catch { return null; }
  };

  // theme-color meta tag → primary/accent color
  const themeColor = head.match(/<meta[^>]*(?:name|property)\s*=\s*["']theme-color["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || head.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:name|property)\s*=\s*["']theme-color["']/i);
  if (themeColor) out.primaryColor = themeColor[1].trim();

  // First Google Fonts stylesheet link — usually captures the site's main
  // font. Preserve the full URL so all weights the site loaded come along.
  const fontsLink = head.match(/<link[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/css2?\?[^"']+)["']/i)
    || head.match(/<link[^>]*href\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/css2?\?[^"']+)["'][^>]*rel\s*=\s*["']stylesheet["']/i);
  if (fontsLink) {
    out.fontsUrl = fontsLink[1];
    // Try to also extract the primary family name so we can set body font
    // family without loading the actual font file (font already loaded via
    // fontsUrl link).
    const famMatch = fontsLink[1].match(/family=([^&:+]+)/i);
    if (famMatch) out.fontFamily = decodeURIComponent(famMatch[1].replace(/\+/g, ' '));
  }

  // Logo — prefer apple-touch-icon (usually higher-res + no favicon fallback
  // squishing), then icon rel, then og:image.
  const appleIcon = head.match(/<link[^>]*rel\s*=\s*["']apple-touch-icon(?:-precomposed)?["'][^>]*href\s*=\s*["']([^"']+)["']/i);
  const iconLink = head.match(/<link[^>]*rel\s*=\s*["'](?:shortcut )?icon["'][^>]*href\s*=\s*["']([^"']+)["']/i);
  const ogImage = head.match(/<meta[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i);
  const rawLogo = appleIcon?.[1] || iconLink?.[1] || ogImage?.[1];
  if (rawLogo) {
    const abs = absolutize(rawLogo);
    if (abs) out.logoUrl = abs;
  }

  return out;
}

// Public helper: fetch a page and return theme signals only. Used by blog
// domain creation to auto-populate metadata.theme. Best-effort, all fields
// optional in the returned object.
async function fetchSiteTheme(rawUrl) {
  try {
    const url = normalizeUrl(rawUrl);
    if (!url) return {};
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
    const finalUrl = res.request?.res?.responseUrl || url;
    return extractTheme(res.data, finalUrl);
  } catch (err) {
    logger.warn('connections.theme.fetch_failed', { url: rawUrl, error: err.message });
    return {};
  }
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

// Fields inside metadata that must never leave the server (BYO API keys, OAuth
// tokens etc.). Strip before returning to the caller. Callers that need the
// raw value should call getRawForUser instead.
const SENSITIVE_METADATA_KEYS = ['api_key', 'page_access_token', 'user_access_token'];

function stripSensitiveMetadata(row) {
  if (!row || !row.metadata) return row;
  const meta = { ...row.metadata };
  for (const k of SENSITIVE_METADATA_KEYS) delete meta[k];
  return { ...row, metadata: meta };
}

async function listForUser(userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(stripSensitiveMetadata);
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
  return stripSensitiveMetadata(data);
}

// Same as getForUser but preserves sensitive metadata (api_key etc.). Only
// server-side call sites that need to actually hit the provider API should use
// this — never expose the result to the client.
async function getRawForUser(userId, id) {
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

// OpenAI Ads (ads.openai.com). Unlike the google_* providers, this is a
// bring-your-own API key flow, not OAuth — users create a key at
// ads.openai.com/settings and paste it in. The key lives in metadata.api_key
// and is stripped from list/get responses by stripSensitiveMetadata. Only
// server-side callers that actually hit the OpenAI Ads API should look it up
// via getRawForUser.
function maskApiKey(key) {
  if (!key || typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

function normalizeAdAccountId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  // Users paste either the raw id (adacct_…) or the full settings URL. Pull
  // the adacct_… segment out either way.
  const m = s.match(/adacct_[A-Za-z0-9]+/);
  if (m) return m[0];
  // Fall back to whatever the user typed if it looks id-shaped.
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
  return null;
}

async function upsertOpenAiAds({ userId, apiKey, adAccountId, accountName }) {
  if (!userId) throw new Error('userId required');
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('API key required');
  }
  const cleanKey = apiKey.trim();
  const normalizedAcct = normalizeAdAccountId(adAccountId);
  if (!normalizedAcct) throw new Error('Invalid ad account ID');

  const externalId = `openai_ads:${normalizedAcct}`;
  const metadata = {
    ad_account_id: normalizedAcct,
    account_name: accountName || null,
    api_key: cleanKey,
    api_key_mask: maskApiKey(cleanKey),
    connected_at: new Date().toISOString(),
  };
  const displayName = accountName || `OpenAI Ads ${normalizedAcct}`;

  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'openai_ads')
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ display_name: displayName, metadata, status: 'active' })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return stripSensitiveMetadata(data);
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      provider: 'openai_ads',
      display_name: displayName,
      external_id: externalId,
      metadata,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return stripSensitiveMetadata(data);
}

// Called from the Search Console site-selection endpoint so a picked GSC
// property shows up alongside GMB / GA4 / Ads / website. Tokens live on
// users.business_profiles (same OAuth grant — webmasters.readonly added to
// BUSINESS_SCOPES); this row only mirrors the site identity for the UI +
// per-connection GSC queries.
async function upsertGoogleSearchConsole({ userId, siteUrl, displayName, permissionLevel, ownerGoogleId, ownerEmail }) {
  if (!userId || !siteUrl) throw new Error('userId and siteUrl required');
  const externalId = `gsc:${siteUrl}`;
  const metadata = {
    site_url: siteUrl,
    permission_level: permissionLevel || null,
    // Which connected Google account owns this GSC property. Used to route
    // searchanalytics.query calls to the correct OAuth token when multiple
    // Google accounts are connected.
    owner_google_id: ownerGoogleId || null,
    owner_email: ownerEmail || null,
    connected_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'google_search_console')
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        display_name: displayName || siteUrl,
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
      provider: 'google_search_console',
      display_name: displayName || siteUrl,
      external_id: externalId,
      metadata,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Facebook Page — one row per FB Page the user admins. Page Access Token
// lives in metadata.page_access_token (stripped by SENSITIVE_METADATA_KEYS on
// read). Fetched via /me/accounts during the Meta OAuth callback in auth.js.
async function upsertFacebookPage({
  userId,
  pageId,
  pageName,
  category,
  pageAccessToken,
  metaUserId,
  ownerUserToken,
  ownerUserTokenExpiresAt,
  pictureUrl,
  tasks,
}) {
  if (!userId || !pageId) throw new Error('userId and pageId required');
  if (!pageAccessToken) throw new Error('pageAccessToken required');
  const externalId = `fb_page:${pageId}`;
  const metadata = {
    page_id: pageId,
    page_name: pageName || null,
    category: category || null,
    tasks: Array.isArray(tasks) ? tasks : null,
    picture_url: pictureUrl || null,
    page_access_token: pageAccessToken, // stripped on read
    meta_user_id: metaUserId || null,
    owner_user_token: ownerUserToken || null, // stripped on read
    owner_user_token_expires_at: ownerUserTokenExpiresAt || null,
    connected_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'facebook')
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        display_name: pageName || `Facebook Page ${pageId}`,
        metadata,
        status: 'active',
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return stripSensitiveMetadata(data);
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      provider: 'facebook',
      display_name: pageName || `Facebook Page ${pageId}`,
      external_id: externalId,
      metadata,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return stripSensitiveMetadata(data);
}

// Instagram Business account — always associated with a FB Page. We store the
// SAME page_access_token here (posting to IG uses the linked Page's token,
// per Graph API design) plus the fb_page connected_accounts.id for join
// convenience. Dedupe on the IG business id.
async function upsertInstagramBusiness({
  userId,
  igBusinessId,
  igUsername,
  linkedPageId,
  linkedPageConnectionId,
  pageAccessToken,
  pictureUrl,
}) {
  if (!userId || !igBusinessId) throw new Error('userId and igBusinessId required');
  if (!pageAccessToken) throw new Error('pageAccessToken required');
  const externalId = `ig_business:${igBusinessId}`;
  const metadata = {
    ig_business_id: igBusinessId,
    ig_username: igUsername || null,
    linked_page_id: linkedPageId || null,
    linked_page_connection_id: linkedPageConnectionId || null,
    picture_url: pictureUrl || null,
    page_access_token: pageAccessToken, // stripped on read
    connected_at: new Date().toISOString(),
  };
  const displayName = igUsername ? `@${igUsername}` : `Instagram ${igBusinessId}`;

  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'instagram')
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ display_name: displayName, metadata, status: 'active' })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return stripSensitiveMetadata(data);
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      provider: 'instagram',
      display_name: displayName,
      external_id: externalId,
      metadata,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return stripSensitiveMetadata(data);
}

// Backfill missing picture_url for FB Page rows saved before the picture
// field syntax fix (2026-07-28). Cheap on steady state: single SELECT + zero
// writes when every FB row already has picture_url. Safe to re-run.
async function reconcileFacebookPictures(userId) {
  if (!userId) return { updated: 0, skipped: 0 };
  const { data: rows, error } = await supabase
    .from(TABLE)
    .select('id, metadata')
    .eq('user_id', userId)
    .eq('provider', 'facebook');
  if (error || !rows || rows.length === 0) return { updated: 0, skipped: 0 };

  // Lazy require to avoid circular dep on module load.
  const meta = require('./metaService');

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const md = row.metadata || {};
    if (md.picture_url) { skipped += 1; continue; }
    const pic = await meta.fetchPagePicture({
      pageId: md.page_id,
      pageAccessToken: md.page_access_token,
    });
    if (!pic) { skipped += 1; continue; }
    const nextMeta = { ...md, picture_url: pic };
    const { error: upErr } = await supabase
      .from(TABLE)
      .update({ metadata: nextMeta })
      .eq('id', row.id);
    if (!upErr) updated += 1;
  }
  if (updated > 0) {
    logger.info('connections.reconcile_facebook_pictures', { user_id: userId, updated, skipped });
  }
  return { updated, skipped };
}

// Backfill missing google_business rows for a user by walking their
// users.business_profiles JSONB. Older OAuth grants (pre-2026-06-26, before
// upsertGoogleBusiness was wired into the callback) exist in
// business_profiles but have no matching connected_accounts row — the
// Connections page therefore doesn't show them. Called on every GET
// /api/connections so the list is self-healing: cheap on steady state
// (a single SELECT + zero writes when nothing is missing), safe to re-run.
async function reconcileGoogleBusiness(userId) {
  if (!userId) return { added: 0, skipped: 0 };
  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('business_profiles')
    .eq('id', userId)
    .single();
  if (userErr || !userRow) return { added: 0, skipped: 0 };
  const profiles = Array.isArray(userRow.business_profiles) ? userRow.business_profiles : [];
  if (profiles.length === 0) return { added: 0, skipped: 0 };

  const { data: existingRows, error: existingErr } = await supabase
    .from(TABLE)
    .select('external_id')
    .eq('user_id', userId)
    .eq('provider', 'google_business');
  if (existingErr) return { added: 0, skipped: 0 };
  const have = new Set((existingRows || []).map((r) => r.external_id));

  let added = 0;
  let skipped = 0;
  for (const p of profiles) {
    const googleId = p?.business_google_id;
    if (!googleId) {
      skipped += 1;
      continue;
    }
    const externalId = `google:${googleId}`;
    if (have.has(externalId)) {
      skipped += 1;
      continue;
    }
    try {
      await upsertGoogleBusiness({
        userId,
        businessGoogleId: googleId,
        businessEmail: p.business_email || null,
        displayName: p.business_email || 'Google Business Profile',
      });
      added += 1;
    } catch (e) {
      logger.warn('connections.reconcile_google_business_error', {
        user_id: userId,
        google_id: googleId,
        error: e?.message,
      });
    }
  }
  if (added > 0) {
    logger.info('connections.reconcile_google_business', { user_id: userId, added, skipped });
  }
  return { added, skipped };
}

module.exports = {
  listForUser,
  getForUser,
  getRawForUser,
  deleteForUser,
  upsertWebsite,
  upsertGoogleBusiness,
  reconcileGoogleBusiness,
  upsertGoogleAnalytics,
  upsertGoogleAds,
  upsertGoogleSearchConsole,
  upsertOpenAiAds,
  upsertFacebookPage,
  upsertInstagramBusiness,
  reconcileFacebookPictures,
  fetchSiteTheme,
  // exposed for tests / future callers
  _internal: { normalizeUrl, hostOf, extractMeta, extractTheme, fetchSiteMeta, fetchSiteTheme, maskApiKey, normalizeAdAccountId, stripSensitiveMetadata },
};
