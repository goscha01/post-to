// Shared helper for host-scoped API routes. Resolves the incoming Host
// header to a blog_domain record; if the host isn't registered / verified,
// serves the "Domain not configured" placeholder (or a friendly 404).

const { resolveHost, normalizeHost } = require('./hostResolver');
const { renderUnknownHostHtml } = require('./renderer');

// Railway-only holdover — the placeholder for people who hit our raw
// deployment domain rather than a customer's registered subdomain. On Vercel
// the equivalent is `<project>.vercel.app`.
function isPlatformHost(host) {
  return (
    !host ||
    host.endsWith('.up.railway.app') ||
    host.endsWith('.vercel.app')
  );
}

async function resolve(req, res) {
  const host = normalizeHost(req.headers.host);
  if (isPlatformHost(host)) {
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderUnknownHostHtml({ hostname: host || 'unknown' }));
    return null;
  }
  const record = await resolveHost(host);
  if (!record) {
    res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderUnknownHostHtml({ hostname: host }));
    return null;
  }
  return record;
}

module.exports = { resolve };
