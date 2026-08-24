// Route-level tests for backend/src/routes/metaAds.js (Phase 1B).
//
// Strategy:
//   - Stub authMiddleware so we don't need a real JWT
//   - Stub connectionsService helpers (getMetaOwnerToken, getMetaAdAccountSelection,
//     setMetaAdAccountSelection) at the module level via require.cache
//   - Stub metaAdsService methods per-test with a scenario table
//   - Spin up a real Express app and make real HTTP calls
//
// This mirrors the pattern used by tests/reviews-generate-post.test.js.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('node:module');

// --------------------------------------------------------------------------
// Env defaults so services that read env at load time don't crash.
// --------------------------------------------------------------------------
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://example.com';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'svc';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'jwt';
process.env.META_APP_ID = process.env.META_APP_ID || 'test-app';
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'test-secret';

// --------------------------------------------------------------------------
// Stub @supabase/supabase-js — createClient returns a no-op object. The
// route file requires supabase via connectionsService (which we further stub
// below) but any transitive require of @supabase/supabase-js will hit this.
// --------------------------------------------------------------------------
const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === '@supabase/supabase-js') {
    return { createClient: () => ({ from() { return this; } }) };
  }
  return originalRequire.apply(this, arguments);
};

// --------------------------------------------------------------------------
// Stub logger to keep test output clean.
// --------------------------------------------------------------------------
const loggerPath = require.resolve('../src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

// --------------------------------------------------------------------------
// Stub authMiddleware — populate req.user from the current test's user.
// --------------------------------------------------------------------------
let currentUser = { userId: 'user-A', email: 'a@example.com' };
const authMwPath = require.resolve('../src/middleware/authMiddleware');
require.cache[authMwPath] = {
  id: authMwPath, filename: authMwPath, loaded: true,
  exports: function fakeAuth(req, res, next) {
    if (currentUser === null) {
      return res.status(401).json({ error: 'no auth' });
    }
    req.user = { ...currentUser };
    next();
  },
};

// --------------------------------------------------------------------------
// Stub connectionsService — inject just the Meta helpers the route uses.
// The route also require()s the full module (not just destructured methods),
// so we replace the module in the cache before the route loads.
// --------------------------------------------------------------------------
let stubs = {
  getMetaOwnerToken: async () => null,
  getMetaAdAccountSelection: async () => ({ adAccountIds: [], defaultAdAccountId: null }),
  setMetaAdAccountSelection: async () => ({ adAccountIds: [], defaultAdAccountId: null, rowsUpdated: 0 }),
};
const connectionsPath = require.resolve('../src/services/connectionsService');
require.cache[connectionsPath] = {
  id: connectionsPath, filename: connectionsPath, loaded: true,
  exports: {
    // Callers use `connections.getMetaOwnerToken(...)` — proxy through so
    // per-test stub reassignments take effect.
    getMetaOwnerToken: (...args) => stubs.getMetaOwnerToken(...args),
    getMetaAdAccountSelection: (...args) => stubs.getMetaAdAccountSelection(...args),
    setMetaAdAccountSelection: (...args) => stubs.setMetaAdAccountSelection(...args),
  },
};

// --------------------------------------------------------------------------
// Stub metaAdsService — per-test scenario table. Also proxy through so a
// test can update `svcStubs.getCampaigns = ...` between tests.
// --------------------------------------------------------------------------
let svcStubs = {
  listAdAccounts: async () => [],
  describeAdAccount: async () => ({}),
  getCampaigns: async () => [],
  getAdSets: async () => [],
  getAds: async () => [],
  getAdCreatives: async () => [],
  getInsights: async () => ({ rows: [], dateRange: { since: '2026-01-01', until: '2026-01-31' } }),
  getDeliveryIssues: async () => [],
  debugToken: async () => ({
    isValid: true,
    scopes: ['ads_read'],
    hasAdsRead: true,
    hasAdsManagement: false,
    userId: 'meta-user-1',
  }),
};

// We do NOT stub normalizeAdAccountId / normalizeApiError / pickResultForObjective
// — those are pure helpers; use the real implementations.
const svcRealPath = require.resolve('../src/services/metaAdsService');
const realSvc = originalRequire.call(module, svcRealPath);
require.cache[svcRealPath] = {
  id: svcRealPath, filename: svcRealPath, loaded: true,
  exports: {
    // Passthrough helpers
    normalizeAdAccountId: realSvc.normalizeAdAccountId,
    normalizeApiError: realSvc.normalizeApiError,
    pickResultForObjective: realSvc.pickResultForObjective,
    pickResultActionTypes: realSvc.pickResultActionTypes,
    API_VERSION: realSvc.API_VERSION,
    // Stubbed via svcStubs
    listAdAccounts: (...args) => svcStubs.listAdAccounts(...args),
    describeAdAccount: (...args) => svcStubs.describeAdAccount(...args),
    getCampaigns: (...args) => svcStubs.getCampaigns(...args),
    getAdSets: (...args) => svcStubs.getAdSets(...args),
    getAds: (...args) => svcStubs.getAds(...args),
    getAdCreatives: (...args) => svcStubs.getAdCreatives(...args),
    getInsights: (...args) => svcStubs.getInsights(...args),
    getDeliveryIssues: (...args) => svcStubs.getDeliveryIssues(...args),
    debugToken: (...args) => svcStubs.debugToken(...args),
  },
};

// --------------------------------------------------------------------------
// Load the router now that all stubs are in place.
// --------------------------------------------------------------------------
const metaAdsRouter = require('../src/routes/metaAds');
const express = require('express');

// --------------------------------------------------------------------------
// HTTP helper
// --------------------------------------------------------------------------
function makeApp() {
  const app = express();
  app.use('/api/meta-ads', metaAdsRouter);
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
            authorization: 'Bearer fake-jwt',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            let parsed = data;
            try { parsed = JSON.parse(data); } catch {}
            resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed, raw: data });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// --------------------------------------------------------------------------
