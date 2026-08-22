// Publishing Platform connect flows.
//
// One `connect<Provider>` per platform. Each verifies the supplied creds
// against the provider's own API (so users see immediate feedback instead of
// discovering their token was bad at first publish), then upserts a row into
// `connected_accounts`.
//
// Storage convention matches the existing openAiAdsService pattern: secrets
// live in `metadata.<field>` and are stripped by SENSITIVE_METADATA_KEYS in
// connectionsService before returning to the client. Server-side callers that
// need to actually publish should use connectionsService.getRawForUser.
//
// Verification is best-effort with a hard timeout. A verify failure is
// surfaced as a 4xx so the UI can show the right guidance ("wrong token",
// "wrong permission", "not a WP site").
//
// Not included yet: WordPress full connect (requires the plugin — Phase 2),
// Shopify (needs a registered app), Squarespace (needs a headless browser
// worker), Lovable (rides Webhook backend), Hosted Blog (needs subdomain
// routing).

const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { marked } = require('marked');
const logger = require('../utils/logger');

// Fail-safe HTML config: no auto-linking of raw URLs (article prose already
// has intentional markdown links), no header ids (each provider generates
// them its own way), no mangling of emails.
marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const TABLE = 'connected_accounts';
const VERIFY_TIMEOUT_MS = 10000;

function makeError(status, code, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (extra) err.extra = extra;
  return err;
}

// Normalize a URL the way the website-connect flow does: default to https,
// strip trailing slash, drop hash. Returns null when the input can't be
// parsed as a URL.
function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch { return null; }
}

// Sensitive fields per provider — mirrored into connectionsService's
// SENSITIVE_METADATA_KEYS array so list/get responses strip them. Kept here
// too so tests and this file stay self-documenting.
const SENSITIVE_FIELDS = {
  webflow: ['api_token'],
  wix: ['api_key'],
  bigcommerce: ['access_token', 'webdav_pass'],
  hubspot: ['access_token'],
  gohighlevel: ['pit_token'],
  duda: ['api_pass'],
  webhook: ['bearer_token'],
  rss: ['feed_token'],
};

function stripSensitive(row, keys) {
  if (!row || !row.metadata) return row;
  const meta = { ...row.metadata };
  for (const k of keys) delete meta[k];
  return { ...row, metadata: meta };
}

