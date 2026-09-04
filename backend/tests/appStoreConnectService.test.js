// Tests for services/appStoreConnectService.
//
// Covers:
//   - JWT signing shape (alg, kid, iss, aud, exp bounds)
//   - Apple error surfacing (structured errors[] -> readable message)
//   - Sales TSV parsing (real Apple header layout, product-type filtering)
//   - Sales report REPORT_MISSING (404) → null (not throw)
//   - Sales range walks yesterday-N to yesterday, drops nulls, newest first

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const zlib = require('zlib');

// Silence logger before service loads.
const loggerPath = require.resolve('../src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
};

// Stub axios BEFORE requiring the service. We only stub .get since ASC
// service only reads. Each test overrides responses via setNextResponse.
let nextResponses = [];
function setNextResponses(...responses) { nextResponses = responses; }
let capturedCalls = [];
const axiosStub = {
  get: (url, config) => {
    capturedCalls.push({ url, params: config?.params, headers: config?.headers });
    const next = nextResponses.shift();
    if (!next) throw new Error('no stub response set');
    return Promise.resolve(next);
  },
  // Placeholder — individual tests override this when they need to assert
  // request bodies (e.g. createOngoingReportRequest).
  post: () => Promise.reject(new Error('axios.post not stubbed for this test')),
};
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: axiosStub,
};

const asc = require('../src/services/appStoreConnectService');
const { parseSalesTsv, parseAnalyticsCsv, summarizeAppleError, BASE_URL } = asc._internal;

// Generate a real P-256 EC key pair once so signJwt tests use valid crypto.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = '69a6de70-abcd-1234-5678-000000000000';
const TEST_KEY_ID = 'ABC123XYZ4';

function beforeEach() {
  capturedCalls = [];
  nextResponses = [];
}

// ============================================================================
// signJwt
// ============================================================================

test('signJwt produces a valid ES256 token with correct claims', () => {
  beforeEach();
  const token = asc.signJwt({ issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey });
  const decoded = jwt.verify(token, publicKey, { algorithms: ['ES256'], audience: 'appstoreconnect-v1' });
  assert.equal(decoded.iss, TEST_ISSUER);
  assert.equal(decoded.aud, 'appstoreconnect-v1');
  assert.ok(decoded.exp > decoded.iat);
  const ttl = decoded.exp - decoded.iat;
  // Apple max is 20min = 1200s. We want exactly 1200s.
  assert.equal(ttl, 1200);
});

test('signJwt header includes kid and alg=ES256', () => {
  const token = asc.signJwt({ issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey });
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, TEST_KEY_ID);
  assert.equal(header.typ, 'JWT');
});

test('signJwt throws when any part of the triple is missing', () => {
  assert.throws(() => asc.signJwt({ keyId: 'x', p8: privateKey }), /issuerId/);
  assert.throws(() => asc.signJwt({ issuerId: 'x', p8: privateKey }), /keyId/);
  assert.throws(() => asc.signJwt({ issuerId: 'x', keyId: 'y' }), /p8/);
});

// ============================================================================
// summarizeAppleError
// ============================================================================

test('summarizeAppleError joins title and detail from errors[0]', () => {
  const resp = { data: { errors: [{ title: 'Unauthorized', detail: 'JWT is invalid' }] } };
  assert.equal(summarizeAppleError(resp), 'Unauthorized — JWT is invalid');
});

test('summarizeAppleError falls back to string body', () => {
  const resp = { data: 'plain text error' };
  assert.equal(summarizeAppleError(resp), 'plain text error');
});

test('summarizeAppleError falls back to JSON body when no errors[] array', () => {
  const resp = { data: { message: 'weird body' } };
  assert.equal(summarizeAppleError(resp), '{"message":"weird body"}');
});

// ============================================================================
// listApps
// ============================================================================

