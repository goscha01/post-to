// API-level tests for the SEO endpoints on /api/blogs and /api/ai/articles.
//
// Mocks supabase + auth + LLM exactly like reviews-generate-post.test.js so
// we exercise the real express middleware chain without hitting Postgres or
// OpenAI.
//
// What we assert:
//   * POST /api/ai/articles persists new SEO columns (tags, seo_metadata, faq...)
//     and returns { seo } in the response.
//   * POST /api/blogs/:id/seo-analyze computes analysis on a legacy row that
//     has no seo_metadata and persists the result.
//   * PATCH /api/blogs/:id invalidates seo_metadata when analyzer-relevant
//     fields change, but leaves it alone for cosmetic-only edits.
//   * POST /api/blogs/:id/seo-fix runs a targeted repair and returns changed
//     fields + a fresh analysis.
//   * Ownership boundaries — a user cannot analyze/fix another user's row.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// Fake supabase + insert/update capture
// ---------------------------------------------------------------------------

const state = {
  // seed: { [table]: [{ ... }, ...] } — rows returned by .single()
  rows: { blog_articles: [], connected_accounts: [], ai_jobs: [] },
  updates: [],   // [{ table, patch, eqs }]
  inserts: [],   // [{ table, payload }]
};

function resetState() {
  state.rows.blog_articles = [];
  state.rows.connected_accounts = [];
  state.rows.ai_jobs = [];
  state.updates.length = 0;
  state.inserts.length = 0;
}

function findRow(table, eqs) {
  return state.rows[table].find((row) => {
    for (const [k, v] of Object.entries(eqs)) {
      if (row[k] !== v) return false;
    }
    return true;
  });
}

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.payload = null;
    this.eqs = {};
    this._selectCols = '*';
    this.isCountHead = false;
  }
  select(cols, opts) {
    this._selectCols = cols || '*';
    if (opts && opts.head) { this.isCountHead = true; this.op = 'count'; }
    return this;
  }
  insert(payload) { this.op = 'insert'; this.payload = payload; state.inserts.push({ table: this.table, payload }); return this; }
  update(payload) { this.op = 'update'; this.payload = payload; state.updates.push({ table: this.table, patch: payload, eqs: this.eqs }); return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col, val) { this.eqs[col] = val; return this; }
  in() { return this; }
  gte() { return this; }
  order() { return this; }
  limit() { return this; }

  async single() { return this._resolve(); }
  then(resolve, reject) { return this._resolve().then(resolve, reject); }

  async _resolve() {
    if (this.op === 'count') return { count: 0, error: null };
    if (this.op === 'insert') {
      const withId = Array.isArray(this.payload)
        ? this.payload.map((p) => ({ id: `${this.table}-${Math.random().toString(36).slice(2, 8)}`, ...p }))
        : { id: `${this.table}-${Math.random().toString(36).slice(2, 8)}`, ...this.payload };
      // Reflect the insert into the row store so subsequent lookups find it.
      if (Array.isArray(withId)) state.rows[this.table].push(...withId);
      else state.rows[this.table].push(withId);
      return { data: withId, error: null };
    }
    if (this.op === 'update') {
      const row = findRow(this.table, this.eqs);
      if (!row) return { data: null, error: { code: 'PGRST116', message: 'no row' } };
      Object.assign(row, this.payload);
      return { data: row, error: null };
    }
    if (this.op === 'delete') {
      const idx = state.rows[this.table].findIndex((row) => {
        for (const [k, v] of Object.entries(this.eqs)) if (row[k] !== v) return false;
        return true;
      });
      if (idx === -1) return { data: null, error: null };
      const [removed] = state.rows[this.table].splice(idx, 1);
      return { data: removed, error: null };
    }
    // select
    const row = findRow(this.table, this.eqs);
    if (!row) return { data: null, error: { code: 'PGRST116', message: 'no row' } };
    return { data: row, error: null };
  }
}

const fakeSupabaseClient = { from(table) { return new FakeQuery(table); } };

// ---------------------------------------------------------------------------
// Patch require BEFORE loading anything else
// ---------------------------------------------------------------------------

