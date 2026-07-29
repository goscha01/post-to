// S3-backed blog publisher.
//
// When a blog_domain has publish_target='s3', publishing writes the article
// as a markdown file to the customer's S3 bucket. The customer's site build
// pipeline (Vite/Next/whatever) syncs the bucket down into its posts source
// directory and rebuilds — the article ends up on their main domain with
// their real design system.
//
// Modeled on the StampMaker pattern:
//   1. Write posts/<date>-<slug>.md to S3
//   2. Touch posts/trigger.txt (build pipelines watch this to know
//      when to redeploy)
//
// Credentials + bucket config live on the blog_domain row's metadata (see
// blogDomainsService.SENSITIVE_META_KEYS — the AWS secret is stripped from
// any response that goes to the browser).

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const logger = require('../utils/logger');

// Turn a JS object into YAML frontmatter, quoting all values so weird
// characters (colons, quotes, hashes) don't break parsers. Preserves insertion
// order of keys so the frontmatter reads like the source file the customer
// hand-writes for their site.
function toFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`${key}: "${escaped}"`);
  }
  lines.push('---');
  return lines.join('\n');
}

// Inject an inline image after the first prose paragraph — matches how
// Spotless's legacy posts render (hero above the fold via frontmatter, then
// the same or a related image inside the body). Uses the article title as
// alt text (mirrors the legacy pattern: `![<title>](/assets/blog/…)`).
//
// Skip conditions (return markdown unchanged):
//   - No heroUrl to insert.
//   - Body already references that URL (user hand-edited or previous publish
//     already injected — we don't want to duplicate).
//
// If the body has no paragraph break (single paragraph or trailing prose)
// we append at the end so the image still shows up.
function injectHeroInBody({ markdown, heroUrl, title }) {
  if (!heroUrl) return markdown || '';
  const body = markdown || '';
  if (body.includes(heroUrl)) return body;

  const safeAlt = String(title || 'Article image').replace(/\]/g, '\\]').replace(/\n/g, ' ');
  const imgMd = `![${safeAlt}](${heroUrl})`;

  const lines = body.split('\n');
  let inFirstPara = false;
  let insertAfter = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!inFirstPara) {
      if (!trimmed) continue;                          // leading blanks
      if (trimmed.startsWith('#')) continue;           // headings (H1, H2, …)
      if (trimmed.startsWith('![') || trimmed.startsWith('<img')) continue;
      inFirstPara = true;
      continue;
    }
    if (!trimmed) { insertAfter = i; break; }          // end of first paragraph
  }
  if (insertAfter === -1) return `${body}\n\n${imgMd}\n`;
  const before = lines.slice(0, insertAfter + 1).join('\n');
  const after = lines.slice(insertAfter + 1).join('\n');
  return `${before}\n${imgMd}\n${after}`;
}

// Build the markdown body the customer's site expects. Field mapping is
// currently hardcoded to Spotless's schema (title/slug/date/updated/author/
// description/heroImage/wixOriginal). Future: read a mapping from
// domain.metadata.frontmatter_schema so different customers can have
// different field names without a code change.
function buildMarkdown({ blog, domain }) {
  const publishedAt = blog.published_at || new Date().toISOString();
  const updatedAt = blog.updated_at || publishedAt;
  const date = publishedAt.slice(0, 10);
  const updated = updatedAt.slice(0, 10);
  const author = domain.metadata?.author_name || domain.metadata?.site_name || 'Editorial Team';
  const description = blog.meta_description || blog.suggested_excerpt || '';

  const frontmatter = toFrontmatter({
    title: blog.title,
    slug: blog.slug,
    date,
    updated: updated !== date ? updated : '',
    author,
    description,
    heroImage: blog.hero_image || '',
  });

  // Body: strip nothing (site templates like Spotless's already strip the
  // duplicated H1 in cleanerflow/src/lib/blog.js). Inject hero image after
  // the first paragraph so the article body has the same visual rhythm as
  // the customer's legacy posts.
  const body = injectHeroInBody({
    markdown: blog.markdown || '',
    heroUrl: blog.hero_image,
    title: blog.title,
  });
  return `${frontmatter}\n\n${body}\n`;
}

function s3ClientFromDomain(domain) {
  const meta = domain.metadata || {};
  const region = meta.s3_region;
  const accessKeyId = meta.s3_access_key_id;
  const secretAccessKey = meta.s3_access_key_secret;
  if (!region || !accessKeyId || !secretAccessKey) {
    const err = new Error('S3 credentials missing on blog_domain metadata (need s3_region, s3_access_key_id, s3_access_key_secret)');
    err.status = 500;
    throw err;
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

// Filename convention matches StampMaker + Spotless: YYYY-MM-DD-<slug>.md so
// files sort chronologically in an S3 listing.
function objectKey(domain, blog) {
  const meta = domain.metadata || {};
  const prefix = (meta.s3_prefix || 'posts/').replace(/^\/|\/$/g, '') + '/';
  const date = (blog.published_at || new Date().toISOString()).slice(0, 10);
  return `${prefix}${date}-${blog.slug}.md`;
}

async function publish({ blog, domain }) {
  const meta = domain.metadata || {};
  const bucket = meta.s3_bucket;
  if (!bucket) {
    const err = new Error('S3 bucket not configured for this blog domain');
    err.status = 500;
    throw err;
  }
  const client = s3ClientFromDomain(domain);
  const key = objectKey(domain, blog);
  const body = buildMarkdown({ blog, domain });

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'text/markdown; charset=utf-8',
    CacheControl: 'no-cache',
  }));

  // Touch a trigger file so build pipelines watching S3 events see something
  // change even if the article file itself was re-published with identical
  // content (an edited draft with the same date + slug overwrites the same
  // key). Optional — most customers will just run their deploy manually.
  const triggerKey = ((meta.s3_prefix || 'posts/').replace(/^\/|\/$/g, '')) + '/trigger.txt';
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: triggerKey,
    Body: new Date().toISOString(),
    ContentType: 'text/plain',
    CacheControl: 'no-cache',
  }));

  logger.info('blog_publisher.s3.published', {
    bucket, key,
    hostname: meta.hostname,
    slug: blog.slug,
  });

  // Public URL follows the customer's own site pattern — for Spotless that's
  // https://www.spotless.homes/blog/<slug>. We don't attempt to compute it
  // here; caller (routes/blogs.js) builds the URL from
  // domain.metadata.public_url_pattern or falls back to a sensible default.
  return { bucket, key, publishedAt: new Date().toISOString() };
}

async function unpublish({ blog, domain }) {
  const meta = domain.metadata || {};
  const bucket = meta.s3_bucket;
  if (!bucket) return { ok: true };
  const client = s3ClientFromDomain(domain);
  const key = objectKey(domain, blog);
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  logger.info('blog_publisher.s3.unpublished', { bucket, key, hostname: meta.hostname });
  return { ok: true };
}

module.exports = { publish, unpublish, buildMarkdown, objectKey };
