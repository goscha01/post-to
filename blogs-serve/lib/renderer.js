// Server-rendered HTML for a single blog article and the index list.
//
// Goals:
//   1. SEO-strong: title, meta description, canonical, Open Graph, Twitter
//      card, and Article JSON-LD schema on every article page.
//   2. Dependency-light: markdown → HTML via `marked`, no template engine —
//      just tagged-template strings with escaping.
//   3. Framework-free CSS. One inline <style> block, no external assets.
//      Renders fast + no CLS + no third-party requests.

import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false, headerIds: true, mangle: false });

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseStyles(theme) {
  const primary = theme?.primaryColor || '#2563eb';
  // Font stack: if we know the site's primary family, put it first with the
  // usual system fallbacks after. Fonts URL (Google Fonts) is emitted
  // separately in <head> so the family is actually loaded.
  const fontStack = theme?.fontFamily
    ? `"${theme.fontFamily}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`
    : `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  return `
    :root { --fg:#111827; --muted:#6b7280; --link:${primary}; --bg:#ffffff; --border:#e5e7eb; --code-bg:#f3f4f6; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
    body { font: 17px/1.65 ${fontStack}; }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 720px; margin: 0 auto; padding: 32px 20px 96px; }
    header.site { padding: 20px 0 8px; border-bottom: 1px solid var(--border); margin-bottom: 32px; }
    header.site a.brand { font-weight: 600; color: var(--fg); font-size: 15px; display: inline-flex; align-items: center; gap: 10px; }
    header.site a.brand img.logo { height: 28px; width: auto; display: block; }
    h1 { font-size: 2rem; line-height: 1.25; margin: 0 0 12px; letter-spacing: -0.01em; }
    h2 { font-size: 1.5rem; line-height: 1.3; margin: 2rem 0 0.75rem; }
    h3 { font-size: 1.2rem; margin: 1.5rem 0 0.5rem; }
    p, ul, ol, blockquote { margin: 0 0 1rem; }
    ul, ol { padding-left: 1.5rem; }
    blockquote { border-left: 3px solid var(--border); padding-left: 16px; color: var(--muted); }
    img { max-width: 100%; height: auto; border-radius: 6px; }
    code { background: var(--code-bg); padding: 2px 5px; border-radius: 4px; font-size: 0.9em; }
    pre { background: var(--code-bg); padding: 14px; border-radius: 6px; overflow-x: auto; }
    pre code { background: transparent; padding: 0; }
    hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }
    .meta { color: var(--muted); font-size: 0.9rem; margin-bottom: 24px; }
    .article-list { list-style: none; padding: 0; margin: 0; }
    .article-list li { padding: 20px 0; border-bottom: 1px solid var(--border); }
    .article-list li:last-child { border-bottom: 0; }
    .article-list h2 { font-size: 1.25rem; margin: 0 0 6px; }
    .article-list p { margin: 0; color: var(--muted); }
    footer.site { margin-top: 64px; padding-top: 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; }
  `.replace(/\s+/g, ' ').trim();
}

// Emit the Google Fonts <link> stack in <head>. Preconnect first for a
// faster paint since fonts often block layout.
function fontsHeadTags(theme) {
  if (!theme?.fontsUrl) return '';
  return `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="${escapeHtml(theme.fontsUrl)}" />`;
}

// Brand: if we have a logo URL from the theme scrape, use it (with the site
// name as alt for accessibility + SEO); otherwise fall back to text.
function brandInner(theme, siteLabel) {
  if (theme?.logoUrl) {
    return `<img class="logo" src="${escapeHtml(theme.logoUrl)}" alt="${escapeHtml(siteLabel)}" />`;
  }
  return escapeHtml(siteLabel);
}

function renderArticleHtml({ article, hostname, siteName, theme }) {
  const canonical = `https://${hostname}/${escapeHtml(article.slug)}`;
  const title = article.title || '(untitled)';
  const description = article.meta_description || article.suggested_excerpt || '';
  const bodyHtml = marked.parse(article.markdown || '');
  const published = article.published_at || article.updated_at || article.created_at;
  const published_iso = published ? new Date(published).toISOString() : null;
  const siteLabel = siteName || hostname;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    url: canonical,
    ...(published_iso ? { datePublished: published_iso, dateModified: published_iso } : {}),
    ...(siteName ? { publisher: { '@type': 'Organization', name: siteName } } : {}),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}" />` : ''}
