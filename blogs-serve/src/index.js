// post-to-blogs — multi-tenant blog renderer.
//
// One Node.js Express service that serves published articles on any user's
// custom subdomain (e.g. blog.theirsite.com). Users register the domain from
// post-to's main dashboard; the main backend calls Railway's API to attach
// the domain to *this* service and inserts a `blog_domain` row in
// connected_accounts. Requests arrive here via the Host header, we look up
// the owner, fetch published articles from Supabase, render HTML.
//
// Route layout (all under whatever Host was used):
//   GET /                → index list of published articles for that host
//   GET /sitemap.xml     → sitemap for that host
//   GET /robots.txt      → allow-all + sitemap pointer
//   GET /:slug           → single article
//   GET /_health         → JSON health (unauthenticated, ignores host)

const express = require('express');
require('dotenv').config();

const supabase = require('./supabase');
const logger = require('./logger');
const { resolveHost, normalizeHost } = require('./hostResolver');
const {
  renderArticleHtml,
  renderIndexHtml,
  renderNotFoundHtml,
  renderUnknownHostHtml,
} = require('./renderer');

const app = express();
const PORT = process.env.PORT || 3002;

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http_request', {
      method: req.method,
      path: req.path,
      host: req.headers.host,
      status: res.statusCode,
      duration_ms: Date.now() - started,
    });
  });
  next();
});

app.get('/_health', (_req, res) => {
  res.json({ status: 'OK', service: 'post-to-blogs', timestamp: new Date().toISOString() });
});

// Everything below this line is host-scoped.
app.use(async (req, res, next) => {
  const host = normalizeHost(req.headers.host);
  if (!host) {
    return res.status(400).type('text/plain').send('Missing Host header');
  }
  // Requests hitting the raw Railway domain aren't customer domains; give a
  // friendly placeholder rather than a scary error.
  const railwayHost = normalizeHost(process.env.RAILWAY_PUBLIC_DOMAIN || 'post-to-blogs-production.up.railway.app');
  if (host === railwayHost || host.endsWith('.up.railway.app')) {
    return res.status(200).type('text/html').send(renderUnknownHostHtml({ hostname: host }));
  }
  const record = await resolveHost(host);
  if (!record) {
    return res.status(404).type('text/html').send(renderUnknownHostHtml({ hostname: host }));
  }
  req.blogHost = record;
  next();
});

app.get('/robots.txt', (req, res) => {
  const host = req.blogHost.hostname;
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', async (req, res) => {
  const { userId, hostname } = req.blogHost;
  const { data, error } = await supabase
    .from('blog_articles')
    .select('slug, updated_at, published_at')
    .eq('user_id', userId)
    .eq('status', 'published')
    .not('slug', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(5000);
  if (error) {
    logger.error('sitemap.query_failed', { hostname, error: error.message });
    return res.status(500).type('text/plain').send('sitemap unavailable');
  }
  const urls = (data || []).map(row => {
    const loc = `https://${hostname}/${row.slug}`;
    const lastmod = row.updated_at || row.published_at;
    return `  <url>\n    <loc>${loc}</loc>${lastmod ? `\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}\n  </url>`;
  }).join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://${hostname}/</loc>\n  </url>\n${urls}\n</urlset>`
  );
});

app.get('/', async (req, res) => {
  const { userId, hostname, metadata } = req.blogHost;
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
    logger.error('index.query_failed', { hostname, error: error.message });
    return res.status(500).type('text/html').send('Server error');
  }
  res.type('text/html').send(renderIndexHtml({ articles: data || [], hostname, siteName }));
});

app.get('/:slug', async (req, res) => {
  const { userId, hostname, metadata } = req.blogHost;
  const slug = String(req.params.slug || '').slice(0, 512);
  if (!slug || !/^[a-z0-9-]+$/i.test(slug)) {
    return res.status(404).type('text/html').send(renderNotFoundHtml({ hostname, siteName: metadata?.site_name }));
  }
  const { data, error } = await supabase
    .from('blog_articles')
    .select('id, slug, title, meta_description, suggested_excerpt, markdown, published_at, updated_at, created_at')
    .eq('user_id', userId)
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();
  if (error) {
    logger.error('article.query_failed', { hostname, slug, error: error.message });
    return res.status(500).type('text/html').send('Server error');
  }
  if (!data) {
    return res.status(404).type('text/html').send(renderNotFoundHtml({ hostname, siteName: metadata?.site_name }));
  }
  res.type('text/html').send(renderArticleHtml({ article: data, hostname, siteName: metadata?.site_name }));
});

app.use((_req, res) => {
  res.status(404).type('text/html').send(renderNotFoundHtml({ hostname: 'unknown' }));
});

app.use((err, req, res, _next) => {
  logger.error('unhandled', { path: req.path, error: err?.message, stack: (err?.stack || '').slice(0, 1500) });
  res.status(500).type('text/plain').send('Internal server error');
});

process.on('uncaughtException', (error) => {
  logger.error('uncaught_exception', { error: error?.message, stack: (error?.stack || '').slice(0, 1500) });
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { reason: String(reason).slice(0, 1500) });
});

app.listen(PORT, () => {
  logger.info('post_to_blogs.started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  console.log(`post-to-blogs listening on ${PORT}`);
});
