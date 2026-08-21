// autoHero.attachAutoHeroToArticle — unit tests.
//
// Mocks the underlying services (stockImageService + blogHeroImageService)
// so we exercise the orchestration deterministically:
//   * skips when PEXELS_API_KEY isn't set
//   * skips when there's no verified S3 blog_domain
//   * skips when Pexels returns zero candidates
//   * attaches on the happy path, persists hero_alt + source_id
//   * failures in the alt-save don't drop the attach

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// --- fake supabase (row-store) ---
const state = { rows: { blog_articles: [] }, updates: [] };
class FakeQuery {
  constructor(t) { this.t = t; this.op = 'select'; this.eqs = {}; this.payload = null; }
  select() { return this; }
  update(p) { this.op = 'update'; this.payload = p; state.updates.push({ t: this.t, p, eqs: this.eqs }); return this; }
  eq(c, v) { this.eqs[c] = v; return this; }
  async single() {
    const row = state.rows[this.t].find(r => Object.entries(this.eqs).every(([k, v]) => r[k] === v));
    if (this.op === 'update' && row) { Object.assign(row, this.payload); return { data: row, error: null }; }
    return { data: row || null, error: row ? null : { code: 'PGRST116', message: 'no row' } };
  }
  then(res, rej) { return this.single().then(res, rej); }
}
const fakeClient = { from: (t) => new FakeQuery(t) };

const originalRequire = Module.prototype.require;
Module.prototype.require = function patched(id) {
  if (id === '@supabase/supabase-js') return { createClient: () => fakeClient };
  return originalRequire.apply(this, arguments);
};

process.env.SUPABASE_URL = 'http://x';
process.env.SUPABASE_ANON_KEY = 'x';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';

const stockImageService = require('../../src/services/stockImageService');
const blogHeroImageService = require('../../src/services/blogHeroImageService');
const autoHero = require('../../src/services/seo/autoHero');

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

test('skips silently when PEXELS_API_KEY is not set', async () => {
  delete process.env.PEXELS_API_KEY;
  const result = await autoHero.attachAutoHeroToArticle({
    userId: 'u1', blog: { id: 'b1', title: 't' }, connectionContext: {},
  });
  assert.equal(result.attached, false);
  assert.equal(result.reason, 'no_pexels_key');
});

test('skips when no verified S3 blog_domain', async () => {
  process.env.PEXELS_API_KEY = 'fake';
  blogHeroImageService.pickS3Domain = async () => { const e = new Error('no dom'); e.status = 400; throw e; };
  const result = await autoHero.attachAutoHeroToArticle({
    userId: 'u1', blog: { id: 'b1', title: 't' }, connectionContext: {},
  });
  assert.equal(result.attached, false);
  assert.equal(result.reason, 'no_s3_domain');
});

test('skips when Pexels returns no candidates', async () => {
  process.env.PEXELS_API_KEY = 'fake';
  blogHeroImageService.pickS3Domain = async () => ({ metadata: {} });
  stockImageService.generateVisualQuery = async () => 'cleaning kitchen';
  stockImageService.searchPexels = async () => [];
  const result = await autoHero.attachAutoHeroToArticle({
    userId: 'u1', blog: { id: 'b1', title: 't' }, connectionContext: {},
  });
  assert.equal(result.attached, false);
  assert.equal(result.reason, 'no_candidates');
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('attaches on happy path, persists hero_alt + source_id, recomputes SEO', async () => {
  process.env.PEXELS_API_KEY = 'fake';
  state.rows.blog_articles.push({
    id: 'b-happy', user_id: 'u1',
    keyword: 'routine house cleaning services',
    title: 'Routine House Cleaning Services in Tampa',
    slug: 'routine-house-cleaning-services-tampa',
    meta_description: 'A guide to routine house cleaning services in Tampa.',
    markdown: '## Intro\n\nSome content about routine house cleaning services in Tampa.',
    suggested_excerpt: 'A guide.',
    hero_image: null, hero_alt: null,
    seo_metadata: { score: 60 },
  });
  state.updates.length = 0;

  blogHeroImageService.pickS3Domain = async () => ({ metadata: {} });
  stockImageService.generateVisualQuery = async () => 'clean tampa home';
  stockImageService.searchPexels = async () => [{
    id: 'pexels:12345', full_url: 'https://images.pexels.com/photos/12345/hero.jpg',
    alt: 'A tidy Tampa home', source: 'pexels',
  }];
  stockImageService.downloadImage = async () => ({
    buffer: Buffer.from('img'), contentType: 'image/jpeg', bytes: 3,
  });
  blogHeroImageService.uploadFromBuffer = async ({ blogId }) => {
    // Simulate the row after the hero image was written.
    const row = state.rows.blog_articles.find(r => r.id === blogId);
    row.hero_image = '/assets/blog/routine-house-cleaning-services-tampa-hero.jpg';
    return { ...row };
  };

  const result = await autoHero.attachAutoHeroToArticle({
    userId: 'u1',
    blog: state.rows.blog_articles[0],
    connectionContext: { internalHostnames: ['spotless.homes'], knownInternalUrls: ['/x'] },
  });

  assert.equal(result.attached, true);
  assert.ok(result.blog.hero_image, 'blog carries the uploaded hero_image path');
  assert.equal(result.blog.hero_alt, 'A tidy Tampa home');
  assert.ok(result.seo, 'fresh analysis attached');
  assert.equal(typeof result.seo.score, 'number');

  // Row got the alt + source_id + null seo_metadata written back.
  const altUpdate = state.updates.find((u) => u.p.hero_alt);
  assert.ok(altUpdate);
  assert.equal(altUpdate.p.hero_image_source_id, 'pexels:12345');
  assert.equal(altUpdate.p.seo_metadata, null, 'seo_metadata invalidated after hero attach');
});

test('when uploadFromBuffer throws, returns clean skip reason', async () => {
  process.env.PEXELS_API_KEY = 'fake';
  blogHeroImageService.pickS3Domain = async () => ({ metadata: {} });
  stockImageService.generateVisualQuery = async () => 'cleaning';
  stockImageService.searchPexels = async () => [{ id: 'p:1', full_url: 'https://x', alt: 'a' }];
  stockImageService.downloadImage = async () => ({ buffer: Buffer.from(''), contentType: 'image/jpeg', bytes: 0 });
  blogHeroImageService.uploadFromBuffer = async () => { throw new Error('s3 boom'); };

  const result = await autoHero.attachAutoHeroToArticle({
    userId: 'u1', blog: { id: 'x', title: 't' }, connectionContext: {},
  });
  assert.equal(result.attached, false);
  assert.match(result.reason, /^upload_failed:/);
});
