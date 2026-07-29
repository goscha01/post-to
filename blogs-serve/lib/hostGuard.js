// Shared helper for host-scoped API routes. Resolves the incoming Host
// header to a blog_domain record; if the host isn't registered / verified,
// serves the "Domain not configured" placeholder (or a friendly 404).

import { resolveHost, normalizeHost } from './hostResolver';
import { renderUnknownHostHtml } from './renderer';

function isPlatformHost(host) {
  return (
    !host ||
    host.endsWith('.up.railway.app') ||
    host.endsWith('.vercel.app')
  );
}

export async function resolve(req, res) {
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
