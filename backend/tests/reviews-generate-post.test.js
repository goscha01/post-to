// Tests for POST /api/reviews/:reviewId/generate-post
//
// Covers:
//   1. User with revoked/expired GMB token can still generate a post from an owned review.
//      (requireBusinessAuth must NOT be in this route's middleware stack.)
//   2. User cannot generate a post from another user's review (returns 404).
//   3. Missing review returns 404.
//   4. Generated post has correct user_id and source_id linking back to the review.
//
// Plus a sanity check that GMB-API-calling routes DO still have requireBusinessAuth.
//
// Run: npm test  (from backend/)
//
// Implementation notes:
//   - We hook `Module.prototype.require` to swap `@supabase/supabase-js` with a
//     controllable fake BEFORE loading the routes.
//   - We stub authMiddleware (no real JWT verification) and aiContentService
//     (no real OpenAI call) by overwriting `require.cache` and the exported
//     function, respectively.
//   - A real express app + http.Server is spun up for each test so the full
//     middleware chain runs, not just the handler.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('node:module');

// --------------------------------------------------------------------------
// 1. Configurable fake supabase client.
// --------------------------------------------------------------------------
// Per-test config sets handlers for table+operation pairs. Each handler is
// called when a chain is awaited (or .single() is called) and returns the
// supabase-shaped { data, error, count } envelope.
//
//   tableConfig.gmb_reviews.single = ({ eqs }) => ({ data, error })
//   tableConfig.ai_jobs.insert     = ({ payload }) => ({ data, error })
//   ...etc.

let tableConfig = {};
const insertedRows = { ai_jobs: [], ai_generated_posts: [], blog_articles: [] };
const updatedRows = { ai_jobs: [] };

function resetState() {
  tableConfig = {};
  insertedRows.ai_jobs = [];
  insertedRows.ai_generated_posts = [];
  insertedRows.blog_articles = [];
  updatedRows.ai_jobs = [];
}

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.payload = null;
    this.eqs = {};
    this.isCountHead = false;
  }
  select(_cols, opts) {
    if (opts && opts.head) {
      this.isCountHead = true;
      // op stays as 'select' for read-only paths, but for count-head we use 'count'
      this.op = 'count';
    }
    return this;
  }
  insert(payload) {
    this.op = 'insert';
    this.payload = payload;
    if (insertedRows[this.table]) insertedRows[this.table].push(payload);
    return this;
  }
  update(payload) {
    this.op = 'update';
    this.payload = payload;
    if (updatedRows[this.table]) updatedRows[this.table].push(payload);
    return this;
  }
  eq(col, val) { this.eqs[col] = val; return this; }
  in(_col, _vals) { return this; }
  gte(_col, _val) { return this; }
  order() { return this; }

  async single() {
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    const handlers = tableConfig[this.table] || {};
    const fn = handlers[this.op];
    if (typeof fn === 'function') {
      return fn(this);
    }
    // Sensible defaults so unconfigured table reads don't blow up the chain.
    if (this.op === 'insert' || this.op === 'update') {
      return { data: { id: 'fake-id', ...this.payload }, error: null };
    }
    if (this.op === 'count') return { count: 0, error: null };
    return { data: null, error: null, count: 0 };
  }
}

const fakeSupabaseClient = {
  from(table) {
    return new FakeQuery(table);
  }
};

// --------------------------------------------------------------------------
// 2. Inject the fake @supabase/supabase-js BEFORE anything else loads it.
// --------------------------------------------------------------------------
const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === '@supabase/supabase-js') {
    return { createClient: () => fakeSupabaseClient };
  }
  return originalRequire.apply(this, arguments);
};

process.env.SUPABASE_URL = 'http://example.com';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.JWT_SECRET = 'jwt';
process.env.OPENAI_API_KEY = 'sk-test';

// --------------------------------------------------------------------------
// 3. Stub authMiddleware so we don't need a real JWT. `currentUser` is mutable
//    per-test.
// --------------------------------------------------------------------------
let currentUser = { userId: 'user-A', email: 'a@example.com' };

const authMwPath = require.resolve('../src/middleware/authMiddleware');
require.cache[authMwPath] = {
  id: authMwPath,
  filename: authMwPath,
  loaded: true,
  exports: function fakeAuth(req, _res, next) {
    req.user = { ...currentUser };
    next();
  }
};

