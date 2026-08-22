// Public RSS + JSON feed endpoints.
//
// Auth: token-in-URL (feeds are meant to be consumed by RSS readers, static
// site generators, etc.). The token lives on the RSS connected_account row's
// metadata.feed_token and is generated at connect time. Rotating the token
// invalidates all subscribers — desirable when you need to lock out an old
// subscriber.
//
// Content: all blog_articles rows with status='published' for the user who
// owns the token, most recent 50, cached 60 seconds via ETag.
//
// NOT mounted under /api — these are meant to be linked from arbitrary
// external tools (Feedly, Netlify, cron jobs), so URLs like
// https://post-to.app/feeds/<token>/rss.xml keep the shape RSS readers
// expect.

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const router = express.Router();

const FEED_LIMIT = 50;
const CACHE_SECONDS = 60;

async function resolveTokenToUser(token) {
  if (!token || typeof token !== 'string') return null;
  // metadata->>'feed_token' equality; provider narrows the search so the
  // JSONB scan is bounded (we only have a handful of RSS rows per DB).
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id, user_id, metadata')
    .eq('provider', 'rss')
    .eq('metadata->>feed_token', token)
    .maybeSingle();
  if (error) {
    logger.warn('feeds.resolve_token_error', { error: error.message });
    return null;
  }
  return data ? { userId: data.user_id, connectionId: data.id } : null;
}

async function loadArticles(userId) {
  const { data, error } = await supabase
    .from('blog_articles')
    .select('id, title, slug, meta_description, suggested_excerpt, markdown, hero_image, published_at, updated_at, created_at, tags, keyword')
    .eq('user_id', userId)
    .eq('status', 'published')
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(FEED_LIMIT);
  if (error) throw error;
  return data || [];
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function articleUrl(baseUrl, article) {
  // Best-effort permalink. Customers who publish via a Publishing Platform
  // will get the provider's live URL from blog_publish_targets, but for the
  // generic feed we point at the article slug on post-to.app. Real "canonical"
  // resolution can be layered on later once we know which platform is primary.
  return `${baseUrl}/blog/${encodeURIComponent(article.slug || article.id)}`;
}

function buildRss({ token, articles }) {
  const base = process.env.PUBLIC_APP_URL || 'https://post-to.app';
  const now = new Date().toUTCString();
  const items = articles.map(a => {
    const link = articleUrl(base, a);
    const pubDate = new Date(a.published_at || a.updated_at || a.created_at).toUTCString();
    const description = a.meta_description || a.suggested_excerpt || '';
    return `    <item>
      <title>${xmlEscape(a.title)}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="false">post-to-${a.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${xmlEscape(description)}</description>${
        a.hero_image ? `\n      <enclosure url="${xmlEscape(a.hero_image)}" type="image/jpeg"/>` : ''
      }
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Post-to feed</title>
    <link>${xmlEscape(base)}</link>
    <description>Articles published via Post-to</description>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${xmlEscape(base)}/feeds/${xmlEscape(token)}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;
}

function buildJsonFeed({ token, articles }) {
  const base = process.env.PUBLIC_APP_URL || 'https://post-to.app';
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Post-to feed',
    home_page_url: base,
    feed_url: `${base}/feeds/${token}/feed.json`,
    items: articles.map(a => ({
      id: `post-to-${a.id}`,
      url: articleUrl(base, a),
      title: a.title,
      content_text: a.suggested_excerpt || a.meta_description || '',
      content_html: undefined, // omit — we don't render server-side here
      summary: a.meta_description || undefined,
      image: a.hero_image || undefined,
      tags: Array.isArray(a.tags) && a.tags.length ? a.tags : (a.keyword ? [a.keyword] : undefined),
      date_published: a.published_at || a.updated_at || a.created_at,
      date_modified: a.updated_at || a.created_at,
    })),
  };
}

function etagFor(body) {
  return '"' + crypto.createHash('sha1').update(body).digest('hex') + '"';
}

router.get('/:token/rss.xml', async (req, res) => {
  try {
    const owner = await resolveTokenToUser(req.params.token);
    if (!owner) return res.status(404).type('text/plain').send('Feed not found');
    const articles = await loadArticles(owner.userId);
    const xml = buildRss({ token: req.params.token, articles });
    const etag = etagFor(xml);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set({
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      ETag: etag,
    });
    res.send(xml);
  } catch (err) {
    logger.error('feeds.rss_failed', { error: err.message });
    res.status(500).type('text/plain').send('Feed error');
  }
});

router.get('/:token/feed.json', async (req, res) => {
  try {
    const owner = await resolveTokenToUser(req.params.token);
    if (!owner) return res.status(404).json({ error: 'Feed not found' });
    const articles = await loadArticles(owner.userId);
    const body = buildJsonFeed({ token: req.params.token, articles });
    const bodyStr = JSON.stringify(body);
    const etag = etagFor(bodyStr);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set({
      'Content-Type': 'application/feed+json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      ETag: etag,
    });
    res.send(bodyStr);
  } catch (err) {
    logger.error('feeds.json_failed', { error: err.message });
    res.status(500).json({ error: 'Feed error' });
  }
});

module.exports = router;