const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === '@supabase/supabase-js') return { createClient: () => fakeSupabaseClient };
  return originalRequire.apply(this, arguments);
};

process.env.SUPABASE_URL = 'http://example.com';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.JWT_SECRET = 'jwt';
process.env.OPENAI_API_KEY = 'sk-test';

// ---------------------------------------------------------------------------
// Stub auth
// ---------------------------------------------------------------------------

let currentUser = { userId: 'user-A' };

const authMwPath = require.resolve('../src/middleware/authMiddleware');
require.cache[authMwPath] = {
  id: authMwPath, filename: authMwPath, loaded: true,
  exports: function fakeAuth(req, _res, next) { req.user = { ...currentUser }; next(); },
};

// ---------------------------------------------------------------------------
// Stub LLM
// ---------------------------------------------------------------------------

const aiContent = require('../src/services/aiContentService');
const { STRONG_BODY } = require('./seo/fixtures');

const strongLlmOutput = () => ({
  data: aiContent.normalizeArticleOutput({
    title: 'Routine House Cleaning Services in Tampa: A Complete Guide',
    slug: 'routine-house-cleaning-services-tampa',
    metaDescription: 'Routine house cleaning services in Tampa: what they cover, how often to book, what they cost, and how to make bi-weekly cleaning work in Florida humidity.',
    markdown: STRONG_BODY,
    suggestedExcerpt: 'A guide to routine house cleaning services in Tampa.',
    suggestedSocialPost: 'New guide up on routine cleaning in Tampa.',
    tags: ['tampa', 'cleaning', 'home maintenance', 'residential'],
    searchIntent: 'informational',
    faq: [{ question: 'How long does a routine visit take?', answer: '90 minutes to three hours.' }],
    imageSuggestions: [{ description: 'clean kitchen', alt: 'a clean kitchen in a Tampa home after routine cleaning' }],
    suggestedInternalLinks: [{ anchor: 'our recurring cleaning service', url: '/services/recurring-cleaning' }],
  }),
  raw: '{}', prompt: 'p', model: 'gpt-4o-mini',
  usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 }, costUsd: 0.001,
});

aiContent.generateArticle = async () => strongLlmOutput();
// Repair should not fire on the strong output — but if it does, return the
// same thing so accepted-when-better logic keeps the initial draft.
aiContent.repairArticle = async () => strongLlmOutput();

// connectionsService stub
const connectionsService = require('../src/services/connectionsService');
connectionsService.getForUser = async () => null;

// ---------------------------------------------------------------------------
// Load routes AFTER stubs are wired
// ---------------------------------------------------------------------------

const blogsRouter = require('../src/routes/blogs');
const aiRouter = require('../src/routes/ai');
const express = require('express');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/blogs', blogsRouter);
  app.use('/api/ai', aiRouter);
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            let parsed = data; try { parsed = JSON.parse(data); } catch {}
            resolve({ statusCode: res.statusCode, body: parsed });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ==========================================================================
// POST /api/ai/articles — new SEO fields persisted + seo returned
// ==========================================================================

test('POST /api/ai/articles persists structured SEO fields and returns seo analysis', async () => {
  resetState();
  currentUser = { userId: 'user-A' };
  const app = makeApp();
  const res = await request(app, 'POST', '/api/ai/articles', {
    keyword: 'routine house cleaning services',
  });
  assert.equal(res.statusCode, 201);
  assert.ok(res.body.id, 'article id in response');
  assert.equal(res.body.title, 'Routine House Cleaning Services in Tampa: A Complete Guide');
  assert.ok(Array.isArray(res.body.tags) && res.body.tags.length > 0);
  assert.ok(res.body.seo, 'seo analysis in response');
  assert.ok(typeof res.body.seo.score === 'number');
  assert.ok(res.body.seo.analyzerVersion >= 1);
  assert.ok(Array.isArray(res.body.seo.checks) && res.body.seo.checks.length > 0);

  // Assert the persisted row has the new columns populated.
  const inserted = state.inserts.find((i) => i.table === 'blog_articles');
  assert.ok(inserted, 'blog_articles insert happened');
  assert.deepEqual(inserted.payload.tags, ['tampa', 'cleaning', 'home maintenance', 'residential']);
  assert.equal(inserted.payload.search_intent, 'informational');
  assert.ok(inserted.payload.seo_metadata, 'seo_metadata persisted');
  assert.ok(Array.isArray(inserted.payload.faq));
  assert.equal(inserted.payload.status, 'draft', 'article remains a draft after generation');
});

