// Meta Graph API client — covers Facebook Pages + Instagram Business posting.
//
// Direct axios calls (no `facebook-nodejs-business-sdk` dep, matches the
// "avoid new deps" pattern from openAiAdsService / googleAdsService).
//
// Auth model:
//   1. User OAuth grant → short-lived user access token (~1h)
//   2. Exchange for long-lived user token (~60d)
//   3. Enumerate Pages the user admins → each Page comes back with its own
//      long-lived Page Access Token
//   4. Post to Facebook Page = Page Access Token
//   5. Post to Instagram Business = Page Access Token of the linked FB Page
//      (IG Business accounts are ALWAYS attached to a FB Page — no separate
//      IG-only token exists in the Graph API)

const axios = require('axios');
const logger = require('../utils/logger');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Scopes we request during the OAuth flow. All required for full read + post
// on FB Pages + IG Business. `business_management` is what unlocks Pages that
// are administered via a Business Manager rather than the user's personal
// Facebook profile.
const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
  'public_profile',
  'email',
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function buildAuthUrl({ state, redirectUri }) {
  const appId = requireEnv('META_APP_ID');
  const uri = redirectUri || requireEnv('META_REDIRECT_URI');
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: uri,
    state: state || '',
    scope: SCOPES.join(','),
    response_type: 'code',
    auth_type: 'rerequest', // re-prompts for previously-declined scopes
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

async function exchangeCodeForToken({ code, redirectUri }) {
  const appId = requireEnv('META_APP_ID');
  const appSecret = requireEnv('META_APP_SECRET');
  const uri = redirectUri || requireEnv('META_REDIRECT_URI');

  const url = `${GRAPH_BASE}/oauth/access_token`;
  const res = await axios.get(url, {
    params: {
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: uri,
      code,
    },
    timeout: 15000,
  });
  return res.data; // { access_token, token_type, expires_in? }
}

async function getLongLivedUserToken(shortToken) {
  const appId = requireEnv('META_APP_ID');
  const appSecret = requireEnv('META_APP_SECRET');
  const url = `${GRAPH_BASE}/oauth/access_token`;
  const res = await axios.get(url, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
    timeout: 15000,
  });
  return res.data; // { access_token, token_type, expires_in }
}

async function getMe(userAccessToken) {
  const url = `${GRAPH_BASE}/me`;
  const res = await axios.get(url, {
    params: { access_token: userAccessToken, fields: 'id,name,email' },
    timeout: 15000,
  });
  return res.data;
}

// List Pages the user administers. Page Access Tokens returned here are
// long-lived (~60d) when derived from a long-lived user token — Meta's docs
// confirm this. Store them on the connected_accounts row.
async function listPages(userAccessToken) {
  const url = `${GRAPH_BASE}/me/accounts`;
  const rows = [];
  let after;
  let guard = 0;
  do {
    const res = await axios.get(url, {
      params: {
        access_token: userAccessToken,
        fields: 'id,name,category,tasks,access_token,instagram_business_account{id,username,profile_picture_url},picture{data{url}}',
        limit: 100,
        after,
      },
      timeout: 20000,
    });
    for (const p of res.data?.data || []) rows.push(p);
    after = res.data?.paging?.cursors?.after;
    guard += 1;
    if (guard > 20) break; // safety cap
  } while (after);
  return rows;
}

// Publish a text/link/photo post to a FB Page. Returns { id }.
// If imageUrl is provided, we post to /{page_id}/photos so the image is
// uploaded and attached to the story. Otherwise /{page_id}/feed for text/link.
async function publishFacebookPost({ pageId, pageAccessToken, message, imageUrl, link }) {
  if (!pageId) throw new Error('pageId required');
  if (!pageAccessToken) throw new Error('pageAccessToken required');
  if (!message && !imageUrl && !link) throw new Error('message, imageUrl, or link required');

  if (imageUrl) {
    // /photos accepts { url, caption, access_token }. The image is fetched by
    // Meta from the public URL — the URL must be reachable from the internet.
    const res = await axios.post(
      `${GRAPH_BASE}/${pageId}/photos`,
      null,
      {
        params: {
          url: imageUrl,
          caption: message || '',
          access_token: pageAccessToken,
        },
        timeout: 30000,
      }
    );
    return res.data; // { id, post_id? }
  }

  const body = { message: message || '' };
  if (link) body.link = link;
  const res = await axios.post(
    `${GRAPH_BASE}/${pageId}/feed`,
    body,
    {
      params: { access_token: pageAccessToken },
      timeout: 20000,
    }
  );
  return res.data; // { id }
}

// Publish to an Instagram Business account.
//
// Two-step flow (Meta's design, not ours):
//   1. Create a "media container" pointing at the image URL + caption
//   2. Publish that container
//
// Image MUST be a public HTTPS URL. Meta fetches it — you cannot POST bytes
// directly. This is why the app requires ImgBB / Supabase storage first.
async function publishInstagramPost({ igBusinessId, pageAccessToken, imageUrl, caption }) {
  if (!igBusinessId) throw new Error('igBusinessId required');
  if (!pageAccessToken) throw new Error('pageAccessToken required');
  if (!imageUrl) throw new Error('imageUrl required (public HTTPS URL)');

  // Step 1: create container
  const containerRes = await axios.post(
    `${GRAPH_BASE}/${igBusinessId}/media`,
    null,
    {
      params: {
        image_url: imageUrl,
        caption: caption || '',
        access_token: pageAccessToken,
      },
      timeout: 30000,
    }
  );
  const creationId = containerRes.data?.id;
  if (!creationId) throw new Error('Failed to create IG media container');

  // Step 2: publish
  const publishRes = await axios.post(
    `${GRAPH_BASE}/${igBusinessId}/media_publish`,
    null,
    {
      params: {
        creation_id: creationId,
        access_token: pageAccessToken,
      },
      timeout: 30000,
    }
  );
  return { id: publishRes.data?.id, creation_id: creationId };
}

// Turn Meta's error envelope into something the router can hand back to the
// UI. Meta's shape: { error: { message, type, code, fbtrace_id, error_subcode? } }
function normalizeApiError(err) {
  const status = err.response?.status || 500;
  const fbErr = err.response?.data?.error;
  const message = fbErr?.message || err.message || 'Meta API error';
  const code = fbErr?.code;
  const type = fbErr?.type;
  const subcode = fbErr?.error_subcode;
  const needsReauth =
    code === 190 || // OAuth token invalid / expired
    subcode === 458 || // App not installed
    subcode === 463 || // Session has expired
    subcode === 467; // Invalid access token
  return { status, message, code, type, subcode, needsReauth };
}

// Best-effort sanity check for a Page Access Token — returns the current
// permissions or throws normalized error. Used by /diagnose.
async function debugToken(inputToken) {
  const appId = requireEnv('META_APP_ID');
  const appSecret = requireEnv('META_APP_SECRET');
  const url = `${GRAPH_BASE}/debug_token`;
  const res = await axios.get(url, {
    params: {
      input_token: inputToken,
      access_token: `${appId}|${appSecret}`,
    },
    timeout: 15000,
  });
  return res.data?.data;
}

module.exports = {
  SCOPES,
  buildAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getMe,
  listPages,
  publishFacebookPost,
  publishInstagramPost,
  debugToken,
  normalizeApiError,
  _internal: { GRAPH_VERSION, GRAPH_BASE },
};
