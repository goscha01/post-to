import supabase from '../../lib/supabase';
import { renderArticleHtml, renderNotFoundHtml } from '../../lib/renderer';
import { resolve } from '../../lib/hostGuard';

export default async function handler(req, res) {
  try {
    const record = await resolve(req, res);
    if (!record) return;
    const { userId, hostname, metadata } = record;
    const siteName = metadata?.site_name;
    const theme = metadata?.theme || {};
    const slug = String(req.query.slug || '').slice(0, 512);

    if (!slug || !/^[a-z0-9-]+$/i.test(slug)) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderNotFoundHtml({ hostname, siteName }));
      return;
    }

    const { data, error } = await supabase
      .from('blog_articles')
      .select('id, slug, title, meta_description, suggested_excerpt, markdown, published_at, updated_at, created_at')
      .eq('user_id', userId)
      .eq('slug', slug)
      .eq('status', 'published')
      .maybeSingle();
    if (error) {
      console.error('article.query_failed', hostname, slug, error.message);
      res.status(500).setHeader('Content-Type', 'text/html').send('Server error');
      return;
    }
    if (!data) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderNotFoundHtml({ hostname, siteName }));
      return;
    }
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderArticleHtml({ article: data, hostname, siteName, theme }));
  } catch (err) {
    console.error('article.unhandled', err?.message, err?.stack);
    res.status(500).setHeader('Content-Type', 'text/plain').send(`Server error: ${err?.message || 'unknown'}`);
  }
}