// ==========================================================================
// POST /api/blogs/:id/seo-analyze — legacy row (no seo_metadata) computes fresh
// ==========================================================================

test('POST /api/blogs/:id/seo-analyze analyzes a legacy row with no seo_metadata', async () => {
  resetState();
  currentUser = { userId: 'user-A' };
  const legacyId = '00000000-0000-0000-0000-000000000001';
  state.rows.blog_articles.push({
    id: legacyId, user_id: 'user-A',
    connection_id: null, business_profile_id: null,
    keyword: 'routine house cleaning services',
    title: 'Routine House Cleaning Services in Tampa: A Complete Guide',
    slug: 'routine-house-cleaning-services-tampa',
    meta_description: 'A guide to routine house cleaning services in Tampa, covering cadence, cost, and what to expect.',
    markdown: STRONG_BODY,
    tags: null, search_intent: null, seo_metadata: null,
    hero_image: 'https://cdn.spotless.homes/blog/hero.jpg',
    hero_alt: 'a tidy Tampa home', status: 'draft',
  });

  const app = makeApp();
  const res = await request(app, 'POST', `/api/blogs/${legacyId}/seo-analyze`, {});
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.seo);
  assert.ok(typeof res.body.seo.score === 'number');
  assert.ok(res.body.seo.contentHash, 'contentHash on analysis');
  // Row got the analysis written back.
  const persisted = state.updates.find((u) => u.table === 'blog_articles' && u.patch.seo_metadata);
  assert.ok(persisted, 'seo_metadata written back');
});

// ==========================================================================
// Ownership: user-B cannot analyze user-A's row
// ==========================================================================

test('POST /api/blogs/:id/seo-analyze returns 404 for another user\'s row', async () => {
  resetState();
  currentUser = { userId: 'user-B' };
  const otherId = '00000000-0000-0000-0000-000000000002';
  state.rows.blog_articles.push({
    id: otherId, user_id: 'user-A',
    title: 't', slug: 's', meta_description: 'm', markdown: '## x', hero_image: 'x',
  });
  const app = makeApp();
  const res = await request(app, 'POST', `/api/blogs/${otherId}/seo-analyze`, {});
  assert.equal(res.statusCode, 404);
});

// ==========================================================================
// PATCH invalidates seo_metadata when analyzer-relevant fields change
// ==========================================================================

test('PATCH /api/blogs/:id invalidates seo_metadata when title/markdown/etc change', async () => {
  resetState();
  currentUser = { userId: 'user-A' };
  const id = '00000000-0000-0000-0000-000000000003';
  state.rows.blog_articles.push({
    id, user_id: 'user-A', title: 'old', slug: 's', meta_description: 'm',
    markdown: '## x', seo_metadata: { score: 90, cached: true }, status: 'draft',
  });
  const app = makeApp();
  const res = await request(app, 'PATCH', `/api/blogs/${id}`, { title: 'new title' });
  assert.equal(res.statusCode, 200);
  const update = state.updates.find((u) => u.table === 'blog_articles' && u.patch.title === 'new title');
  assert.ok(update);
  assert.equal(update.patch.seo_metadata, null, 'seo_metadata cleared to force recompute');
});