// Reset all stubs before every test.
// --------------------------------------------------------------------------
function resetStubs() {
  currentUser = { userId: 'user-A', email: 'a@example.com' };
  stubs = {
    getMetaOwnerToken: async () => null,
    getMetaAdAccountSelection: async () => ({ adAccountIds: [], defaultAdAccountId: null }),
    setMetaAdAccountSelection: async () => ({ adAccountIds: [], defaultAdAccountId: null, rowsUpdated: 0 }),
  };
  svcStubs.listAdAccounts = async () => [];
  svcStubs.describeAdAccount = async () => ({});
  svcStubs.getCampaigns = async () => [];
  svcStubs.getAdSets = async () => [];
  svcStubs.getAds = async () => [];
  svcStubs.getAdCreatives = async () => [];
  svcStubs.getInsights = async () => ({ rows: [], dateRange: { since: '2026-01-01', until: '2026-01-31' } });
  svcStubs.getDeliveryIssues = async () => [];
  svcStubs.debugToken = async () => ({
    isValid: true,
    scopes: ['ads_read'],
    hasAdsRead: true,
    hasAdsManagement: false,
    userId: 'meta-user-1',
  });
}

// A synthetic Meta error the service would produce via wrapError.
function makeUpstreamError({ status = 400, code, subcode, message, needsAdsScope, needsReauth }) {
  const err = new Error(message || 'upstream');
  err.status = status;
  err.code = code;
  err.normalized = {
    status,
    code: code ?? null,
    subcode: subcode ?? null,
    message: message || 'upstream',
    needsReauth: !!needsReauth,
    needsAdsScope: !!needsAdsScope,
    fbtraceId: 'trace_z',
  };
  return err;
}

// Assert that no field on `obj` (recursively) contains a token-looking string.
// Loose but effective: catches "EAAG..." Meta tokens + long random hex.
function assertNoToken(obj, ctx = 'response') {
  const seen = new WeakSet();
  function walk(v) {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      // Meta long-lived user tokens start with EAAG or EAAF; system tokens
      // often too. Also flag > 40-char random-looking base64-ish strings.
      if (/^EAA[A-Za-z0-9]{20,}/.test(v)) {
        assert.fail(`${ctx}: contains Meta-looking token: ${v.slice(0, 12)}…`);
      }
      // owner_user_token key name should never appear in a response body.
      if (v === 'owner_user_token' || v === 'page_access_token') {
        assert.fail(`${ctx}: contains sensitive field name literal: ${v}`);
      }
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach(walk);
    for (const [k, val] of Object.entries(v)) {
      if (k === 'owner_user_token' || k === 'page_access_token' || k === 'user_access_token') {
        assert.fail(`${ctx}: contains sensitive field: ${k}`);
      }
      walk(val);
    }
  }
  walk(obj);
}

