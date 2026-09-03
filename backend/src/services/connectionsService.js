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
// head. Best-effort regex — never throws, returns partial data. Returns
// multiple logo candidates in priority order so the caller can HEAD-verify
// each and pick the first that returns 2xx (declared logos often 404 in
// practice).
function extractTheme(html, baseUrl) {
  const out = { logoCandidates: [] };
  if (!html || typeof html !== 'string') return out;
  const head = html.slice(0, 200000);

  const absolutize = (url) => {
    try { return new URL(url, baseUrl).toString(); } catch { return null; }
  };

  // theme-color meta tag → primary/accent color
  const themeColor = head.match(/<meta[^>]*(?:name|property)\s*=\s*["']theme-color["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || head.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:name|property)\s*=\s*["']theme-color["']/i);
  if (themeColor) out.primaryColor = themeColor[1].trim();

  // First Google Fonts stylesheet link. Preserve the URL verbatim so all
  // weights the site loaded come along.
  const fontsLink = head.match(/<link[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/css2?\?[^"']+)["']/i)
    || head.match(/<link[^>]*href\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/css2?\?[^"']+)["'][^>]*rel\s*=\s*["']stylesheet["']/i);
  if (fontsLink) {
    out.fontsUrl = fontsLink[1];
    const famMatch = fontsLink[1].match(/family=([^&:+]+)/i);
    if (famMatch) out.fontFamily = decodeURIComponent(famMatch[1].replace(/\+/g, ' '));
  }

  // Logo candidates in priority order:
  //   1. og:image — purpose-built by the site owner as their share image
  //   2. apple-touch-icon (usually 180×180+, better than the tiny favicon)
  //   3. <img> tags with class containing "logo" from anywhere in the doc
  //   4. Rel=icon <link>s (favicon.ico / favicon.png)
  const ogImage = head.match(/<meta[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i);
  if (ogImage?.[1]) { const u = absolutize(ogImage[1]); if (u) out.logoCandidates.push(u); }

  const appleIcon = head.match(/<link[^>]*rel\s*=\s*["']apple-touch-icon(?:-precomposed)?["'][^>]*href\s*=\s*["']([^"']+)["']/i);
  if (appleIcon?.[1]) { const u = absolutize(appleIcon[1]); if (u) out.logoCandidates.push(u); }

  const logoImgRe = /<img[^>]*class\s*=\s*["'][^"']*\blogo\b[^"']*["'][^>]*src\s*=\s*["']([^"']+)["']|<img[^>]*src\s*=\s*["']([^"']+)["'][^>]*class\s*=\s*["'][^"']*\blogo\b[^"']*["']/gi;
  let m;
  while ((m = logoImgRe.exec(html)) !== null) {
    const raw = m[1] || m[2];
    if (raw) { const u = absolutize(raw); if (u) out.logoCandidates.push(u); }
    if (out.logoCandidates.length > 5) break;
  }

  const iconLinkRe = /<link[^>]*rel\s*=\s*["'](?:shortcut )?icon["'][^>]*href\s*=\s*["']([^"']+)["']/gi;
  while ((m = iconLinkRe.exec(head)) !== null) {
    const u = absolutize(m[1]);
    if (u) out.logoCandidates.push(u);
  }

  // De-dupe while preserving order.
  out.logoCandidates = [...new Set(out.logoCandidates)];

  return out;
}

// HEAD-check a URL, following redirects. Returns true only if the final
// response is a 2xx status. Bounded by a short timeout.
async function urlIsReachable(url) {
  try {
    const res = await axios.head(url, {
      timeout: 5000,
      maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PostToBot/1.0; +https://post-to.app)' },
      validateStatus: () => true,
    });
    return res.status >= 200 && res.status < 300;
  } catch { return false; }
}

// Public helper: fetch a page and return theme signals. Follows redirects
// (many sites redirect apex → www) and picks the first logo candidate whose
// URL actually returns 2xx (declared icons frequently 404).
async function fetchSiteTheme(rawUrl) {
  try {
    const url = normalizeUrl(rawUrl);
    if (!url) return {};
    const res = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        // Bot-friendly UA reveals us; browser-shaped UA gets through sites
        // that reject non-browser traffic (spotless.homes returns 60-byte
        // redirect page to bot UAs — hero HTML only to browsers).
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: s => s >= 200 && s < 400,
    });
    const finalUrl = res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || url;
    const raw = extractTheme(res.data, finalUrl);

    // Pick the first logo candidate that HEAD-verifies. Cap the number of
    // probes so a site with many broken images doesn't spend forever here.
    let logoUrl = null;
    for (const candidate of (raw.logoCandidates || []).slice(0, 6)) {
      if (await urlIsReachable(candidate)) { logoUrl = candidate; break; }
    }

    const { logoCandidates, ...rest } = raw;
    return { ...rest, ...(logoUrl ? { logoUrl } : {}) };
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
const SENSITIVE_METADATA_KEYS = [
  'api_key', 'page_access_token', 'user_access_token',
  // Apple App Store Connect .p8 private key — AES-256-GCM encrypted at
  // rest via utils/cryptoBox, but still don't ship it in list/get
  // responses (attackers who can guess the encryption key shouldn't
  // also get the ciphertext for free).
  'p8_encrypted',
  // Long-lived Meta user access token stored on FB Page rows. The
  // upsertFacebookPage comment already claimed this was stripped on read,
  // but the key was missing from this list — surfaced during Meta Ads
  // Phase 1A wiring. Used server-side only via getMetaOwnerToken().
  'owner_user_token',
  // Blog publisher AWS creds — scoped IAM user per customer, still sensitive.
  's3_access_key_secret',
  // GitHub PAT used to fire repository_dispatch after publish (auto-deploy).
  'github_token',
  // Publishing Platform provider secrets — mirrored from
  // publishingPlatformService.SENSITIVE_FIELDS. See that file for provenance.
  'api_token',       // Webflow
  'access_token',    // BigCommerce, HubSpot
  'pit_token',       // GoHighLevel
  'api_pass',        // Duda
  'webdav_pass',     // BigCommerce WebDAV
  'bearer_token',    // Webhook
  'feed_token',      // RSS/JSON feeds
];

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

// Server-side lookup: given an authenticated app user, return the long-lived
// Meta user access token they granted at OAuth time, plus their Meta user id.
// Callers use this to hit Marketing API endpoints on behalf of that user
// (metaAdsService).
//
// The token is stored per Facebook Page row in metadata.owner_user_token —
// all Page rows from the same OAuth grant share the same token, so we grab
// the most recently connected Page and use its token. Returns null if the
// user has no Meta connection at all.
//
// SECURITY: this returns a raw bearer token. Never expose it to the client.
// The returned shape includes only what a service call needs.
async function getMetaOwnerToken(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('metadata, updated_at')
    .eq('user_id', userId)
    .eq('provider', 'facebook')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data || [])[0];
  if (!row?.metadata?.owner_user_token) return null;
  return {
    accessToken: row.metadata.owner_user_token,
    metaUserId: row.metadata.meta_user_id || null,
    expiresAt: row.metadata.owner_user_token_expires_at || null,
  };
}

// Read the user's Meta Ads account selection. Selection is stored on the
// facebook connection rows' metadata as `ad_account_ids` (array) + optional
// `default_ad_account_id`. Written by setMetaAdAccountSelection() to ALL
// facebook rows in one transaction so any row read returns the same answer.
//
// Returns { adAccountIds: [], defaultAdAccountId: null } when no selection
// exists yet (the user has connected Meta but not picked ad accounts).
async function getMetaAdAccountSelection(userId) {
  if (!userId) return { adAccountIds: [], defaultAdAccountId: null };
  const { data, error } = await supabase
    .from(TABLE)
    .select('metadata, updated_at')
    .eq('user_id', userId)
    .eq('provider', 'facebook')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data || [])[0];
  const meta = row?.metadata || {};
  const raw = Array.isArray(meta.ad_account_ids) ? meta.ad_account_ids : [];
  // Defensive: strip anything that doesn't look like `act_<digits>`, dedupe.
  const cleaned = [...new Set(raw.filter((s) => /^act_\d+$/.test(String(s || ''))))];
  const def = meta.default_ad_account_id;
  return {
    adAccountIds: cleaned,
    defaultAdAccountId:
      def && cleaned.includes(def) ? def : cleaned[0] || null,
  };
}

// Persist the user's Meta Ads account selection to ALL of their active
// facebook connection rows in one shot. Every facebook row for a user
// originates from the same Meta OAuth grant and shares the same owner_user_token,
// so the selection is Meta-identity-scoped and safe to duplicate. Storing on
// every row means any subsequent read (which uses the most-recently-updated
// row) returns the same answer.
//
// Merges into existing metadata — preserves page_access_token, meta_user_id,
// owner_user_token, picture_url, category, tasks, and every other pre-Phase-1B
// metadata field. Never clobbers.
async function setMetaAdAccountSelection(userId, { adAccountIds, defaultAdAccountId }) {
  if (!userId) throw new Error('userId required');
  if (!Array.isArray(adAccountIds)) throw new Error('adAccountIds must be an array');
  const cleaned = [...new Set(adAccountIds.map((s) => String(s || '').trim()).filter((s) => /^act_\d+$/.test(s)))];
  const def =
    defaultAdAccountId && cleaned.includes(defaultAdAccountId)
      ? defaultAdAccountId
      : cleaned[0] || null;

  // Fetch every facebook row so we can merge into each metadata object.
  const { data: rows, error: fetchErr } = await supabase
    .from(TABLE)
    .select('id, metadata')
    .eq('user_id', userId)
    .eq('provider', 'facebook')
    .eq('status', 'active');
  if (fetchErr) throw fetchErr;
  if (!rows || rows.length === 0) {
    const e = new Error('No active Facebook connection to attach ad-account selection to');
    e.code = 'META_NOT_CONNECTED';
    throw e;
  }

  // Merge + update each row. Kept as sequential awaits (small N) so a single
  // failure surfaces immediately rather than being swallowed by Promise.all.
  for (const row of rows) {
    const merged = {
      ...(row.metadata || {}),
      ad_account_ids: cleaned,
      default_ad_account_id: def,
    };
    const { error: updErr } = await supabase
      .from(TABLE)
      .update({ metadata: merged })
      .eq('id', row.id);
    if (updErr) throw updErr;
  }

  return { adAccountIds: cleaned, defaultAdAccountId: def, rowsUpdated: rows.length };
}

// Insert or refresh a website connection. We dedupe per user on (provider, external_id).
// Sitemap-based URL discovery for a website connection. Tries the standard
// sitemap.xml locations (root, robots.txt Sitemap: hint). Extracts <loc>
// entries and returns unique root-relative paths — this is what the SEO
// pipeline hands to the LLM as the internal-link whitelist so it can pick
// real URLs to link to instead of inventing them.
//
// Best-effort. Any failure returns []. Never throws.
async function discoverInternalUrls(siteUrl) {
  try {
    const base = new URL(siteUrl);
    const origin = `${base.protocol}//${base.host}`;
    const candidates = [
      `${origin}/sitemap.xml`,
      `${origin}/sitemap_index.xml`,
      `${origin}/sitemap-index.xml`,
    ];
    // Also honor robots.txt Sitemap: entries.
    try {
      const rob = await axios.get(`${origin}/robots.txt`, { timeout: 5000, validateStatus: () => true });
      if (rob.status === 200 && typeof rob.data === 'string') {
        for (const m of rob.data.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) {
          candidates.push(m[1].trim());
        }
      }
    } catch { /* ignore */ }

    const seen = new Set();
    const paths = new Set();
    for (const url of candidates) {
      if (seen.has(url)) continue;
      seen.add(url);
      const r = await axios.get(url, {
        timeout: 8000, maxContentLength: 5 * 1024 * 1024,
        validateStatus: () => true,
        headers: { 'User-Agent': 'post-to/1.0 (+sitemap-discover)' },
      }).catch(() => null);
      if (!r || r.status !== 200 || typeof r.data !== 'string') continue;

      // Sitemap index → fetch each child (cap to 3 to keep this bounded).
      const childSitemaps = [...r.data.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
      const targets = childSitemaps.length > 0 ? childSitemaps.slice(0, 3) : [url];
      for (const t of targets) {
        let body = r.data;
        if (t !== url) {
          const child = await axios.get(t, {
            timeout: 8000, maxContentLength: 5 * 1024 * 1024,
            validateStatus: () => true,
            headers: { 'User-Agent': 'post-to/1.0 (+sitemap-discover)' },
          }).catch(() => null);
          if (!child || child.status !== 200) continue;
          body = child.data;
        }
        for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
          const raw = m[1].trim();
          try {
            const u = new URL(raw);
            // Same-origin only.
            if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
            // Root path — keep; strip trailing slash except for `/`.
            let path = u.pathname || '/';
            if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
            // Drop the home page, obvious legal / plumbing pages, and blog
            // posts (the article we're writing IS a blog post; linking to
            // other blog posts is fine but risks self-referential loops).
            if (path === '/') continue;
            if (/^\/(privacy|terms|cookies?|legal|sitemap|robots|feed|rss|search|sign[-_]?in|sign[-_]?up|login|logout|auth)(\/|$|-)/i.test(path)) continue;
            paths.add(path);
          } catch { /* ignore malformed */ }
        }
      }
      // If the first candidate gave us URLs, stop.
      if (paths.size > 0) break;
    }
    // Cap at 60 URLs so the prompt doesn't balloon; the LLM only needs a
    // representative sample of pages to link to.
    return [...paths].slice(0, 60);
  } catch (e) {
    logger.warn('connections.discover_urls_failed', { site_url: siteUrl, error: e.message });
    return [];
  }
}

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

  // Sitemap crawl in parallel with the meta fetch (fetched already ran, so
  // this is sequential but still cheap). Failures return [] silently.
  const internalUrls = await discoverInternalUrls(fetched.finalUrl || normalized);

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
    // Used by the SEO pipeline (routes/ai.js + automationExecutor.js) as
    // the internal-link whitelist for article generation.
    internal_urls: internalUrls,
    internal_urls_discovered_at: new Date().toISOString(),
    internal_urls_count: internalUrls.length,
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

// Apple App Store Connect. Bring-your-own-.p8 private key flow (no OAuth).
// The .p8 arrives already encrypted via cryptoBox (route layer does the
// encryption before calling us — service is agnostic to the ciphertext
// format). issuer_id and key_id are NOT sensitive on their own; the p8 is.
async function upsertAppStoreConnect({
  userId,
  issuerId,
  keyId,
  p8Encrypted,
  vendorNumber,
  appId,
  appBundleId,
  displayName,
}) {
  if (!userId || !issuerId || !keyId || !p8Encrypted) {
    throw new Error('userId, issuerId, keyId, p8Encrypted required');
  }
  // Multi-account discipline: one connected_accounts row per (issuer_id, key_id)
  // pair. Apple keys can be regenerated with the same issuer+id — that's fine,
  // the upsert overwrites the p8_encrypted.
  const externalId = `asc:${issuerId}:${keyId}`;
  const metadata = {
    issuer_id: issuerId,
    key_id: keyId,
    p8_encrypted: p8Encrypted,
    vendor_number: vendorNumber || null,
    app_id: appId || null,
    app_bundle_id: appBundleId || null,
    connected_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'app_store_connect')
    .eq('external_id', externalId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        display_name: displayName || 'Apple App Store',
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
      provider: 'app_store_connect',
      display_name: displayName || 'Apple App Store',
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

// Re-run sitemap discovery for an EXISTING website connection. Cheap way
// to backfill `metadata.internal_urls` for connections created before we
// crawled sitemaps at upsert time. Idempotent; overwrites the current URL
// list with what's live now.
async function refreshWebsiteUrls({ userId, id }) {
  const row = await getRawForUser({ userId, id });
  if (!row) throw new Error('Connection not found');
  if (row.provider !== 'website') throw new Error('Only website connections have internal_urls');
  const siteUrl = row.metadata?.url;
  if (!siteUrl) throw new Error('Connection has no url in metadata');
  const urls = await discoverInternalUrls(siteUrl);
  const nextMetadata = {
    ...(row.metadata || {}),
    internal_urls: urls,
    internal_urls_discovered_at: new Date().toISOString(),
    internal_urls_count: urls.length,
  };
  const { data, error } = await supabase
    .from(TABLE).update({ metadata: nextMetadata })
    .eq('id', id).eq('user_id', userId).select().single();
  if (error) throw error;
  return { connection: data, count: urls.length };
}

module.exports = {
  listForUser,
  getForUser,
  getRawForUser,
  deleteForUser,
  upsertWebsite,
  refreshWebsiteUrls,
  discoverInternalUrls,
  upsertGoogleBusiness,
  reconcileGoogleBusiness,
  upsertGoogleAnalytics,
  upsertGoogleAds,
  upsertGoogleSearchConsole,
  upsertOpenAiAds,
  upsertAppStoreConnect,
  upsertFacebookPage,
  upsertInstagramBusiness,
  reconcileFacebookPictures,
  getMetaOwnerToken,
  getMetaAdAccountSelection,
  setMetaAdAccountSelection,
  fetchSiteTheme,
  // exposed for tests / future callers
  _internal: { normalizeUrl, hostOf, extractMeta, extractTheme, fetchSiteMeta, fetchSiteTheme, maskApiKey, normalizeAdAccountId, stripSensitiveMetadata, discoverInternalUrls },
};
