// Index page — list of published articles for the caller's host.

import supabase from '../../lib/supabase';
import { renderIndexHtml } from '../../lib/renderer';
import { resolve } from '../../lib/hostGuard';

export default async function handler(req, res) {
  try {
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
  } catch (err) {
    console.error('root.unhandled', err?.message, err?.stack);
    res.status(500).setHeader('Content-Type', 'text/plain').send(`Server error: ${err?.message || 'unknown'}`);
  }
}