// --------------------------------------------------------------------------
// 4. Load aiContentService and stub `generateReviewPost`. We swap the
//    exported function so the route's `require(...)` (which was already
//    resolved once when the route module loads) picks up the stub.
// --------------------------------------------------------------------------
const aiContentService = require('../src/services/aiContentService');
const stubAiOutput = {
  data: {
    caption: 'Thank you for the kind words!',
    shortCaption: 'Thanks!',
    googleBusinessPost: 'GMB post body here.',
    hashtags: ['#cleaning', '#tampa']
  },
  raw: '{}',
  prompt: 'stubbed-prompt',
  model: 'gpt-test',
  usage: { prompt_tokens: 50, completion_tokens: 80, total_tokens: 130 },
  costUsd: 0.0002
};
aiContentService.generateReviewPost = async () => stubAiOutput;
aiContentService.generateArticle = async () => ({
  data: {
    title: 'Test Title',
    slug: 'test-slug',
    metaDescription: 'meta',
    markdown: '# body',
    suggestedExcerpt: 'ex',
    suggestedSocialPost: 'soc'
  },
  raw: '{}',
  prompt: 'p',
  model: 'gpt-test',
  usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  costUsd: 0.0003
});

// --------------------------------------------------------------------------
// 5. Load the routes now that all mocks are in place.
// --------------------------------------------------------------------------
const reviewsRouter = require('../src/routes/reviews');
const aiRouter = require('../src/routes/ai');
const businessAuth = require('../src/middleware/businessAuth');

// --------------------------------------------------------------------------
// 6. Test helpers: spin up an ephemeral express app and make a real HTTP
//    request through it. This exercises the full middleware chain.
// --------------------------------------------------------------------------
const express = require('express');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/reviews', reviewsRouter);
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
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            authorization: 'Bearer fake-jwt'
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            let parsed = data;
            try { parsed = JSON.parse(data); } catch (_) { /* leave as string */ }
            resolve({ statusCode: res.statusCode, body: parsed });
          });
        }
      );
      req.on('error', (e) => {
        server.close();
        reject(e);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function findRouteLayer(router, method, path) {
  return router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
  );
}

// ==========================================================================
// Structural tests
// ==========================================================================

test('generate-post route does NOT include requireBusinessAuth in its stack', () => {
  const layer = findRouteLayer(reviewsRouter, 'POST', '/:reviewId/generate-post');
  assert.ok(layer, 'POST /:reviewId/generate-post should be registered');
  const handlers = layer.route.stack.map((s) => s.handle);
  assert.ok(
    !handlers.includes(businessAuth),
    'requireBusinessAuth must NOT be in the generate-post route stack'
  );
});

test('GMB-API-calling routes DO include requireBusinessAuth', () => {
  const gmbRoutes = [
    ['GET', '/accounts/:accountId/locations/:locationId/reviews'],
    ['GET', '/accounts/:accountId/locations/:locationId/reviews/:reviewId'],
    ['POST', '/accounts/:accountId/locations/batchGetReviews'],
    ['PUT', '/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply'],
    ['DELETE', '/accounts/:accountId/locations/:locationId/reviews/:reviewId/reply']
  ];
  for (const [method, path] of gmbRoutes) {
    const layer = findRouteLayer(reviewsRouter, method, path);
    assert.ok(layer, `${method} ${path} should be registered`);
    const handlers = layer.route.stack.map((s) => s.handle);
    assert.ok(
      handlers.includes(businessAuth),
      `requireBusinessAuth must be in the stack for ${method} ${path}`
    );
  }
});

// ==========================================================================
// Behavioral tests
// ==========================================================================

test('1. user with revoked GMB token can generate a post from an owned review', async () => {
  resetState();
  currentUser = { userId: 'user-A', email: 'a@example.com' };

  // Simulate revoked GMB token by making businessAuth always return 403 if
  // called. The point of this test is that it should NEVER be called.
  const businessAuthPath = require.resolve('../src/middleware/businessAuth');
  const originalBusinessAuthExport = require.cache[businessAuthPath].exports;
  let businessAuthInvoked = false;
  require.cache[businessAuthPath].exports = function fakeRevokedBusinessAuth(req, res, _next) {
    businessAuthInvoked = true;
    return res.status(403).json({ error: 'business auth expired', needsBusinessAuth: true });
  };

  // The owned review (user_id matches the caller).
  const ownedReview = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    user_id: 'user-A',
    location_id: 'loc-1',
    review_id: 'gmb-review-123',
    reviewer_name: 'Jamie',
    star_rating: 5,
    comment: 'Amazing work!'
  };
  tableConfig.gmb_reviews = {
    select: ({ eqs }) => {
      // Lookup by id (UUID) or by review_id; only return when user_id matches.
      if (eqs.user_id !== 'user-A') return { data: null, error: { code: 'PGRST116' } };
      if (eqs.id === ownedReview.id) return { data: ownedReview, error: null };
      if (eqs.review_id === ownedReview.id) return { data: null, error: { code: 'PGRST116' } };
      return { data: null, error: { code: 'PGRST116' } };
    }
  };
  tableConfig.ai_jobs = {
    insert: ({ payload }) => ({ data: { id: 'job-1', ...payload }, error: null }),
    update: () => ({ data: null, error: null }),
    count: () => ({ count: 0, error: null })
  };
  tableConfig.ai_generated_posts = {
    insert: ({ payload }) => ({ data: { id: 'post-1', ...payload }, error: null })
  };
  tableConfig.gmb_locations = { select: () => ({ data: null, error: null }) };

  const app = makeApp();
  const res = await request(app, 'POST', `/api/reviews/${ownedReview.id}/generate-post`, {});

  // Restore.
  require.cache[businessAuthPath].exports = originalBusinessAuthExport;

  assert.strictEqual(businessAuthInvoked, false, 'requireBusinessAuth must not run for this route');
  assert.strictEqual(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.id, 'response should include the new draft id');
  assert.strictEqual(res.body.status, 'draft');
});

