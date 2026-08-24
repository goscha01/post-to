// Tests for POST /api/campaign-assistant/meta-review-context (Phase 1E).
//
// Covers §13 scenarios:
//   - deep-link issue resolution ok
//   - arbitrary issue ID rejected/not found
//   - issue from another Meta account rejected (issueId not in current report)
//   - Meta not connected rejected
//   - non-Meta issueId (e.g. Google-only) rejected at boundary

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('node:module');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://example.com';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'svc';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'jwt';
process.env.META_APP_ID = process.env.META_APP_ID || 'app';
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'sec';

// Silence logger.
const loggerPath = require.resolve('../src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

// Stub supabase-js — the route imports it but only for other endpoints.
require.cache[require.resolve('@supabase/supabase-js')] = {
  id: require.resolve('@supabase/supabase-js'),
  filename: require.resolve('@supabase/supabase-js'),
  loaded: true,
  exports: { createClient: () => ({ from() { return this; } }) },
};

// Stub auth middleware — inject req.user.
let currentUser = { userId: 'user-A' };
const authMwPath = require.resolve('../src/middleware/authMiddleware');
require.cache[authMwPath] = {
  id: authMwPath, filename: authMwPath, loaded: true,
  exports: (req, _res, next) => { req.user = { ...currentUser }; next(); },
};

// Stub business auth middleware — just pass through.
const bizAuthPath = require.resolve('../src/middleware/businessAuth');
require.cache[bizAuthPath] = {
  id: bizAuthPath, filename: bizAuthPath, loaded: true,
  exports: (req, _res, next) => { req.businessToken = 'biz-tok'; next(); },
};

// Stub connectionsService.
let stubs = {
  getMetaOwnerToken: async () => null,
  getMetaAdAccountSelection: async () => ({ adAccountIds: [], defaultAdAccountId: null }),
};
require.cache[require.resolve('../src/services/connectionsService')] = {
  id: require.resolve('../src/services/connectionsService'),
  filename: require.resolve('../src/services/connectionsService'),
  loaded: true,
  exports: {
    getMetaOwnerToken: (...a) => stubs.getMetaOwnerToken(...a),
    getMetaAdAccountSelection: (...a) => stubs.getMetaAdAccountSelection(...a),
  },
};

// Stub optimizationReportService.
let reportStub = null;
require.cache[require.resolve('../src/services/optimizationReportService')] = {
  id: require.resolve('../src/services/optimizationReportService'),
  filename: require.resolve('../src/services/optimizationReportService'),
  loaded: true,
  exports: {
    generateReport: async () => reportStub,
    _internal: {},
  },
};

// Stub campaign-assistant service (route only uses INITIAL_ANALYSIS_PROMPT).
require.cache[require.resolve('../src/services/campaignAssistantService')] = {
  id: require.resolve('../src/services/campaignAssistantService'),
  filename: require.resolve('../src/services/campaignAssistantService'),
  loaded: true,
  exports: {
    INITIAL_ANALYSIS_PROMPT: 'analyze this',
  },
};

// Stub other services the route imports but this test doesn't hit.
require.cache[require.resolve('../src/services/campaignMonitorService')] = {
  id: require.resolve('../src/services/campaignMonitorService'),
  filename: require.resolve('../src/services/campaignMonitorService'),
  loaded: true, exports: { safeParseMonitorSpec: () => null },
};
require.cache[require.resolve('../src/services/openAiAdsService')] = {
  id: require.resolve('../src/services/openAiAdsService'),
  filename: require.resolve('../src/services/openAiAdsService'),
  loaded: true, exports: {},
};
require.cache[require.resolve('../src/utils/businessTokens')] = {
  id: require.resolve('../src/utils/businessTokens'),
  filename: require.resolve('../src/utils/businessTokens'),
  loaded: true, exports: { getAllBusinessTokens: async () => [] },
};

const router = require('../src/routes/campaignAssistant');
const express = require('express');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/campaign-assistant', router);
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer x' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            let parsed = data;
            try { parsed = JSON.parse(data); } catch {}
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

function resetStubs() {
  currentUser = { userId: 'user-A' };
  stubs.getMetaOwnerToken = async () => null;
  stubs.getMetaAdAccountSelection = async () => ({ adAccountIds: [], defaultAdAccountId: null });
  reportStub = null;
}

// ============================================================================

test('meta-review-context: requires issueId in body', async () => {
  resetStubs();
  const app = makeApp();
  const r = await request(app, 'POST', '/api/campaign-assistant/meta-review-context', {});
  assert.equal(r.statusCode, 400);
  assert.ok(/issueId required/i.test(r.body.error));
});

test('meta-review-context: rejects non-Meta issueId at the boundary', async () => {
  resetStubs();
  const app = makeApp();
  const r = await request(app, 'POST', '/api/campaign-assistant/meta-review-context', { issueId: 'google_ads:something' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'META_ISSUE_ID_REQUIRED');
});

test('meta-review-context: rejects when Meta not connected', async () => {
  resetStubs();
  const app = makeApp();
  const r = await request(app, 'POST', '/api/campaign-assistant/meta-review-context', { issueId: 'meta:xyz' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'META_NOT_CONNECTED');
});

test('meta-review-context: rejects when no Meta ad account selected', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'tok', metaUserId: 'u1' });
  const app = makeApp();
  const r = await request(app, 'POST', '/api/campaign-assistant/meta-review-context', { issueId: 'meta:xyz' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, 'META_NO_SELECTION');
});

test('meta-review-context: returns 404 for an issueId not present in current report', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'tok', metaUserId: 'u1' });
  stubs.getMetaAdAccountSelection = async () => ({ adAccountIds: ['act_1'], defaultAdAccountId: 'act_1' });
  reportStub = {
    alertsByProvider: [
      { provider: 'meta_ads', id: 'meta:different_issue', title: 'Other', source: 'meta', entityIds: ['x'], entityType: 'ad' },
    ],
    metaAds: { account: { adAccountId: 'act_1' }, campaigns: [] },
    crossReference: { metaAttribution: { quality: 'channel' } },
  };
  const app = makeApp();
  const r = await request(app, 'POST', '/api/campaign-assistant/meta-review-context', { issueId: 'meta:never_seen' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.code, 'META_ISSUE_NOT_FOUND');
});