// Upsert helper — dedupe by (user_id, provider, external_id). Same pattern
// as connectionsService.upsertOpenAiAds.
async function upsert({ userId, provider, externalId, displayName, metadata }) {
  const { data: existing } = await supabase
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('provider', provider)
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
    return data;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      provider,
      display_name: displayName,
      external_id: externalId,
      metadata,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// -----------------------------------------------------------------
// Webflow — Bearer token, /v2/sites lists the sites the token can see.
// -----------------------------------------------------------------
async function connectWebflow({ userId, apiToken }) {
  const token = (apiToken || '').trim();
  if (!token) throw makeError(400, 'INVALID', 'Webflow API token required');
  let sites;
  try {
    const res = await axios.get('https://api.webflow.com/v2/sites', {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${token}`, 'accept-version': '2.0.0' },
    });
    sites = res.data?.sites || [];
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 ? 401 : 502,
      'VERIFY_FAILED',
      status === 401 ? 'Invalid Webflow API token' : `Webflow verification failed: ${err.message}`
    );
  }
  if (sites.length === 0) throw makeError(400, 'NO_SITES', 'Token has no accessible Webflow sites');
  const first = sites[0];
  const row = await upsert({
    userId,
    provider: 'webflow',
    externalId: `webflow:${first.id}`,
    displayName: first.displayName || first.shortName || `Webflow ${first.id.slice(0, 8)}`,
    metadata: {
      site_id: first.id,
      site_name: first.displayName || null,
      short_name: first.shortName || null,
      api_token: token,
      site_count: sites.length,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.webflow);
}

// -----------------------------------------------------------------
// Wix — API key header, site-scoped via wix-site-id header.
// -----------------------------------------------------------------
async function connectWix({ userId, siteId, apiKey }) {
  const sid = (siteId || '').trim();
  const key = (apiKey || '').trim();
  if (!sid) throw makeError(400, 'INVALID', 'Wix Site ID required');
  if (!key) throw makeError(400, 'INVALID', 'Wix API key required');
  try {
    await axios.get('https://www.wixapis.com/blog/v3/categories?paging.limit=1', {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: key, 'wix-site-id': sid },
    });
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 || status === 403 ? status : 502,
      'VERIFY_FAILED',
      status === 401 || status === 403
        ? 'Invalid Wix API key or missing Wix Blog permission'
        : `Wix verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'wix',
    externalId: `wix:${sid}`,
    displayName: `Wix Site ${sid.slice(0, 8)}`,
    metadata: {
      site_id: sid,
      api_key: key,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.wix);
}

// -----------------------------------------------------------------
// BigCommerce — X-Auth-Token, store-scoped by hash in the URL. Optional
// WebDAV creds for image uploads.
// -----------------------------------------------------------------
async function connectBigCommerce({ userId, storeHash, accessToken, webdavUrl, webdavUser, webdavPass, authorName }) {
  const hash = (storeHash || '').trim();
  const tok = (accessToken || '').trim();
  if (!hash) throw makeError(400, 'INVALID', 'Store hash required');
  if (!tok) throw makeError(400, 'INVALID', 'Access token required');
  try {
    await axios.get(
      `https://api.bigcommerce.com/stores/${encodeURIComponent(hash)}/v3/content/blog/posts?limit=1`,
      { timeout: VERIFY_TIMEOUT_MS, headers: { 'X-Auth-Token': tok, Accept: 'application/json' } }
    );
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 || status === 403 || status === 404 ? status : 502,
      'VERIFY_FAILED',
      status === 401 ? 'Invalid BigCommerce access token'
        : status === 403 ? 'Access token missing Content modify permission'
        : status === 404 ? 'Store hash not found'
        : `BigCommerce verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'bigcommerce',
    externalId: `bigcommerce:${hash}`,
    displayName: `BigCommerce ${hash}`,
    metadata: {
      store_hash: hash,
      access_token: tok,
      webdav_url: webdavUrl?.trim() || null,
      webdav_user: webdavUser?.trim() || null,
      webdav_pass: webdavPass?.trim() || null,
      author_name: authorName?.trim() || null,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.bigcommerce);
}

// -----------------------------------------------------------------
// HubSpot — Bearer PAT. Portal ID discovery via /account-info/v3/details.
// -----------------------------------------------------------------
async function connectHubSpot({ userId, accessToken }) {
  const tok = (accessToken || '').trim();
  if (!tok) throw makeError(400, 'INVALID', 'HubSpot access token required');
  let portalId;
  try {
    const res = await axios.get('https://api.hubapi.com/account-info/v3/details', {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${tok}` },
    });
    portalId = res.data?.portalId;
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 ? 401 : 502,
      'VERIFY_FAILED',
      status === 401 ? 'Invalid HubSpot access token'
        : `HubSpot verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'hubspot',
    externalId: `hubspot:${portalId || 'unknown'}`,
    displayName: portalId ? `HubSpot Portal ${portalId}` : 'HubSpot',
    metadata: {
      access_token: tok,
      portal_id: portalId || null,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.hubspot);
}

// -----------------------------------------------------------------
// GoHighLevel — Bearer Private Integration Token + Location ID. LC's docs
// require a Version: 2021-07-28 header.
// -----------------------------------------------------------------
async function connectGoHighLevel({ userId, token, locationId }) {
  const tok = (token || '').trim();
  const loc = (locationId || '').trim();
  if (!tok) throw makeError(400, 'INVALID', 'Private Integration Token required');
  if (!loc) throw makeError(400, 'INVALID', 'Location ID required');
  try {
    await axios.get(`https://services.leadconnectorhq.com/blogs/site?locationId=${encodeURIComponent(loc)}`, {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28', Accept: 'application/json' },
    });
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 || status === 403 ? status : 502,
      'VERIFY_FAILED',
      status === 401 || status === 403
        ? 'Invalid GoHighLevel token or wrong Location ID'
        : `GoHighLevel verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'gohighlevel',
    externalId: `ghl:${loc}`,
    displayName: `GoHighLevel ${loc}`,
    metadata: {
      pit_token: tok,
      location_id: loc,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.gohighlevel);
}

// -----------------------------------------------------------------
// Duda — HTTP Basic Auth (API user + pass). Requires Agency plan.
// -----------------------------------------------------------------
async function connectDuda({ userId, siteName, apiUser, apiPass }) {
  const site = (siteName || '').trim();
  const user = (apiUser || '').trim();
  const pass = (apiPass || '').trim();
  if (!site) throw makeError(400, 'INVALID', 'Site name required');
  if (!user) throw makeError(400, 'INVALID', 'API username required');
  if (!pass) throw makeError(400, 'INVALID', 'API password required');
  const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  let siteInfo = {};
  try {
    const res = await axios.get(`https://api.duda.co/api/sites/multiscreen/${encodeURIComponent(site)}`, {
      timeout: VERIFY_TIMEOUT_MS,
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    siteInfo = res.data || {};
  } catch (err) {
    const status = err.response?.status;
    throw makeError(
      status === 401 || status === 403 || status === 404 ? status : 502,
      'VERIFY_FAILED',
      status === 401 || status === 403
        ? 'Invalid Duda API credentials'
        : status === 404 ? 'Duda site not found — check the site name'
        : `Duda verification failed: ${err.message}`
    );
  }
  const row = await upsert({
    userId,
    provider: 'duda',
    externalId: `duda:${site}`,
    displayName: siteInfo.site_domain || siteInfo.default_domain || `Duda ${site.slice(0, 8)}`,
    metadata: {
      site_name: site,
      api_user: user,
      api_pass: pass,
      site_domain: siteInfo.site_domain || null,
      default_domain: siteInfo.default_domain || null,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.duda);
}

// -----------------------------------------------------------------
// Webhook — no external verify (customer endpoint may not exist yet, may
// reject GETs, or may need our exact format). Auto-generate the bearer token
// so the same value can be embedded in code samples and Lovable prompts.
// -----------------------------------------------------------------
function generateWebhookToken() {
  return 'aseo_wh_' + crypto.randomBytes(16).toString('hex');
}

async function connectWebhook({ userId, url }) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw makeError(400, 'INVALID', 'Valid webhook URL required');
  const bearerToken = generateWebhookToken();
  const hostname = new URL(normalized).hostname;
  const row = await upsert({
    userId,
    provider: 'webhook',
    externalId: `webhook:${normalized}`,
    displayName: `Webhook: ${hostname}`,
    metadata: {
      url: normalized,
      bearer_token: bearerToken,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.webhook);
}

// -----------------------------------------------------------------
// RSS/JSON Feeds — no external system. One row per user (external_id ties
// to the user). Actual feed serving lives in a public route (Phase 2).
// -----------------------------------------------------------------
async function connectRssFeeds({ userId }) {
  const feedToken = 'aseo_rss_' + crypto.randomBytes(16).toString('hex');
  const row = await upsert({
    userId,
    provider: 'rss',
    externalId: `rss:${userId}`,
    displayName: 'RSS & JSON Feeds',
    metadata: {
      feed_token: feedToken,
      connected_at: new Date().toISOString(),
    },
  });
  return stripSensitive(row, SENSITIVE_FIELDS.rss);
}

// -----------------------------------------------------------------
// WordPress step 1 — probe /wp-json/ to confirm the URL is a WordPress
// site. Not a full connect; the wizard advances to step 2 (plugin install)
// on success. Full connect lands with the plugin (Phase 2).
// -----------------------------------------------------------------
async function verifyWordPress({ url }) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw makeError(400, 'INVALID', 'Valid URL required');
  let res;
  try {
    res = await axios.get(`${normalized}/wp-json/`, {
      timeout: VERIFY_TIMEOUT_MS,
      validateStatus: () => true,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw makeError(502, 'VERIFY_FAILED', `Could not reach ${normalized}: ${err.message}`);
  }
  if (res.status !== 200 || typeof res.data !== 'object' || !Array.isArray(res.data?.namespaces)) {
    throw makeError(400, 'NOT_WORDPRESS', 'This URL does not appear to be a WordPress site');
  }
  return {
    ok: true,
    url: normalized,
    siteName: res.data?.name || null,
    description: res.data?.description || null,
  };
}

// ===========================================================================
// PUBLISH — per-provider "push an article to this connection"
// ===========================================================================
//
// Each publisher takes:
//   { connection, article }
// where `connection` is a raw connected_accounts row (with sensitive metadata
// intact — dispatcher reads via connectionsService.getRawForUser) and
// `article` is a blog_articles row.
//
// Returns:
//   { publishedUrl, externalId, meta }
//
// Throws on failure — dispatcher catches, records status='failed' and
// last_error. Errors are shaped via makeError so status codes propagate.

function articleToHtml(article) {
  const md = article?.markdown || '';
  if (!md.trim()) return '';
  try {
    return marked.parse(md);
  } catch (e) {
    logger.warn('publish.markdown_parse_failed', { articleId: article?.id, error: e.message });
    return `<p>${(md || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>`;
  }
}

function articlePayload(article) {
  return {
    id: article.id,
    title: article.title || '',
    slug: article.slug || '',
    meta_description: article.meta_description || '',
    content_html: articleToHtml(article),
    content_markdown: article.markdown || '',
    hero_image_url: article.hero_image || null,
    hero_image_alt: article.hero_alt || null,
    tags: Array.isArray(article.tags) ? article.tags : [],
    excerpt: article.suggested_excerpt || '',
    faq: article.faq || null,
    keyword: article.keyword || null,
    published_at: article.published_at || new Date().toISOString(),
  };
}

// -----------------------------------------------------------------
// Webflow — POST draft item, PATCH to publish live.
// -----------------------------------------------------------------
async function publishWebflow({ connection, article }) {
  const token = connection.metadata?.api_token;
  const siteId = connection.metadata?.site_id;
  if (!token || !siteId) throw makeError(400, 'CONNECTION_INCOMPLETE', 'Webflow connection missing token or site_id');

  // Discover the first blog-shaped collection. Webflow doesn't have a
  // canonical "blog" concept — customers name theirs anything from "Posts"
  // to "Insights". We heuristic-match on slug/displayName; users can pick
  // explicitly in a follow-up. Cached in metadata.collection_id after the
  // first successful publish.
  let collectionId = connection.metadata?.collection_id;
  if (!collectionId) {
    const cols = await axios.get(`https://api.webflow.com/v2/sites/${siteId}/collections`, {
      timeout: 15000, headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.data?.collections || []);
    const blogLike = cols.find(c => /blog|post|article|insight|news/i.test(c.slug || c.displayName || ''));
    if (!blogLike) throw makeError(400, 'NO_COLLECTION', 'No blog-like collection found in Webflow — create a Blog Posts collection first');
    collectionId = blogLike.id;
  }

  const p = articlePayload(article);
  const fieldData = {
    name: p.title,
    slug: p.slug,
    'post-body': p.content_html,
    'meta-description': p.meta_description,
    'main-image': p.hero_image_url || undefined,
  };

  let itemId;
  try {
    const create = await axios.post(
      `https://api.webflow.com/v2/collections/${collectionId}/items`,
      { isArchived: false, isDraft: false, fieldData },
      { timeout: 20000, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    itemId = create.data?.id;
    // Publish live so the item is actually visible on the site.
    await axios.post(
      `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}/publish`,
      { itemIds: [itemId] },
      { timeout: 20000, headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => { /* draft-created success even if publish-live fails */ });
  } catch (err) {
    throw makeError(err.response?.status || 502, 'PUBLISH_FAILED', `Webflow publish failed: ${err.response?.data?.message || err.message}`);
  }
  return { externalId: itemId, publishedUrl: null, meta: { collection_id: collectionId } };
}

// -----------------------------------------------------------------
// Wix — create draft, then publish.
// -----------------------------------------------------------------
async function publishWix({ connection, article }) {
  const apiKey = connection.metadata?.api_key;
  const siteId = connection.metadata?.site_id;
  if (!apiKey || !siteId) throw makeError(400, 'CONNECTION_INCOMPLETE', 'Wix connection missing api_key or site_id');
  const p = articlePayload(article);
  const headers = { Authorization: apiKey, 'wix-site-id': siteId, 'Content-Type': 'application/json' };
  let draftId;
  try {
    const draft = await axios.post('https://www.wixapis.com/blog/v3/draft-posts', {
      draftPost: {
        title: p.title,
        excerpt: p.excerpt || p.meta_description,
        richContent: { nodes: [{ type: 'PARAGRAPH', nodes: [{ type: 'TEXT', textData: { text: p.content_markdown } }] }] },
        seoData: { tags: [{ type: 'meta', props: { name: 'description', content: p.meta_description } }] },
        media: p.hero_image_url ? { wixMedia: { image: p.hero_image_url }, displayed: true } : undefined,
      },
    }, { timeout: 20000, headers });
    draftId = draft.data?.draftPost?.id;
    if (!draftId) throw new Error('Wix returned no draft id');
    const pub = await axios.post(`https://www.wixapis.com/blog/v3/draft-posts/${encodeURIComponent(draftId)}/publish`, {}, { timeout: 15000, headers });
    return { externalId: pub.data?.postId || draftId, publishedUrl: pub.data?.post?.url || null, meta: {} };
  } catch (err) {
    throw makeError(err.response?.status || 502, 'PUBLISH_FAILED', `Wix publish failed: ${err.response?.data?.message || err.message}`);
  }
}

// -----------------------------------------------------------------
// BigCommerce — single POST publishes immediately.
// -----------------------------------------------------------------
async function publishBigCommerce({ connection, article }) {
  const hash = connection.metadata?.store_hash;
  const tok = connection.metadata?.access_token;
  if (!hash || !tok) throw makeError(400, 'CONNECTION_INCOMPLETE', 'BigCommerce connection missing store hash or token');
  const p = articlePayload(article);
  try {
    const res = await axios.post(
      `https://api.bigcommerce.com/stores/${encodeURIComponent(hash)}/v3/content/blog/posts`,
      {
        title: p.title,
        url: `/${p.slug}/`,
        body: p.content_html,
        meta_description: p.meta_description,
        author: connection.metadata?.author_name || undefined,
        tags: p.tags,
        is_published: true,
        thumbnail_path: p.hero_image_url || undefined,
      },
      { timeout: 20000, headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    const post = res.data?.data || {};
    return {
      externalId: String(post.id || ''),
      publishedUrl: post.url ? `https://store-${hash}.mybigcommerce.com${post.url}` : null,
      meta: {},
    };
  } catch (err) {
    throw makeError(err.response?.status || 502, 'PUBLISH_FAILED', `BigCommerce publish failed: ${err.response?.data?.title || err.message}`);
  }
}

// -----------------------------------------------------------------
// HubSpot — POST creates a draft; PUT to publish. We publish immediately.
// -----------------------------------------------------------------
async function publishHubSpot({ connection, article }) {
  const tok = connection.metadata?.access_token;
  if (!tok) throw makeError(400, 'CONNECTION_INCOMPLETE', 'HubSpot connection missing token');
  const p = articlePayload(article);
  // Auto-detect the first blog if we don't have one cached.
  let contentGroupId = connection.metadata?.content_group_id;
  if (!contentGroupId) {
    const blogs = await axios.get('https://api.hubapi.com/cms/v3/blogs/settings/v3?limit=1', {
      timeout: 15000, headers: { Authorization: `Bearer ${tok}` },
    }).catch(() => null);
    contentGroupId = blogs?.data?.results?.[0]?.id || null;
    if (!contentGroupId) throw makeError(400, 'NO_BLOG', 'No HubSpot blog found — create a blog in Content Hub first');
  }
  try {
    const res = await axios.post('https://api.hubapi.com/cms/v3/blogs/posts', {
      contentGroupId,
      name: p.title,
      slug: p.slug,
      postBody: p.content_html,
      metaDescription: p.meta_description,
      state: 'PUBLISHED',
      publishDate: p.published_at,
      featuredImage: p.hero_image_url || undefined,
      tagIds: [],
    }, { timeout: 20000, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } });
    return { externalId: res.data?.id || null, publishedUrl: res.data?.url || null, meta: { content_group_id: contentGroupId } };
  } catch (err) {
    throw makeError(err.response?.status || 502, 'PUBLISH_FAILED', `HubSpot publish failed: ${err.response?.data?.message || err.message}`);
  }
}

// -----------------------------------------------------------------
// GoHighLevel — POST /blogs/posts with content_html.
// -----------------------------------------------------------------
async function publishGoHighLevel({ connection, article }) {
  const tok = connection.metadata?.pit_token;
  const loc = connection.metadata?.location_id;
  if (!tok || !loc) throw makeError(400, 'CONNECTION_INCOMPLETE', 'GoHighLevel connection missing token or location');
  const p = articlePayload(article);
  try {
    const res = await axios.post('https://services.leadconnectorhq.com/blogs/posts', {
      locationId: loc,
      title: p.title,
      urlSlug: p.slug,
      description: p.meta_description,
      rawHTML: p.content_html,
      status: 'PUBLISHED',
      imageUrl: p.hero_image_url || undefined,
      publishedAt: p.published_at,
      tags: p.tags,
    }, {
      timeout: 20000,
      headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    return { externalId: res.data?.data?._id || res.data?.data?.id || null, publishedUrl: null, meta: {} };
  } catch (err) {
    throw makeError(err.response?.status || 502, 'PUBLISH_FAILED', `GoHighLevel publish failed: ${err.response?.data?.message || err.message}`);
  }
}

// -----------------------------------------------------------------
// Duda — POST /api/sites/multiscreen/{siteName}/blog/posts.
// -----------------------------------------------------------------
async function publishDuda({ connection, article }) {
  const site = connection.metadata?.site_name;
  const user = connection.metadata?.api_user;
  const pass = connection.metadata?.api_pass;
  if (!site || !user || !pass) throw makeError(400, 'CONNECTION_INCOMPLETE', 'Duda connection missing credentials');
  const p = articlePayload(article);
  const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  try {
    const res = await axios.post(
      `https://api.duda.co/api/sites/multiscreen/${encodeURIComponent(site)}/blog/posts`,
      {
        title: p.title,
        url_slug: p.slug,
        summary: p.meta_description,
        post_body: p.content_html,
        status: 'PUBLISHED',
        featured_image_url: p.hero_image_url || undefined,
      },
      { timeout: 20000, headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    return { externalId: res.data?.uuid || res.data?.id || null, publishedUrl: res.data?.url || null, meta: {} };
  } catch (err) {
    throw makeError(err.response?.status || 502, 'PUBLISH_FAILED', `Duda publish failed: ${err.response?.data?.error?.message || err.message}`);
  }
}

// -----------------------------------------------------------------
// Webhook — POST to customer URL with the payload + HMAC signature we
// documented in the Webhook connect UI.
// -----------------------------------------------------------------
async function publishWebhook({ connection, article }) {
  const url = connection.metadata?.url;
  const token = connection.metadata?.bearer_token;
  if (!url || !token) throw makeError(400, 'CONNECTION_INCOMPLETE', 'Webhook connection missing url or bearer token');
  const p = articlePayload(article);
  const body = {
    event: 'article.published',
    id: p.id,
    title: p.title,
    slug: p.slug,
    published_url: null,
    metaDescription: p.meta_description,
    content_html: p.content_html,
    content_markdown: p.content_markdown,
    heroImageUrl: p.hero_image_url,
    heroImageAlt: p.hero_image_alt,
    keywords: p.keyword ? [p.keyword] : [],
    wordpressTags: (p.tags || []).join(', '),
    faqSchema: p.faq,
    languageCode: 'en',
    status: 'published',
    publishedAt: p.published_at,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', token).update(raw).digest('hex');
  try {
    const res = await axios.post(url, raw, {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Postto-Event': 'article.published',
        'X-Postto-Signature': signature,
        'X-Postto-Delivery': crypto.randomUUID(),
      },
      validateStatus: () => true,
    });
    if (res.status >= 400) {
      throw makeError(res.status, 'ENDPOINT_ERROR', `Webhook endpoint returned ${res.status}`);
    }
    // Customer may return { url } to give us the live post URL.
    const returned = res.data;
    const publishedUrl = returned?.url || returned?.published_url || returned?.permalink || null;
    return { externalId: null, publishedUrl, meta: { status: res.status } };
  } catch (err) {
    if (err.status) throw err;
    throw makeError(502, 'PUBLISH_FAILED', `Webhook delivery failed: ${err.message}`);
  }
}

// -----------------------------------------------------------------
// RSS — no external call. Just marks the target as "published" with a
// pointer to the public feed URL. Actual serving happens in routes/feeds.js.
// -----------------------------------------------------------------
async function publishRss({ connection }) {
  const token = connection.metadata?.feed_token;
  if (!token) throw makeError(400, 'CONNECTION_INCOMPLETE', 'RSS connection missing feed token');
  const base = process.env.PUBLIC_APP_URL || 'https://post-to.app';
  return {
    externalId: null,
    publishedUrl: `${base}/feeds/${token}/rss.xml`,
    meta: { rss_url: `${base}/feeds/${token}/rss.xml`, json_url: `${base}/feeds/${token}/feed.json` },
  };
}

const PROVIDER_PUBLISHERS = {
  webflow: publishWebflow,
  wix: publishWix,
  bigcommerce: publishBigCommerce,
  hubspot: publishHubSpot,
  gohighlevel: publishGoHighLevel,
  duda: publishDuda,
  webhook: publishWebhook,
  rss: publishRss,
};

// Public dispatcher entry — resolves provider → publisher.
async function publishToProvider({ connection, article }) {
  const fn = PROVIDER_PUBLISHERS[connection.provider];
  if (!fn) throw makeError(400, 'UNSUPPORTED_PROVIDER', `Provider ${connection.provider} is not wired for publishing yet`);
  return fn({ connection, article });
}

module.exports = {
  connectWebflow,
  connectWix,
  connectBigCommerce,
  connectHubSpot,
  connectGoHighLevel,
  connectDuda,
  connectWebhook,
  connectRssFeeds,
  verifyWordPress,
  publishToProvider,
  PROVIDER_PUBLISHERS,
  SENSITIVE_FIELDS,
  _internal: { normalizeUrl, upsert, stripSensitive, generateWebhookToken, articleToHtml, articlePayload },
};