// ============================================================================
// Tests
// ============================================================================

test('auth required — 401 when no user', async () => {
  resetStubs();
  currentUser = null;
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/accounts');
  assert.equal(r.statusCode, 401);
});

test('_diagnose — META_NOT_CONNECTED when no Meta connection', async () => {
  resetStubs();
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/_diagnose');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.metaConnected, false);
  assert.equal(r.body.code, 'META_NOT_CONNECTED');
  assertNoToken(r.body);
});

test('_diagnose — reports scopes when connected', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_fake_token_xxxxx', metaUserId: '999' });
  svcStubs.debugToken = async () => ({
    isValid: true,
    scopes: ['ads_read', 'pages_show_list'],
    hasAdsRead: true,
    hasAdsManagement: false,
    userId: '999',
    expiresAt: Date.now() + 60_000,
  });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/_diagnose');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.metaConnected, true);
  assert.equal(r.body.hasAdsReadScope, true);
  assert.equal(r.body.hasAdsManagementScope, false);
  assertNoToken(r.body);
});

test('_diagnose — flags missing ads_read', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  svcStubs.debugToken = async () => ({
    isValid: true,
    scopes: ['pages_show_list'],
    hasAdsRead: false,
    hasAdsManagement: false,
    userId: '999',
  });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/_diagnose');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.hasAdsReadScope, false);
  assert.ok(/lacks ads_read/i.test(r.body.guidance));
});

test('GET /accounts — 400 META_NOT_CONNECTED when no Meta', async () => {
  resetStubs();
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/accounts');
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'META_NOT_CONNECTED');
});

test('GET /accounts — 403 META_ADS_SCOPE_REQUIRED when needsAdsScope', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  svcStubs.listAdAccounts = async () => {
    throw makeUpstreamError({ status: 400, code: 100, message: 'Unsupported get request', needsAdsScope: true });
  };
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/accounts');
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.code, 'META_ADS_SCOPE_REQUIRED');
  assert.equal(r.body.needsAdsScope, true);
  assertNoToken(r.body);
});

test('GET /accounts — 401 META_TOKEN_INVALID when needsReauth', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  svcStubs.listAdAccounts = async () => {
    throw makeUpstreamError({ status: 400, code: 190, message: 'Session expired', needsReauth: true });
  };
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/accounts');
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.code, 'META_TOKEN_INVALID');
  assert.equal(r.body.needsReauth, true);
});

test('GET /accounts — META_NO_AD_ACCOUNTS when list is empty', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  svcStubs.listAdAccounts = async () => [];
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/accounts');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.code, 'META_NO_AD_ACCOUNTS');
  assert.deepEqual(r.body.accounts, []);
});

test('GET /accounts — returns accounts + current selection', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.listAdAccounts = async () => [
    { id: 'act_111', name: 'Tampa', currency: 'USD' },
    { id: 'act_222', name: 'Jacksonville', currency: 'USD' },
  ];
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/accounts');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.accounts.length, 2);
  assert.equal(r.body.selection.defaultAdAccountId, 'act_111');
  assertNoToken(r.body);
});

test('POST /accounts — 400 when body missing adAccountIds', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  const app = makeApp();
  const r = await request(app, 'POST', '/api/meta-ads/accounts', {});
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'META_INVALID_AD_ACCOUNT_ID');
});

test('POST /accounts — rejects id not in user\'s accessible list', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  svcStubs.listAdAccounts = async () => [{ id: 'act_111', name: 'Tampa' }];
  const app = makeApp();
  const r = await request(app, 'POST', '/api/meta-ads/accounts', {
    adAccountIds: ['act_999_forgery'],
  });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.code, 'META_AD_ACCOUNT_NOT_AUTHORIZED');
});

