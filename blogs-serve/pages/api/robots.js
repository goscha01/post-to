import { resolve } from '../../lib/hostGuard';

export default async function handler(req, res) {
  try {
    const record = await resolve(req, res);
    if (!record) return;
    const host = record.hostname;
    res.status(200).setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`);
  } catch (err) {
    console.error('robots.unhandled', err?.message, err?.stack);
    res.status(500).setHeader('Content-Type', 'text/plain').send('Server error');
  }
}
