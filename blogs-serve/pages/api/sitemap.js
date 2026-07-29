const supabase = require('../../lib/supabase');
const { resolve } = require('../../lib/hostGuard');

module.exports = async function handler(req, res) {
  const record = await resolve(req, res);
  if (!record) return;
  const { userId, hostname } = record;
  const { data, error } = await supabase
    .from('blog_articles')
    .select('slug, updated_at, published_at')
    .eq('user_id', userId)
    .eq('status', 'published')
    .not('slug', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(5000);
  if (error) {
    console.error('sitemap.query_failed', hostname, error.message);
    res.status(500).setHeader('Content-Type', 'text/plain').send('sitemap unavailable');
    return;
  }
  const urls = (data || []).map(row => {
    const loc = `https://${hostname}/${row.slug}`;
    const lastmod = row.updated_at || row.published_at;
    return `  <url>\n    <loc>${loc}</loc>${lastmod ? `\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}\n  </url>`;
  }).join('\n');
  res.status(200).setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://${hostname}/</loc>\n  </url>\n${urls}\n</urlset>`
  );
};