test('POST /accounts — 201 and persists selection', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  svcStubs.listAdAccounts = async () => [
    { id: 'act_111', name: 'Tampa' },
    { id: 'act_222', name: 'Jax' },
  ];
  let persistedArg;
  stubs.setMetaAdAccountSelection = async (userId, arg) => {
    persistedArg = arg;
    return { adAccountIds: arg.adAccountIds, defaultAdAccountId: arg.defaultAdAccountId, rowsUpdated: 3 };
  };
  const app = makeApp();
  const r = await request(app, 'POST', '/api/meta-ads/accounts', {
    adAccountIds: ['act_111', 'act_222'],
    defaultAdAccountId: 'act_222',
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.selection.defaultAdAccountId, 'act_222');
  assert.deepEqual(persistedArg.adAccountIds, ['act_111', 'act_222']);
  assert.equal(persistedArg.defaultAdAccountId, 'act_222');
});

test('POST /accounts — normalizes bare numeric to act_<id>', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  svcStubs.listAdAccounts = async () => [{ id: 'act_111', name: 'Tampa' }];
  let captured;
  stubs.setMetaAdAccountSelection = async (userId, arg) => {
    captured = arg;
    return { adAccountIds: arg.adAccountIds, defaultAdAccountId: arg.defaultAdAccountId, rowsUpdated: 1 };
  };
  const app = makeApp();
  const r = await request(app, 'POST', '/api/meta-ads/accounts', {
    adAccountId: '111',
  });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(captured.adAccountIds, ['act_111']);
});

test('GET /connected — returns saved selection without live Meta call', async () => {
  resetStubs();
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  let livesvcCalled = false;
  svcStubs.listAdAccounts = async () => { livesvcCalled = true; return []; };
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/connected');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.selection.defaultAdAccountId, 'act_111');
  assert.equal(livesvcCalled, false);
});

// --------------------------------------------------------------------------
// Resolver behavior — via /overview (a section endpoint)
// --------------------------------------------------------------------------

test('resolver — META_NO_SELECTION when user hasn\'t picked yet', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/overview?adAccountId=act_111');
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'META_NO_SELECTION');
});

test('resolver — META_AD_ACCOUNT_NOT_AUTHORIZED when act_id not in saved selection', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  const app = makeApp();
  // Well-formed id (passes normalization) but not in the user's saved list.
  const r = await request(app, 'GET', '/api/meta-ads/overview?adAccountId=act_9999999999');
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.code, 'META_AD_ACCOUNT_NOT_AUTHORIZED');
});

test('resolver — META_INVALID_AD_ACCOUNT_ID on malformed id', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/overview?adAccountId=act_forgery');
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'META_INVALID_AD_ACCOUNT_ID');
});

test('resolver — resolves to default when no adAccountId supplied', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getCampaigns = async () => [];
  svcStubs.getInsights = async () => ({ rows: [], dateRange: { since: '2026-01-01', until: '2026-01-31' } });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/overview');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.adAccountId, 'act_111');
});

// --------------------------------------------------------------------------
// Overview — result grouping by objective
// --------------------------------------------------------------------------

test('GET /overview — single-objective account populates top-level results', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getCampaigns = async () => [
    { id: 'c1', name: 'Camp1', objective: 'OUTCOME_LEADS' },
    { id: 'c2', name: 'Camp2', objective: 'OUTCOME_LEADS' },
  ];
  svcStubs.getInsights = async () => ({
    rows: [
      realSvc.normalizeInsightsRow({
        campaign_id: 'c1',
        spend: '100',
        impressions: '1000',
        clicks: '20',
        reach: '800',
        frequency: '1.25',
        actions: [{ action_type: 'lead', value: '5' }],
      }),
      realSvc.normalizeInsightsRow({
        campaign_id: 'c2',
        spend: '50',
        impressions: '500',
        clicks: '10',
        reach: '400',
        frequency: '1.25',
        actions: [{ action_type: 'lead', value: '3' }],
      }),
    ],
    dateRange: { since: '2026-01-01', until: '2026-01-31' },
  });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/overview');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.totals.spend, 150);
  assert.equal(r.body.totals.impressions, 1500);
  assert.equal(r.body.results.value, 8);
  assert.equal(r.body.results.actionType, 'lead');
  assert.equal(r.body.resultsByObjective.length, 1);
});