test('PATCH /api/blogs/:id does NOT invalidate seo_metadata for cosmetic-only fields', async () => {
  resetState();
  currentUser = { userId: 'user-A' };
  const id = '00000000-0000-0000-0000-000000000004';
  const cached = { score: 92, cached: true };
  state.rows.blog_articles.push({
    id, user_id: 'user-A', title: 't', slug: 's', meta_description: 'm',
    markdown: '## x', seo_metadata: cached, status: 'draft',
  });
  const app = makeApp();
  // suggestedExcerpt is not an analyzer input — should not invalidate.
  const res = await request(app, 'PATCH', `/api/blogs/${id}`, { suggestedExcerpt: 'new excerpt' });
  assert.equal(res.statusCode, 200);
  const update = state.updates.find((u) => u.table === 'blog_articles' && u.patch.suggested_excerpt === 'new excerpt');
  assert.ok(update);
  assert.ok(!Object.prototype.hasOwnProperty.call(update.patch, 'seo_metadata'), 'no seo invalidation for cosmetic edit');
});

// ==========================================================================
// POST /api/blogs/:id/seo-fix — targeted repair returns changed + previous
// ==========================================================================

test('POST /api/blogs/:id/seo-fix applies changes and returns changed + previous', async () => {
  resetState();
  currentUser = { userId: 'user-A' };
  const id = '00000000-0000-0000-0000-000000000005';
  state.rows.blog_articles.push({
    id, user_id: 'user-A',
    keyword: 'routine house cleaning services',
    title: 'short',        // fails title_length + keyword_in_title
    slug: 'x',
    meta_description: 'm',
    markdown: '## Small\n\nA tiny article.',
    tags: [], hero_image: 'x', hero_alt: 'x',
    business_name: 'Spotless Homes',
    status: 'draft',
  });
  // Stub repairArticle to swap in a better title so we can verify the diff.
  aiContent.repairArticle = async ({ previousJson }) => ({
    data: aiContent.normalizeArticleOutput({
      ...previousJson,
      title: 'Routine House Cleaning Services in Tampa: A Complete Guide',
      metaDescription: 'A better meta description that also happens to include routine house cleaning services in Tampa.',
    }),
    raw: '{}', prompt: 'p', model: 'gpt-4o-mini',
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }, costUsd: 0.001,
  });

  const app = makeApp();
  const res = await request(app, 'POST', `/api/blogs/${id}/seo-fix`, { checkId: 'title_length' });
  assert.equal(res.statusCode, 200, `body: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.changed.title, 'title in changed');
  assert.equal(res.body.previous.title, 'short');
  assert.ok(res.body.seo);
  assert.ok(res.body.seo.checks.length > 0);

  // Restore for other tests
  aiContent.repairArticle = async () => strongLlmOutput();
});

test('POST /api/blogs/:id/seo-fix returns 404 for another user\'s row', async () => {
  resetState();
  currentUser = { userId: 'user-B' };
  const id = '00000000-0000-0000-0000-000000000006';
  state.rows.blog_articles.push({
    id, user_id: 'user-A', title: 't', slug: 's', meta_description: 'm',
    markdown: '## x', status: 'draft', business_name: 'x',
  });
  const app = makeApp();
  const res = await request(app, 'POST', `/api/blogs/${id}/seo-fix`, { checkId: 'title_length' });
  assert.equal(res.statusCode, 404);
});

// ==========================================================================
// GET auto-computes SEO when missing
// ==========================================================================

test('GET /api/blogs/:id auto-computes SEO when seo_metadata is missing', async () => {
  resetState();
  currentUser = { userId: 'user-A' };
  const id = '00000000-0000-0000-0000-000000000007';
  state.rows.blog_articles.push({
    id, user_id: 'user-A',
    keyword: 'routine house cleaning services',
    title: 'Routine House Cleaning Services in Tampa',
    slug: 'routine-house-cleaning-services-tampa',
    meta_description: 'A guide about routine house cleaning services in Tampa Florida.',
    markdown: STRONG_BODY,
    hero_image: 'https://cdn.spotless.homes/blog/hero.jpg',
    hero_alt: 'a tidy Tampa home',
    seo_metadata: null, status: 'draft',
  });
  const app = makeApp();
  const res = await request(app, 'GET', `/api/blogs/${id}`);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.blog.seo_metadata, 'seo_metadata computed and returned');
  assert.ok(typeof res.body.blog.seo_metadata.score === 'number');
});