test('listApps calls /v1/apps and maps fields', async () => {
  beforeEach();
  setNextResponses({
    status: 200,
    data: {
      data: [
        { id: '111', attributes: { name: 'MyApp', bundleId: 'com.x.myapp', sku: 'SKU1', primaryLocale: 'en-US' } },
        { id: '222', attributes: { name: 'OtherApp', bundleId: 'com.x.other', sku: 'SKU2' } },
      ],
    },
  });
  const apps = await asc.listApps({ issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey });
  assert.equal(apps.length, 2);
  assert.deepEqual(apps[0], {
    id: '111', name: 'MyApp', bundleId: 'com.x.myapp', sku: 'SKU1', primaryLocale: 'en-US',
  });
  assert.equal(apps[1].primaryLocale, null);
  // Check the URL and auth header.
  const call = capturedCalls[0];
  assert.equal(call.url, `${BASE_URL}/v1/apps`);
  assert.ok(String(call.headers.Authorization).startsWith('Bearer '));
});

test('listApps surfaces Apple 401 with readable message', async () => {
  beforeEach();
  setNextResponses({
    status: 401,
    data: { errors: [{ title: 'AUTHENTICATION_ERROR', detail: 'JWT signature invalid' }] },
  });
  await assert.rejects(
    () => asc.listApps({ issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey }),
    err => err.status === 401 && /JWT signature invalid/.test(err.message)
  );
});

// ============================================================================
// getReviews
// ============================================================================

test('getReviews requires appId', async () => {
  beforeEach();
  await assert.rejects(
    () => asc.getReviews({ issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey }, {}),
    /appId required/
  );
});

test('getReviews returns mapped review rows and passes limit/territory as params', async () => {
  beforeEach();
  setNextResponses({
    status: 200,
    data: {
      data: [
        {
          id: 'r1',
          attributes: {
            rating: 5, title: 'Great', body: 'Love it',
            reviewerNickname: 'Alice', createdDate: '2026-08-30T12:00:00Z', territory: 'USA',
          },
        },
        {
          id: 'r2',
          attributes: {
            rating: 1, title: 'Bad', body: null, reviewerNickname: null,
            createdDate: '2026-08-29T10:00:00Z', territory: 'GBR',
          },
        },
      ],
    },
  });
  const rows = await asc.getReviews(
    { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
    { appId: '111', limit: 25, territory: 'USA' }
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rating, 5);
  assert.equal(rows[1].reviewerNickname, null);
  const call = capturedCalls[0];
  assert.equal(call.url, `${BASE_URL}/v1/apps/111/customerReviews`);
  assert.equal(call.params.limit, 25);
  assert.equal(call.params['filter[territory]'], 'USA');
});

test('getReviews clamps limit into [1, 200]', async () => {
  beforeEach();
  setNextResponses({ status: 200, data: { data: [] } });
  await asc.getReviews(
    { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
    { appId: '111', limit: 9999 }
  );
  assert.equal(capturedCalls[0].params.limit, 200);
});

// ============================================================================
// parseSalesTsv (pure function)
// ============================================================================

test('parseSalesTsv extracts units per row and totals', () => {
  const tsv = [
    'Provider\tProvider Country\tSKU\tDeveloper\tTitle\tVersion\tProduct Type Identifier\tUnits\tDeveloper Proceeds\tBegin Date\tEnd Date\tCustomer Currency\tCountry Code\tCurrency of Proceeds\tApple Identifier\tCustomer Price\tPromo Code\tParent Identifier\tSubscription\tPeriod\tCategory\tCMB\tDevice\tSupported Platforms\tProceeds Reason\tPreserved Pricing\tClient\tOrder Type',
    'APPLE\tUS\tsku1\tDev\tMyApp\t1.0\t1\t5\t0\t08/30/2026\t08/30/2026\tUSD\tUS\tUSD\t111\t0\t\t\t\t\t\t\tiPhone\tiOS\t\t\t\t',
    'APPLE\tGB\tsku1\tDev\tMyApp\t1.0\t1\t3\t0\t08/30/2026\t08/30/2026\tGBP\tGB\tGBP\t111\t0\t\t\t\t\t\t\tiPhone\tiOS\t\t\t\t',
    'APPLE\tUS\tsku1\tDev\tMyApp\t1.0\t7\t2\t0\t08/30/2026\t08/30/2026\tUSD\tUS\tUSD\t111\t0\t\t\t\t\t\t\tiPhone\tiOS\t\t\t\t',
  ].join('\n');
  const parsed = parseSalesTsv(tsv, '2026-08-30');
  assert.equal(parsed.reportDate, '2026-08-30');
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.totals.units, 10);
  assert.equal(parsed.rows[0].sku, 'sku1');
  assert.equal(parsed.rows[0].country, 'US');
  assert.equal(parsed.rows[0].productType, '1');
  assert.equal(parsed.rows[0].units, 5);
});

test('parseSalesTsv on empty TSV returns zero totals', () => {
  const parsed = parseSalesTsv('', '2026-08-30');
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.totals.units, 0);
});