test('GET /overview — mixed-objective account leaves top-level results null', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getCampaigns = async () => [
    { id: 'c1', objective: 'OUTCOME_LEADS' },
    { id: 'c2', objective: 'OUTCOME_SALES' },
  ];
  svcStubs.getInsights = async () => ({
    rows: [
      realSvc.normalizeInsightsRow({
        campaign_id: 'c1', spend: '100', impressions: '1000', clicks: '20',
        actions: [{ action_type: 'lead', value: '5' }],
      }),
      realSvc.normalizeInsightsRow({
        campaign_id: 'c2', spend: '200', impressions: '2000', clicks: '30',
        actions: [{ action_type: 'purchase', value: '4' }],
      }),
    ],
    dateRange: { since: '2026-01-01', until: '2026-01-31' },
  });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/overview');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.results.value, null);
  assert.equal(r.body.results.actionType, null);
  assert.equal(r.body.resultsByObjective.length, 2);
  const leadBucket = r.body.resultsByObjective.find((b) => b.actionType === 'lead');
  const purchaseBucket = r.body.resultsByObjective.find((b) => b.actionType === 'purchase');
  assert.equal(leadBucket.results, 5);
  assert.equal(purchaseBucket.results, 4);
});

// --------------------------------------------------------------------------
// Section endpoints
// --------------------------------------------------------------------------

test('GET /campaigns — joins entity rows with insights', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getCampaigns = async () => [{ id: 'c1', name: 'X', objective: 'OUTCOME_LEADS' }];
  svcStubs.getInsights = async () => ({
    rows: [realSvc.normalizeInsightsRow({
      campaign_id: 'c1', spend: '100', clicks: '10',
      actions: [{ action_type: 'lead', value: '2' }],
    })],
    dateRange: { since: '2026-01-01', until: '2026-01-31' },
  });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/campaigns');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.campaigns.length, 1);
  assert.equal(r.body.campaigns[0].insights.spend, 100);
  assert.equal(r.body.campaigns[0].derivedResults.results, 2);
});

test('GET /adsets — joins entity rows with insights + parent objective', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getCampaigns = async () => [{ id: 'c1', objective: 'OUTCOME_LEADS' }];
  svcStubs.getAdSets = async () => [{ id: 'as1', campaignId: 'c1', name: 'Set1' }];
  svcStubs.getInsights = async () => ({
    rows: [realSvc.normalizeInsightsRow({
      adset_id: 'as1', spend: '75',
      actions: [{ action_type: 'lead', value: '3' }],
    })],
    dateRange: { since: '2026-01-01', until: '2026-01-31' },
  });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/adsets');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.adsets.length, 1);
  assert.equal(r.body.adsets[0].insights.spend, 75);
  assert.equal(r.body.adsets[0].derivedResults.results, 3); // via parent objective
});

test('GET /ads — capped at MAX_ADS_DAYS', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/ads?days=180');
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'META_INVALID_DAY_RANGE');
});

test('GET /ads — accepts 90-day range', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getCampaigns = async () => [];
  svcStubs.getAds = async () => [{ id: 'a1', name: 'Ad1' }];
  svcStubs.getInsights = async () => ({ rows: [], dateRange: { since: '2026-01-01', until: '2026-01-31' } });
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/ads?days=90');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ads.length, 1);
});

// --------------------------------------------------------------------------
// Breakdown endpoints
// --------------------------------------------------------------------------

test('GET /placements — requests publisher_platform + platform_position breakdowns', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  let capturedBreakdowns;
  svcStubs.getInsights = async (args) => {
    capturedBreakdowns = args.breakdowns;
    return { rows: [], dateRange: { since: '2026-01-01', until: '2026-01-31' } };
  };
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/placements');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(capturedBreakdowns, ['publisher_platform', 'platform_position']);
});

test('GET /devices — requests device_platform breakdown', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  let capturedBreakdowns;
  svcStubs.getInsights = async (args) => {
    capturedBreakdowns = args.breakdowns;
    return { rows: [], dateRange: { since: '2026-01-01', until: '2026-01-31' } };
  };
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/devices');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(capturedBreakdowns, ['device_platform']);
});

