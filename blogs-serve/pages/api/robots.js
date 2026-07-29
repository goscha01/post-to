const { resolve } = require('../../lib/hostGuard');

module.exports = async function handler(req, res) {
  const record = await resolve(req, res);
  if (!record) return;
  const host = record.hostname;
  res.status(200).setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`);
};