test('meta-review-context: happy path returns issue + prompt + attribution quality', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'tok', metaUserId: 'u1' });
  stubs.getMetaAdAccountSelection = async () => ({ adAccountIds: ['act_1'], defaultAdAccountId: 'act_1' });
  reportStub = {
    alertsByProvider: [
      { provider: 'meta_ads', id: 'meta:issue:xyz', severity: 'high', type: 'meta_delivery_issue',
        title: 'Payment invalid', guidance: 'add a card', entityType: 'ad', entityIds: ['ad1'], source: 'meta',
        metrics: { errorCode: 1487220 } },
    ],
    metaAds: {
      account: { adAccountId: 'act_1', name: 'Tampa', currency: 'USD' },
      campaigns: [{ campaignId: 'c1', name: 'Test', objective: 'OUTCOME_SALES', status: 'ACTIVE', spend: 10, results: null, resultActionType: null }],
    },
    crossReference: { metaAttribution: { quality: 'channel' } },
  };
  const app = makeApp();
  const r = await request(app, 'POST', '/api/campaign-assistant/meta-review-context', { issueId: 'meta:issue:xyz' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.issue.id, 'meta:issue:xyz');
  assert.equal(r.body.issue.source, 'meta');
  assert.equal(r.body.attribution.quality, 'channel');
  assert.ok(/Meta reported this directly/i.test(r.body.suggestedPrompt));
  assert.ok(/channel/i.test(r.body.suggestedPrompt));
});

test('meta-review-context: computed issues produce different prompt language than meta-source', async () => {
  resetStubs();
  stubs.getMetaOwnerToken = async () => ({ accessToken: 'tok', metaUserId: 'u1' });
  stubs.getMetaAdAccountSelection = async () => ({ adAccountIds: ['act_1'], defaultAdAccountId: 'act_1' });
  reportStub = {
    alertsByProvider: [
      { provider: 'meta_ads', id: 'meta:hf:1', severity: 'medium', type: 'high_frequency',
        title: 'Frequency 5x', guidance: 'refresh', entityType: 'ad', entityIds: ['ad1'], source: 'computed' },
    ],
    metaAds: { account: {}, campaigns: [] },
    crossReference: { metaAttribution: { quality: 'none' } },
  };
  const app = makeApp();
  const r = await request(app, 'POST', '/api/campaign-assistant/meta-review-context', { issueId: 'meta:hf:1' });
  assert.equal(r.statusCode, 200);
  assert.ok(/Post-To detected this from empirical metrics/i.test(r.body.suggestedPrompt));
});

// ============================================================================
// Regression: existing Google Ads Apply route still works
// ============================================================================

test('regression: the mutation dispatcher has zero Meta cases', async () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/routes/campaignAssistant.js'), 'utf8');
  // Route has a big switch on step.action_type. Verify no meta_ads_action /
  // pause_meta_ad / set_meta_adset_budget etc appears as a case label.
  const forbidden = ['meta_ads_action', 'pause_meta_ad', 'pause_meta_adset', 'pause_meta_campaign', 'set_meta_adset_budget', 'boost_post', 'set_meta_campaign_budget'];
  for (const w of forbidden) {
    const casePattern = new RegExp(`case\\s+['"]${w}['"]`, 'i');
    assert.ok(!casePattern.test(src), `mutation dispatcher must NOT have a case for "${w}"`);
  }
});