test('GET /demographics — requests age + gender breakdowns', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  let capturedBreakdowns;
  svcStubs.getInsights = async (args) => {
    capturedBreakdowns = args.breakdowns;
    return { rows: [], dateRange: { since: '2026-01-01', until: '2026-01-31' } };
  };
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/demographics');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(capturedBreakdowns, ['age', 'gender']);
});

test('GET /day-hour — requests hourly_stats_aggregated_by_advertiser_time_zone', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  let capturedBreakdowns;
  svcStubs.getInsights = async (args) => {
    capturedBreakdowns = args.breakdowns;
    return { rows: [], dateRange: { since: '2026-01-01', until: '2026-01-31' } };
  };
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/day-hour');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(capturedBreakdowns, ['hourly_stats_aggregated_by_advertiser_time_zone']);
});

test('GET /creatives — returns list', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getAdCreatives = async () => [{ id: 'cr1', name: 'Hero' }];
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/creatives');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.creatives.length, 1);
});

test('GET /delivery-issues — returns aggregated issues', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getDeliveryIssues = async () => [
    { entityType: 'campaign', entityId: 'c1', issue: { error_message: 'X' } },
  ];
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/delivery-issues');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.issues.length, 1);
});

// --------------------------------------------------------------------------
// Meta upstream errors — end-to-end propagation
// --------------------------------------------------------------------------

test('Meta upstream 429 → META_RATE_LIMITED', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getCampaigns = async () => {
    throw makeUpstreamError({ status: 429, code: 17, message: 'App rate limit reached' });
  };
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/campaigns');
  assert.equal(r.statusCode, 429);
  assert.equal(r.body.code, 'META_RATE_LIMITED');
});

test('Meta upstream unknown → META_UPSTREAM_ERROR with fbtraceId', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_test', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.getCampaigns = async () => {
    throw makeUpstreamError({ status: 500, code: 2, message: 'Temporary Meta issue' });
  };
  const app = makeApp();
  const r = await request(app, 'GET', '/api/meta-ads/campaigns');
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.code, 'META_UPSTREAM_ERROR');
  assert.equal(r.body.fbtraceId, 'trace_z');
  assertNoToken(r.body);
});

// --------------------------------------------------------------------------
// Sensitive-field leak sanity check across every endpoint
// --------------------------------------------------------------------------

test('no endpoint leaks access token or sensitive metadata keys', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'EAAG_supersecret_token', metaUserId: '999' });
  stubs.getMetaAdAccountSelection = async () => ({
    adAccountIds: ['act_111'],
    defaultAdAccountId: 'act_111',
  });
  svcStubs.listAdAccounts = async () => [{ id: 'act_111', name: 'Tampa' }];
  svcStubs.getCampaigns = async () => [{ id: 'c1', objective: 'OUTCOME_LEADS' }];
  svcStubs.getAdSets = async () => [{ id: 'as1', campaignId: 'c1' }];
  svcStubs.getAds = async () => [{ id: 'a1' }];
  svcStubs.getAdCreatives = async () => [{ id: 'cr1' }];
  svcStubs.getDeliveryIssues = async () => [];
  svcStubs.getInsights = async () => ({ rows: [], dateRange: { since: '2026-01-01', until: '2026-01-31' } });

  const app = makeApp();
  const paths = [
    '/api/meta-ads/_diagnose',
    '/api/meta-ads/accounts',
    '/api/meta-ads/connected',
    '/api/meta-ads/overview',
    '/api/meta-ads/campaigns',
    '/api/meta-ads/adsets',
    '/api/meta-ads/ads?days=30',
    '/api/meta-ads/placements',
    '/api/meta-ads/devices',
    '/api/meta-ads/demographics',
    '/api/meta-ads/day-hour',
    '/api/meta-ads/creatives',
    '/api/meta-ads/delivery-issues',
  ];
  for (const p of paths) {
    const r = await request(app, 'GET', p);
    assertNoToken(r.body, `body of ${p}`);
    assert.equal(r.statusCode < 500, true, `${p} returned ${r.statusCode}: ${r.raw}`);
  }
});
