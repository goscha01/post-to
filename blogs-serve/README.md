# post-to-blogs

Multi-tenant blog renderer for post-to. Deployed on Vercel.

Serves published `blog_articles` on user-owned custom subdomains (e.g.
`blog.theirsite.com`). Each user registers their subdomain from the main
post-to dashboard; the main backend calls Vercel's Domains API to attach the
hostname to this project. Requests arrive here via the Host header,
Next.js middleware rewrites the URL to an internal API route, we resolve the
owner in Supabase, fetch published articles, and render server-side HTML with
full SEO meta tags.

## Why Next.js + Vercel (not Express + Railway)

Original attempt used Express on Railway. Railway's edge routing for
customDomains never activated for our use case — even with `syncStatus:
ACTIVE`, `targetPort` set, and a valid Let's Encrypt cert, requests kept
getting `x-railway-fallback: true` and never reached the container. Vercel
was built for exactly this multi-tenant pattern (Framer / Webflow / Notion
blogs all work this way).

## Routes (all host-scoped via middleware.js)

- `GET /` → index list of published articles for that host
- `GET /:slug` → single article (SEO-rendered)
- `GET /sitemap.xml`
- `GET /robots.txt`
- `GET /_health` → JSON health check (no host lookup)

## Layout

- `middleware.js` — path-based rewrites to `/api/*` handlers
- `pages/api/*.js` — actual response builders (raw HTML/XML/TXT, no JSX)
- `pages/index.js` — build-stub (never reached at runtime)
- `lib/hostResolver.js` — Supabase lookup + 60s in-memory cache
- `lib/renderer.js` — markdown → HTML with SEO meta tags
- `lib/supabase.js` — Supabase client

## Env

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Set on Vercel via project settings or `vercel env` CLI.

## Deploy

Vercel project deploys from `blogs-serve/` root on every push to master.
The main backend's `blogDomainsService.js` attaches customer domains via the
Vercel Domains API.