// ============================================================================
// getSalesReport — gzip + parse + REPORT_MISSING
// ============================================================================

test('getSalesReport requires vendorNumber and a valid date', async () => {
  beforeEach();
  await assert.rejects(
    () => asc.getSalesReport({ issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey }, { reportDate: '2026-08-30' }),
    /vendorNumber required/
  );
  await assert.rejects(
    () => asc.getSalesReport({ issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey }, { vendorNumber: '888', reportDate: 'yesterday' }),
    /reportDate must be YYYY-MM-DD/
  );
});

test('getSalesReport gunzips the TSV and parses it', async () => {
  beforeEach();
  const tsv = [
    'Provider\tProvider Country\tSKU\tDeveloper\tTitle\tVersion\tProduct Type Identifier\tUnits\tDeveloper Proceeds\tBegin Date\tEnd Date\tCustomer Currency\tCountry Code\tCurrency of Proceeds\tApple Identifier',
    'APPLE\tUS\tsku1\tDev\tMyApp\t1.0\t1\t7\t0\t08/30/2026\t08/30/2026\tUSD\tUS\tUSD\t111',
  ].join('\n');
  const gz = zlib.gzipSync(Buffer.from(tsv, 'utf8'));
  setNextResponses({ status: 200, data: gz });
  const parsed = await asc.getSalesReport(
    { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
    { vendorNumber: '88888888', reportDate: '2026-08-30' }
  );
  assert.equal(parsed.reportDate, '2026-08-30');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].units, 7);
  // Verify correct filter params were passed.
  const call = capturedCalls[0];
  assert.equal(call.params['filter[reportDate]'], '2026-08-30');
  assert.equal(call.params['filter[vendorNumber]'], '88888888');
  assert.equal(call.params['filter[frequency]'], 'DAILY');
});

