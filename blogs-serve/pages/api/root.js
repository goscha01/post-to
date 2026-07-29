// Index page — list of published articles for the caller's host.

const supabase = require('../../lib/supabase');
const { renderIndexHtml } = require('../../lib/renderer');
const { resolve } = require('../../lib/hostGuard');

module.exports = async function handler(req, res) {
  const record = await resolve(req, res);
  if (!record) return;
  const { userId, hostname, metadata } = record;
  const siteName = metadata?.site_name || hostname;

  const { data, error } = await supabase
    .from('blog_articles')
    .select('id, slug, title, meta_description, suggested_excerpt, published_at, updated_at')
    .eq('user_id', userId)
    .eq('status', 'published')
    .not('slug', 'is', null)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) {
    console.error('index.query_failed', hostname, error.message);
    res.status(500).setHeader('Content-Type', 'text/html').send('Server error');
    return;
  }
  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderIndexHtml({ articles: data || [], hostname, siteName }));
};
