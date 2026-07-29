// Rewrite every request to an internal API route. API routes let us serve
// raw HTML / XML / TXT without Next.js's JSX wrapping, which is what we want
// for SEO-critical fully-hand-rolled pages.
//
// Route table:
//   /_health         → /api/health   (JSON, no host lookup)
//   /                → /api/index    (index list, host-scoped)
//   /sitemap.xml     → /api/sitemap  (host-scoped)
//   /robots.txt      → /api/robots   (host-scoped)
//   /<slug>          → /api/article?slug=<slug>  (host-scoped)

import { NextResponse } from 'next/server';

export const config = {
  // Don't run middleware on Next.js internal paths or existing /api routes.
  matcher: ['/((?!api|_next|favicon.ico).*)'],
};

export function middleware(req) {
  const url = req.nextUrl.clone();
  const pathname = url.pathname;

  if (pathname === '/_health') {
    url.pathname = '/api/health';
    return NextResponse.rewrite(url);
  }
  if (pathname === '/') {
    url.pathname = '/api/root';
    return NextResponse.rewrite(url);
  }
  if (pathname === '/sitemap.xml') {
    url.pathname = '/api/sitemap';
    return NextResponse.rewrite(url);
  }
  if (pathname === '/robots.txt') {
    url.pathname = '/api/robots';
    return NextResponse.rewrite(url);
  }
  // Anything else: treat as article slug. Only [a-z0-9-] slugs are valid;
  // reject others to keep spurious 404 traffic off Supabase.
  const slug = pathname.slice(1);
  if (!/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.next(); // 404 via Next default
  }
  url.pathname = '/api/article';
  url.searchParams.set('slug', slug);
  return NextResponse.rewrite(url);
}