test('2. user cannot generate a post from another user\'s review (returns 404)', async () => {
  resetState();
  currentUser = { userId: 'user-A', email: 'a@example.com' };

  // Review belongs to user-B.
  const otherReview = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    user_id: 'user-B',
    location_id: 'loc-2',
    review_id: 'gmb-review-999',
    comment: 'private'
  };
  tableConfig.gmb_reviews = {
    select: ({ eqs }) => {
      // Only return the row if user_id matches the caller. Since caller is
      // user-A and review belongs to user-B, every lookup returns null.
      if (eqs.user_id === otherReview.user_id) {
        return { data: otherReview, error: null };
      }
      return { data: null, error: { code: 'PGRST116' } };
    }
  };

  const app = makeApp();
  const res = await request(app, 'POST', `/api/reviews/${otherReview.id}/generate-post`, {});
  assert.strictEqual(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.error, 'Review not found');

  // And no draft was inserted.
  assert.strictEqual(insertedRows.ai_generated_posts.length, 0, 'should not insert a draft');
});

test('3. missing review returns 404', async () => {
  resetState();
  currentUser = { userId: 'user-A', email: 'a@example.com' };

  tableConfig.gmb_reviews = {
    select: () => ({ data: null, error: { code: 'PGRST116' } })
  };

  const app = makeApp();
  const res = await request(app, 'POST', '/api/reviews/does-not-exist-123/generate-post', {});
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.error, 'Review not found');
  assert.strictEqual(insertedRows.ai_generated_posts.length, 0);
});

test('4. generated post is linked to the correct user_id and review_id', async () => {
  resetState();
  currentUser = { userId: 'user-A', email: 'a@example.com' };

  const ownedReview = {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    user_id: 'user-A',
    location_id: 'loc-3',
    review_id: 'gmb-review-555',
    reviewer_name: 'Alex',
    star_rating: 4,
    comment: 'Great job overall.'
  };
  tableConfig.gmb_reviews = {
    select: ({ eqs }) => {
      if (eqs.user_id !== 'user-A') return { data: null, error: { code: 'PGRST116' } };
      if (eqs.id === ownedReview.id) return { data: ownedReview, error: null };
      return { data: null, error: { code: 'PGRST116' } };
    }
  };
  tableConfig.ai_jobs = {
    insert: ({ payload }) => ({ data: { id: 'job-X', ...payload }, error: null }),
    update: () => ({ data: null, error: null }),
    count: () => ({ count: 0, error: null })
  };
  tableConfig.ai_generated_posts = {
    insert: ({ payload }) => ({ data: { id: 'post-X', ...payload }, error: null })
  };
  tableConfig.gmb_locations = { select: () => ({ data: null, error: null }) };

  const app = makeApp();
  const res = await request(app, 'POST', `/api/reviews/${ownedReview.id}/generate-post`, {});
  assert.strictEqual(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);

  assert.strictEqual(insertedRows.ai_generated_posts.length, 1);
  const insertedPost = insertedRows.ai_generated_posts[0];
  assert.strictEqual(insertedPost.user_id, 'user-A', 'draft.user_id must match caller');
  assert.strictEqual(insertedPost.source_type, 'review');
  assert.strictEqual(insertedPost.source_id, ownedReview.id, 'draft.source_id must point back to the review');
  assert.strictEqual(insertedPost.platform_target, 'gmb');
  assert.strictEqual(insertedPost.status, 'draft');

  // And the ai_jobs row got created with the right kind & user.
  assert.strictEqual(insertedRows.ai_jobs.length, 1);
  assert.strictEqual(insertedRows.ai_jobs[0].user_id, 'user-A');
  assert.strictEqual(insertedRows.ai_jobs[0].kind, 'review_post_generation');
});
