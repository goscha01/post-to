# post-to-blogs

Multi-tenant blog renderer for post-to.

Serves published `blog_articles` rows on user-owned custom subdomains
(e.g. `blog.theirsite.com`). Each user registers their subdomain from the
main post-to dashboard; the main backend calls Railway's `customDomainCreate`
mutation to attach the hostname to this service and inserts a
`blog_domain` row in `connected_accounts`. Requests arrive here via the
Host header, we resolve the owner, fetch published articles from Supabase,
and render server-side HTML with full SEO meta tags.

## Routes

All routes are scoped by Host header:

- `GET /` — index list of published articles for that host
- `GET /:slug` — single article (SEO-rendered)
- `GET /sitemap.xml`
- `GET /robots.txt`
- `GET /_health` — health check (ignores host)

## Deploy

Deployed as a separate Railway service `post-to-blogs` in the `Post to server`
project. Root directory `blogs-serve`, start command `npm start`. Auto-deploys
from `master` branch.

## Env

See `.env.example`. All secrets set on Railway; nothing in the repo.

## Why a separate service

Blog traffic could spike independently of the API. Splitting means:
- API latency unaffected by a viral blog post
- Independent scaling / restart
- Own Loki `service_name` label (`post-to-blogs`) for clean log filtering
- Simpler custom-domain routing — one Railway service = one CNAME target
