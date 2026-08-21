// Auto-attach a stock hero image to a freshly-generated article.
//
// Best-effort. Any failure (missing PEXELS_API_KEY, no verified S3 domain,
// Pexels down, image too large) is logged and swallowed — the article is
// still valid, it just doesn't have a hero. The user can attach one
// manually via the editor's HeroImageField.
//
// Runs AFTER the blog_articles row is inserted (so we have an ID and a
// destination bucket to write to). Called from both:
//   - routes/ai.js  (manual POST /api/ai/articles)
//   - services/automationExecutor.js  (scheduled article generation)
// One implementation — do not duplicate.

const stockImageService = require('../stockImageService');
const blogHeroImageService = require('../blogHeroImageService');
const blogDomainsService = require('../blogDomainsService');
const seoPipeline = require('./articleSeoPipeline');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

// Returns { attached: boolean, blog?: <updated row>, seo?: <fresh analysis>, reason?: string }
//
// The caller can decide whether to include the updated blog/seo in the HTTP
// response. Reason strings are stable enough to key telemetry on.
async function attachAutoHeroToArticle({ userId, blog, connectionContext = {} }) {
  const skip = (reason) => ({ attached: false, reason });

  if (!process.env.PEXELS_API_KEY) return skip('no_pexels_key');
  if (!blog || !blog.id) return skip('no_blog');

  // Verify there's actually somewhere to write to before we spend an OpenAI
  // + Pexels call. pickS3Domain throws with .status=400 if not.
  try {
    await blogHeroImageService.pickS3Domain(userId);
  } catch (e) {
    return skip('no_s3_domain');
  }

  // Distill the article into visual search terms. Falls back to the raw
  // keyword if the LLM helper fails — the raw keyword is often not visual
  // enough ("routine house cleaning services" → generic photos of houses)
  // but it's better than nothing.
  let query = null;
  try {
    query = await stockImageService.generateVisualQuery({
      title: blog.title,
      excerpt: blog.suggested_excerpt || blog.meta_description || '',
    });
  } catch (e) {
    logger.warn('auto_hero.visual_query_failed', { blog_id: blog.id, error: e.message });
  }
  if (!query) query = blog.keyword || blog.title || 'clean home';

  // Search + pick. If Pexels returns zero (rare — even generic queries hit
  // something), skip cleanly.
  let candidates = [];
  try {
    candidates = await stockImageService.searchPexels(query);
  } catch (e) {
    return skip(`pexels_error:${e.message}`);
  }
  if (!candidates.length) return skip('no_candidates');
  const chosen = candidates[0];

  // Fetch bytes → upload to the customer's S3 → row gets hero_image set.
  let updated;
  try {
    const { buffer, contentType, bytes } = await stockImageService.downloadImage(chosen.full_url);
    updated = await blogHeroImageService.uploadFromBuffer({
      userId,
      blogId: blog.id,
      buffer,
      contentType,
      bytes,
    });
  } catch (e) {
    return skip(`upload_failed:${e.message}`);
  }

  // Set hero_alt (prefer Pexels-supplied alt) + hero_image_source_id for
  // future dedup on suggestion. Also clear seo_metadata so the next read
  // recomputes with the hero in place.
  const heroAlt = (chosen.alt || query || blog.title || '').slice(0, 300);
  try {
    const { data: withAlt, error } = await supabase
      .from('blog_articles')
      .update({
        hero_alt: heroAlt,
        hero_image_source_id: chosen.id,
        visual_search_query: query,
        seo_metadata: null, // force recompute next read
      })
      .eq('id', blog.id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    updated = withAlt;
  } catch (e) {
    // Row still has hero_image (from the upload above) — just no alt saved.
    logger.warn('auto_hero.alt_save_failed', { blog_id: blog.id, error: e.message });
  }

  // Recompute SEO now that the hero is attached. Persist the fresh result so
  // the next GET is a pure DB read.
  const analysis = seoPipeline.analyzeExistingArticle({
    article: updated,
    internalHostnames: connectionContext.internalHostnames || [],
    knownInternalUrls: connectionContext.knownInternalUrls || [],
  });
  try {
    await supabase.from('blog_articles')
      .update({ seo_metadata: analysis })
      .eq('id', blog.id).eq('user_id', userId);
  } catch (e) {
    logger.warn('auto_hero.seo_persist_failed', { blog_id: blog.id, error: e.message });
  }

  logger.info('auto_hero.attached', {
    blog_id: blog.id, source: chosen.source, source_id: chosen.id,
    query, hero_path: updated.hero_image,
  });

  return { attached: true, blog: { ...updated, seo_metadata: analysis }, seo: analysis };
}

module.exports = { attachAutoHeroToArticle };
