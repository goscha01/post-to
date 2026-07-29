// Hero image upload / removal for blog articles published via S3.
//
// Images live alongside the markdown in the same customer S3 bucket, under
// the assets/blog/ prefix. The customer's site build syncs both prefixes
// (posts/ → src/data/blog-posts/, assets/ → public/assets/) so the image
// ends up bundled in dist/ and served from their own domain.
//
// URL stored on the row is root-relative (e.g. /assets/blog/<slug>-hero.jpg)
// which is what customer site templates expect for `heroImage:` frontmatter.

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');
const blogDomainsService = require('./blogDomainsService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Content-type → filename extension. Kept small on purpose: image formats
// customer sites commonly serve. AVIF is included because Spotless already
// uses .avif elsewhere; if a customer's Vite pipeline can't serve it, they'll
// just get a broken img — no downstream damage.
const EXT_FROM_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

// Return the first verified blog_domain that's configured for S3 publishing.
// Hero images are stored in the same bucket the article's markdown lives
// in — one domain per customer is the common case. Errors clearly when
// there's nothing to write to.
async function pickS3Domain(userId) {
  const domains = await blogDomainsService.listForUser(userId);
  const candidate = domains.find(d =>
    d.status === 'active' &&
    d.metadata?.verified &&
    d.metadata?.publish_target === 's3'
  );
  if (!candidate) {
    const err = new Error('Add and verify an S3-publishing blog domain before uploading a hero image');
    err.status = 400;
    throw err;
  }
  // Need raw metadata (S3 secret) for the put call — listForUser strips it.
  return blogDomainsService.getForUser({ userId, id: candidate.id });
}

function s3ClientFromDomain(domain) {
  const meta = domain.metadata || {};
  return new S3Client({
    region: meta.s3_region,
    credentials: {
      accessKeyId: meta.s3_access_key_id,
      secretAccessKey: meta.s3_access_key_secret,
    },
  });
}

// Where the image lands. Kept flat under assets/blog/ to match Spotless's
// existing convention (public/assets/blog/*.png etc.) — no per-slug folder.
function objectKey({ slug, ext }) {
  return `assets/blog/${slug}-hero.${ext}`;
}
function publicPath({ slug, ext }) {
  return `/assets/blog/${slug}-hero.${ext}`;
}

async function upload({ userId, blogId, file }) {
  if (!file || !file.buffer) {
    const err = new Error('No file uploaded'); err.status = 400; throw err;
  }
  const ext = EXT_FROM_MIME[file.mimetype];
  if (!ext) {
    const err = new Error(`Unsupported image type: ${file.mimetype}`); err.status = 400; throw err;
  }

  // Load the blog to (a) verify ownership and (b) get the slug for the key.
  const { data: blog, error: loadErr } = await supabase
    .from('blog_articles')
    .select('id, slug, hero_image')
    .eq('user_id', userId).eq('id', blogId).single();
  if (loadErr || !blog) { const err = new Error('Blog not found'); err.status = 404; throw err; }
  if (!blog.slug) { const err = new Error('Blog needs a slug before adding a hero image'); err.status = 400; throw err; }

  const domain = await pickS3Domain(userId);
  const bucket = domain.metadata.s3_bucket;
  const key = objectKey({ slug: blog.slug, ext });

  const client = s3ClientFromDomain(domain);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'public,max-age=31536000,immutable', // slug in the key implies a fresh key when the article slug changes
  }));

  // If the old hero_image had a different extension, delete the stale object
  // so we don't leave orphans in the bucket for a slug that's been rewritten.
  if (blog.hero_image && !blog.hero_image.endsWith(`.${ext}`)) {
    const oldKey = blog.hero_image.replace(/^\/+/, '');
    try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })); }
    catch (e) { logger.warn('blog_hero.old_delete_failed', { key: oldKey, error: e.message }); }
  }

  const path = publicPath({ slug: blog.slug, ext });
  const { data: updated, error: updErr } = await supabase
    .from('blog_articles')
    .update({ hero_image: path })
    .eq('user_id', userId).eq('id', blogId)
    .select('id, slug, hero_image').single();
  if (updErr) throw updErr;

  logger.info('blog_hero.uploaded', { userId, blogId, bucket, key, bytes: file.size });
  return updated;
}

async function remove({ userId, blogId }) {
  const { data: blog, error: loadErr } = await supabase
    .from('blog_articles')
    .select('id, hero_image')
    .eq('user_id', userId).eq('id', blogId).single();
  if (loadErr || !blog) { const err = new Error('Blog not found'); err.status = 404; throw err; }
  if (!blog.hero_image) return blog; // nothing to remove

  try {
    const domain = await pickS3Domain(userId);
    const client = s3ClientFromDomain(domain);
    const key = blog.hero_image.replace(/^\/+/, '');
    await client.send(new DeleteObjectCommand({ Bucket: domain.metadata.s3_bucket, Key: key }));
  } catch (e) {
    // Non-fatal: the DB pointer will be cleared even if S3 delete fails.
    // The stale object just occupies a few KB until manually cleaned.
    logger.warn('blog_hero.s3_delete_failed', { userId, blogId, error: e.message });
  }

  const { data: updated, error: updErr } = await supabase
    .from('blog_articles')
    .update({ hero_image: null })
    .eq('user_id', userId).eq('id', blogId)
    .select('id, slug, hero_image').single();
  if (updErr) throw updErr;

  logger.info('blog_hero.removed', { userId, blogId });
  return updated;
}

// Variant of upload() where the file bytes come from a URL (e.g. a Pexels
// candidate the user picked). Same S3 target and DB write — just the source
// is a Buffer we fetch ourselves instead of a multer file.
async function uploadFromBuffer({ userId, blogId, buffer, contentType, bytes }) {
  return upload({
    userId,
    blogId,
    file: {
      buffer,
      mimetype: contentType,
      size: bytes ?? buffer.byteLength,
    },
  });
}

// Generate a short-lived pre-signed GET URL for the row's hero image so the
// frontend can preview it BEFORE the customer's site has rebuilt (which is
// when the image would actually be reachable at their public /assets/blog/…
// path). Returns null if the row has no hero, or no S3 domain is configured.
async function getPreviewUrl({ userId, heroImagePath }) {
  if (!heroImagePath) return null;
  let domain;
  try { domain = await pickS3Domain(userId); }
  catch { return null; }
  try {
    const client = s3ClientFromDomain(domain);
    const cmd = new GetObjectCommand({
      Bucket: domain.metadata.s3_bucket,
      Key: heroImagePath.replace(/^\/+/, ''),
    });
    // 1 hour — plenty for a page-load preview; frontend can refetch on
    // the next request if the user leaves the page open long enough.
    return await getSignedUrl(client, cmd, { expiresIn: 3600 });
  } catch (e) {
    logger.warn('blog_hero.preview_url_failed', { userId, error: e.message });
    return null;
  }
}

module.exports = { upload, uploadFromBuffer, remove, publicPath, objectKey, getPreviewUrl };