<link rel="canonical" href="${canonical}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escapeHtml(title)}" />
${description ? `<meta property="og:description" content="${escapeHtml(description)}" />` : ''}
<meta property="og:url" content="${canonical}" />
${siteName ? `<meta property="og:site_name" content="${escapeHtml(siteName)}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
${description ? `<meta name="twitter:description" content="${escapeHtml(description)}" />` : ''}
${theme?.primaryColor ? `<meta name="theme-color" content="${escapeHtml(theme.primaryColor)}" />` : ''}
${theme?.logoUrl ? `<link rel="icon" href="${escapeHtml(theme.logoUrl)}" />` : ''}
<meta name="robots" content="index, follow" />
${fontsHeadTags(theme)}
<style>${baseStyles(theme)}</style>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<div class="container">
  <header class="site"><a class="brand" href="/">${brandInner(theme, siteLabel)}</a></header>
  <article>
    <h1>${escapeHtml(title)}</h1>
    ${published_iso ? `<div class="meta"><time datetime="${published_iso}">${new Date(published).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</time></div>` : ''}
    ${bodyHtml}
  </article>
  <footer class="site">&copy; ${new Date().getFullYear()} ${escapeHtml(siteLabel)}</footer>
</div>
</body>
</html>`;
}

function renderIndexHtml({ articles, hostname, siteName, theme }) {
  const siteLabel = siteName || hostname;
  const items = articles.map(a => {
    const excerpt = a.meta_description || a.suggested_excerpt || '';
    return `<li>
      <h2><a href="/${escapeHtml(a.slug)}">${escapeHtml(a.title || '(untitled)')}</a></h2>
      ${excerpt ? `<p>${escapeHtml(excerpt)}</p>` : ''}
    </li>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(siteLabel)}</title>
<meta name="description" content="Articles from ${escapeHtml(siteLabel)}" />
<link rel="canonical" href="https://${escapeHtml(hostname)}/" />
${theme?.primaryColor ? `<meta name="theme-color" content="${escapeHtml(theme.primaryColor)}" />` : ''}
${theme?.logoUrl ? `<link rel="icon" href="${escapeHtml(theme.logoUrl)}" />` : ''}
<meta name="robots" content="index, follow" />
${fontsHeadTags(theme)}
<style>${baseStyles(theme)}</style>
</head>
<body>
<div class="container">
  <header class="site"><a class="brand" href="/">${brandInner(theme, siteLabel)}</a></header>
  <h1>Articles</h1>
  ${articles.length === 0
    ? '<p class="meta">No articles published yet.</p>'
    : `<ul class="article-list">${items}</ul>`}
  <footer class="site">&copy; ${new Date().getFullYear()} ${escapeHtml(siteLabel)}</footer>
</div>
</body>
</html>`;
}

function renderNotFoundHtml({ hostname, siteName }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Not found — ${escapeHtml(siteName || hostname)}</title>
<meta name="robots" content="noindex" />
<style>${baseStyles()}</style>
</head>
<body>
<div class="container">
  <header class="site"><a class="brand" href="/">${escapeHtml(siteName || hostname)}</a></header>
  <h1>Not found</h1>
  <p class="meta">The article you're looking for doesn't exist or hasn't been published.</p>
  <p><a href="/">Back to all articles</a></p>
</div>
</body>
</html>`;
}

function renderUnknownHostHtml({ hostname }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Domain not configured</title>
<meta name="robots" content="noindex" />
<style>${baseStyles()}</style>
</head>
<body>
<div class="container">
  <h1>Domain not configured</h1>
  <p class="meta">
    <code>${escapeHtml(hostname)}</code> points to post-to's blog service but has not been
    verified in the dashboard yet. Log in to
    <a href="https://post-to.app/blogs">post-to.app/blogs</a> to complete setup.
  </p>
</div>
</body>
</html>`;
}

export {
  renderArticleHtml,
  renderIndexHtml,
  renderNotFoundHtml,
  renderUnknownHostHtml,
};