test('getSalesReport returns null when Apple 404s (REPORT_MISSING)', async () => {
  beforeEach();
  setNextResponses({
    status: 404,
    data: { errors: [{ title: 'NOT_FOUND', detail: 'The requested resource could not be found', code: 'REPORT_MISSING' }] },
  });
  const parsed = await asc.getSalesReport(
    { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
    { vendorNumber: '88888888', reportDate: '2026-08-30' }
  );
  assert.equal(parsed, null);
});

test('getSalesReport re-throws non-404 errors', async () => {
  beforeEach();
  setNextResponses({
    status: 401,
    data: { errors: [{ title: 'AUTH_FAIL', detail: 'bad key' }] },
  });
  await assert.rejects(
    () => asc.getSalesReport(
      { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
      { vendorNumber: '88888888', reportDate: '2026-08-30' }
    ),
    err => err.status === 401
  );
});

// ============================================================================
// getSalesReportRange — walks dates, drops nulls, newest first
// ============================================================================

test('getSalesReportRange fetches N days ending yesterday, newest first, drops missing', async () => {
  beforeEach();
  // Emulate: yesterday exists, day-before exists, day-3 missing.
  const mkGz = (units) => zlib.gzipSync(Buffer.from(
    'Provider\tSKU\tProduct Type Identifier\tUnits\tCountry Code\tApple Identifier\tTitle\tVersion\n' +
    `APPLE\tsku1\t1\t${units}\tUS\t111\tMyApp\t1.0`,
    'utf8'
  ));
  setNextResponses(
    { status: 200, data: mkGz(10) },  // yesterday
    { status: 200, data: mkGz(8) },   // 2 days ago
    { status: 404, data: { errors: [{ title: 'NOT_FOUND', detail: 'missing' }] } }, // 3 days ago
  );
  const range = await asc.getSalesReportRange(
    { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
    { vendorNumber: '88888888', days: 3 }
  );
  // 3 requested, 1 was 404 → 2 reports.
  assert.equal(range.length, 2);
  // Newest first — the report at index 0 is yesterday (units=10).
  assert.equal(range[0].totals.units, 10);
  assert.equal(range[1].totals.units, 8);
  // Dates are descending.
  assert.ok(range[0].reportDate > range[1].reportDate);
});

// ============================================================================
// parseAnalyticsCsv — tab-separated, header + data rows, preserves empty cells
// ============================================================================

test('parseAnalyticsCsv turns a TSV blob into row objects keyed by header', () => {
  const tsv = [
    'Date\tApp Apple Identifier\tSource Type\tCampaign\tImpressions\tProduct Page Views',
    '2026-08-30\t111\tApp Store Search\t\t5000\t120',
    '2026-08-30\t111\tWeb Referrer\tsummer-sale\t800\t150',
  ].join('\n');
  const rows = parseAnalyticsCsv(tsv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['Source Type'], 'App Store Search');
  assert.equal(rows[0]['Campaign'], '');
  assert.equal(rows[0]['Impressions'], '5000');
  assert.equal(rows[1]['Campaign'], 'summer-sale');
});

test('parseAnalyticsCsv returns [] on empty input', () => {
  assert.deepEqual(parseAnalyticsCsv(''), []);
});

test('parseAnalyticsCsv preserves empty trailing cells', () => {
  const tsv = 'A\tB\tC\n1\t\t3';
  const rows = parseAnalyticsCsv(tsv);
  assert.equal(rows[0].A, '1');
  assert.equal(rows[0].B, '');
  assert.equal(rows[0].C, '3');
});

// ============================================================================
// App Analytics Reports API — createOngoingReportRequest, listReports, etc.
// ============================================================================

test('createOngoingReportRequest POSTs with the right envelope + returns request id', async () => {
  beforeEach();
  // Override axios.post for this suite.
  const originalPost = axiosStub.post;
  const postCalls = [];
  axiosStub.post = (url, body, config) => {
    postCalls.push({ url, body, config });
    return Promise.resolve({
      status: 201,
      data: { data: { id: 'req-abc-123', attributes: { stoppedDueToInactivity: false } } },
    });
  };
  try {
    const res = await asc.createOngoingReportRequest(
      { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
      { appId: '111' }
    );
    assert.equal(res.id, 'req-abc-123');
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].body.data.type, 'analyticsReportRequests');
    assert.equal(postCalls[0].body.data.attributes.accessType, 'ONGOING');
    assert.equal(postCalls[0].body.data.relationships.app.data.id, '111');
    assert.ok(String(postCalls[0].config.headers.Authorization).startsWith('Bearer '));
  } finally {
    axiosStub.post = originalPost;
  }
});

test('createOngoingReportRequest 409 → err.isConflict = true', async () => {
  beforeEach();
  const originalPost = axiosStub.post;
  axiosStub.post = () => Promise.resolve({
    status: 409,
    data: { errors: [{ title: 'CONFLICT', detail: 'ONGOING already exists' }] },
  });
  try {
    await assert.rejects(
      () => asc.createOngoingReportRequest(
        { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
        { appId: '111' }
      ),
      err => err.status === 409 && err.isConflict === true
    );
  } finally {
    axiosStub.post = originalPost;
  }
});

test('listReportsInRequest filters by category and maps rows', async () => {
  beforeEach();
  setNextResponses({
    status: 200,
    data: {
      data: [
        { id: 'r1', attributes: { name: 'Engagement Report', category: 'APP_STORE_ENGAGEMENT' } },
        { id: 'r2', attributes: { name: 'Commerce Report', category: 'APP_STORE_COMMERCE' } },
      ],
    },
  });
  const reports = await asc.listReportsInRequest(
    { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
    'req-abc-123',
    { categories: ['APP_STORE_ENGAGEMENT', 'APP_STORE_COMMERCE'] }
  );
  assert.equal(reports.length, 2);
  assert.equal(reports[0].category, 'APP_STORE_ENGAGEMENT');
  const call = capturedCalls[0];
  assert.equal(call.url, `${BASE_URL}/v1/analyticsReportRequests/req-abc-123/reports`);
  assert.equal(call.params['filter[category]'], 'APP_STORE_ENGAGEMENT,APP_STORE_COMMERCE');
});

test('listInstancesForReport requests DAILY granularity by default', async () => {
  beforeEach();
  setNextResponses({
    status: 200,
    data: {
      data: [
        { id: 'inst-1', attributes: { granularity: 'DAILY', processingDate: '2026-08-30' } },
      ],
    },
  });
  const instances = await asc.listInstancesForReport(
    { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
    'report-xyz'
  );
  assert.equal(instances.length, 1);
  assert.equal(instances[0].processingDate, '2026-08-30');
  assert.equal(capturedCalls[0].params['filter[granularity]'], 'DAILY');
});

test('listSegmentsInInstance returns url + size + checksum', async () => {
  beforeEach();
  setNextResponses({
    status: 200,
    data: {
      data: [
        { attributes: { url: 'https://s3.amazonaws.com/segment.gz', sizeInBytes: 12345, checksum: 'abc123' } },
      ],
    },
  });
  const segs = await asc.listSegmentsInInstance(
    { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
    'inst-1'
  );
  assert.equal(segs.length, 1);
  assert.equal(segs[0].url, 'https://s3.amazonaws.com/segment.gz');
  assert.equal(segs[0].sizeInBytes, 12345);
});

test('downloadSegment fetches the URL WITHOUT an Authorization header (pre-signed)', async () => {
  beforeEach();
  const tsv = 'Date\tImpressions\n2026-08-30\t500';
  const gz = zlib.gzipSync(Buffer.from(tsv, 'utf8'));
  setNextResponses({ status: 200, data: gz });
  const rows = await asc.downloadSegment({ url: 'https://s3.amazonaws.com/segment.gz' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Impressions'], '500');
  const call = capturedCalls[0];
  assert.equal(call.url, 'https://s3.amazonaws.com/segment.gz');
  // No Authorization header — the URL is Apple-signed.
  assert.equal(call.headers?.Authorization, undefined);
});

test('getSalesReportRange clamps days into [1, 90]', async () => {
  beforeEach();
  // 999 → clamp to 90 → 90 stubbed 404s so result is [].
  const responses = Array.from({ length: 90 }, () => ({
    status: 404, data: { errors: [{ title: 'NOT_FOUND', detail: 'missing' }] },
  }));
  setNextResponses(...responses);
  const range = await asc.getSalesReportRange(
    { issuerId: TEST_ISSUER, keyId: TEST_KEY_ID, p8: privateKey },
    { vendorNumber: '88888888', days: 999 }
  );
  assert.equal(range.length, 0);
  assert.equal(capturedCalls.length, 90);
});
