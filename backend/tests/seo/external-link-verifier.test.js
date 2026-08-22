// External link verifier — unit tests.
//
// Mocks the network (axios) and DNS so we can test every branch without
// depending on live EPA/CDC/Wikipedia availability. The verifier's public
// surface is verifyOne / verifyMany; the SSRF-related helpers are exercised
// via the _internal export.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// Fake axios
// ---------------------------------------------------------------------------
//
// per-URL response map: { [url]: { GET: {status, headers, data?}, HEAD: {…} } }
// Special sentinel: value === 'timeout' → axios throws { code: 'ECONNABORTED' }
const routes = {};
function resetRoutes() { for (const k of Object.keys(routes)) delete routes[k]; }

function fakeAxios(configOrUrl, maybeConfig) {
  const cfg = typeof configOrUrl === 'string' ? { url: configOrUrl, ...maybeConfig } : configOrUrl;
  const method = (cfg.method || 'GET').toUpperCase();
  const route = routes[cfg.url];
  if (!route) {
    const e = new Error('mock: no route for ' + cfg.url);
    e.code = 'ENOTFOUND';
    return Promise.reject(e);
  }
  const spec = route[method] || route.ANY;
  if (!spec) return Promise.reject(Object.assign(new Error('no method'), { code: 'ENOTFOUND' }));
  if (spec === 'timeout') {
    return Promise.reject(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
  }
  if (spec === 'network_error') {
    return Promise.reject(Object.assign(new Error('econnreset'), { code: 'ECONNRESET' }));
  }
  return Promise.resolve({
    status: spec.status,
    headers: spec.headers || {},
    data: cfg.responseType === 'stream' ? { destroy: () => {} } : (spec.data || ''),
  });
}
fakeAxios.request = fakeAxios;

// ---------------------------------------------------------------------------
// Fake dns.lookup
// ---------------------------------------------------------------------------

const dnsMap = {}; // hostname → [{address, family}] or 'error'
function resetDns() { for (const k of Object.keys(dnsMap)) delete dnsMap[k]; }

const fakeDnsLookup = (hostname, options) => {
  const entry = dnsMap[hostname];
  if (!entry || entry === 'error') return Promise.reject(new Error('ENOTFOUND'));
  return Promise.resolve(entry);
};

// ---------------------------------------------------------------------------
// Patch require before loading the verifier
// ---------------------------------------------------------------------------

const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === 'axios') return fakeAxios;
  if (id === 'dns') return { promises: { lookup: fakeDnsLookup } };
  return originalRequire.apply(this, arguments);
};

const verifier = require('../../src/services/seo/externalLinkVerifier');
const { _internal } = verifier;

// Convenience for the common case: allowlisted host that resolves to a
// public IP. Wikipedia is on the allowlist by hostname; CDC too.
function seedAllowed(host, ip = '8.8.8.8') {
  dnsMap[host] = [{ address: ip, family: 4 }];
}

// ---------------------------------------------------------------------------
// SSRF-adjacent unit checks (helpers)
// ---------------------------------------------------------------------------

test('isPrivateIpv4 identifies RFC1918 + loopback + link-local + CGNAT + 0.0.0.0/8', () => {
  const { isPrivateIpv4 } = _internal;
  assert.equal(isPrivateIpv4('10.0.0.1'), true);
  assert.equal(isPrivateIpv4('172.20.5.5'), true);
  assert.equal(isPrivateIpv4('172.15.5.5'), false);   // just below the range
  assert.equal(isPrivateIpv4('192.168.1.1'), true);
  assert.equal(isPrivateIpv4('127.0.0.1'), true);
  assert.equal(isPrivateIpv4('169.254.169.254'), true); // AWS metadata!
  assert.equal(isPrivateIpv4('100.64.0.1'), true);    // CGNAT
  assert.equal(isPrivateIpv4('0.0.0.0'), true);
  assert.equal(isPrivateIpv4('8.8.8.8'), false);
});

test('isPrivateIpv6 identifies loopback + link-local + ULA', () => {
  const { isPrivateIpv6 } = _internal;
  assert.equal(isPrivateIpv6('::1'), true);
  assert.equal(isPrivateIpv6('fe80::1'), true);
  assert.equal(isPrivateIpv6('fc00::1'), true);
  assert.equal(isPrivateIpv6('2606:4700::1'), false); // cloudflare
});

test('isDangerousHostString flags localhost and raw private IPs', () => {
  const { isDangerousHostString } = _internal;
  assert.equal(isDangerousHostString('localhost'), true);
  assert.equal(isDangerousHostString('foo.localhost'), true);
  assert.equal(isDangerousHostString('router.internal'), true);
  assert.equal(isDangerousHostString('server.local'), true);
  assert.equal(isDangerousHostString('192.168.0.1'), true);
  assert.equal(isDangerousHostString('en.wikipedia.org'), false);
});

test('isAllowedHost matches explicit hosts and .wikipedia.org / .gov suffixes', () => {
  assert.equal(verifier.isAllowedHost('en.wikipedia.org'), true);
  assert.equal(verifier.isAllowedHost('www.cdc.gov'), true);
  assert.equal(verifier.isAllowedHost('de.wikipedia.org'), true);  // suffix
  assert.equal(verifier.isAllowedHost('airnow.epa.gov'), true);    // suffix
  assert.equal(verifier.isAllowedHost('evil.com'), false);
  assert.equal(verifier.isAllowedHost('wikipedia.evil.com'), false); // suffix guard
});

// ---------------------------------------------------------------------------
// verifyOne — deterministic per-branch tests
// ---------------------------------------------------------------------------

test('200 URL from allowlisted domain is verified', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('en.wikipedia.org');
  routes['https://en.wikipedia.org/wiki/Housekeeping'] = { HEAD: { status: 200 } };
  const r = await verifier.verifyOne('https://en.wikipedia.org/wiki/Housekeeping');
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
});

test('redirect to a valid allowed URL is followed and accepted', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('www.cdc.gov'); seedAllowed('www.cdc.gov'); seedAllowed('en.wikipedia.org');
  routes['https://www.cdc.gov/old-path'] = { HEAD: { status: 301, headers: { location: 'https://en.wikipedia.org/wiki/Cleaning' } } };
  routes['https://en.wikipedia.org/wiki/Cleaning'] = { HEAD: { status: 200 } };
  const r = await verifier.verifyOne('https://www.cdc.gov/old-path');
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, 'https://en.wikipedia.org/wiki/Cleaning');
});

test('redirect off the allowlist is rejected', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('www.cdc.gov');
  routes['https://www.cdc.gov/redirect-away'] = { HEAD: { status: 302, headers: { location: 'https://evil.example.com/x' } } };
  const r = await verifier.verifyOne('https://www.cdc.gov/redirect-away');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'redirect_off_allowlist');
});

test('404 is rejected with a status-derived reason', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('www.epa.gov');
  routes['https://www.epa.gov/bad-url'] = { HEAD: { status: 404 } };
  const r = await verifier.verifyOne('https://www.epa.gov/bad-url');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'status_404');
});

test('410 gone is rejected', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('www.epa.gov');
  routes['https://www.epa.gov/gone'] = { HEAD: { status: 410 } };
  const r = await verifier.verifyOne('https://www.epa.gov/gone');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'status_410');
});

test('500 is rejected', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('www.cdc.gov');
  routes['https://www.cdc.gov/broken'] = { HEAD: { status: 500 } };
  const r = await verifier.verifyOne('https://www.cdc.gov/broken');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'status_500');
});

test('timeout is caught and rejected', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('www.cdc.gov');
  routes['https://www.cdc.gov/slow'] = { HEAD: 'timeout' };
  const r = await verifier.verifyOne('https://www.cdc.gov/slow');
  assert.equal(r.ok, false);
  assert.match(r.reason, /^head_error:/);
});

test('HEAD 405 falls back to GET and succeeds', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('www.mayoclinic.org');
  routes['https://www.mayoclinic.org/hygiene'] = { HEAD: { status: 405 }, GET: { status: 200 } };
  const r = await verifier.verifyOne('https://www.mayoclinic.org/hygiene');
  assert.equal(r.ok, true);
});

test('HEAD 501 falls back to GET as well', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('www.osha.gov');
  routes['https://www.osha.gov/topic'] = { HEAD: { status: 501 }, GET: { status: 200 } };
  const r = await verifier.verifyOne('https://www.osha.gov/topic');
  assert.equal(r.ok, true);
});

test('malformed URL is rejected without hitting the network', async () => {
  const r = await verifier.verifyOne('not a url at all');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed_url');
});

test('non-HTTPS URL is rejected', async () => {
  const r = await verifier.verifyOne('http://en.wikipedia.org/wiki/Test');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'non_https');
});

test('non-whitelisted domain is rejected before DNS/network', async () => {
  const r = await verifier.verifyOne('https://random-blog.example.com/post');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'non_allowlisted_host');
});

test('SSRF attempt — direct localhost URL is rejected as unsafe host', async () => {
  const r = await verifier.verifyOne('https://localhost/x');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsafe_host');
});

test('SSRF attempt — allowlisted host that DNS-resolves to a private IP is rejected', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  dnsMap['en.wikipedia.org'] = [{ address: '10.0.0.5', family: 4 }]; // attacker-controlled DNS
  const r = await verifier.verifyOne('https://en.wikipedia.org/wiki/Test');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsafe_dns');
});

test('AWS-metadata IP (169.254.169.254) is treated as private', () => {
  const { isPrivateIpv4 } = _internal;
  assert.equal(isPrivateIpv4('169.254.169.254'), true);
});

// ---------------------------------------------------------------------------
// verifyMany — batch behavior + concurrency
// ---------------------------------------------------------------------------

test('verifyMany returns per-URL results and a summary', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('en.wikipedia.org'); seedAllowed('www.epa.gov');
  routes['https://en.wikipedia.org/wiki/A'] = { HEAD: { status: 200 } };
  routes['https://en.wikipedia.org/wiki/B'] = { HEAD: { status: 200 } };
  routes['https://www.epa.gov/dead'] = { HEAD: { status: 404 } };
  const { results, summary } = await verifier.verifyMany([
    'https://en.wikipedia.org/wiki/A',
    'https://en.wikipedia.org/wiki/B',
    'https://www.epa.gov/dead',
    'not a url',
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.ok, 2);
  assert.equal(summary.dead, 2);
});

test('verifyMany dedupes duplicate URLs', async () => {
  _internal._resetCache();
  resetRoutes(); resetDns();
  seedAllowed('en.wikipedia.org');
  routes['https://en.wikipedia.org/wiki/X'] = { HEAD: { status: 200 } };
  const { results } = await verifier.verifyMany([
    'https://en.wikipedia.org/wiki/X',
    'https://en.wikipedia.org/wiki/X',
    'https://en.wikipedia.org/wiki/X',
  ]);
  assert.equal(results.length, 1);
});

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

test('extractExternalLinksFromMarkdown finds https URLs and skips images / code / anchors', () => {
  const md = `# Title

This is [a link](https://en.wikipedia.org/wiki/Foo) and another [link](https://www.cdc.gov/bar).

An [internal link](/services/deep) should be skipped.

An [anchor](#section) should be skipped.

An ![image](https://example.com/img.jpg) should be skipped.

\`\`\`
[code link](https://ignored.example)
\`\`\`

Also a duplicate [link back](https://en.wikipedia.org/wiki/Foo).`;
  const out = verifier.extractExternalLinksFromMarkdown(md);
  assert.deepEqual(out, [
    'https://en.wikipedia.org/wiki/Foo',
    'https://www.cdc.gov/bar',
  ]);
});

test('rewriteMistakenlyAbsoluteInternalLinks: rescues bogus-hostname links whose path matches the site', () => {
  // Real prod bug reproduction: model wrote https://spotlesshomes.com/booking
  // when the real hostname is spotless.homes. The PATH /booking is a real
  // internal URL. The rewriter should convert to a relative link so the
  // article gets internal-link credit.
  const md = 'Book online via [our booking page](https://www.spotlesshomes.com/booking) or read [our about page](https://spotlesshomes.com/about).';
  const out = verifier.rewriteMistakenlyAbsoluteInternalLinks(md, ['/booking', '/about', '/services/deep-cleaning']);
  assert.equal(
    out,
    'Book online via [our booking page](/booking) or read [our about page](/about).'
  );
});

test('rewriteMistakenlyAbsoluteInternalLinks: leaves genuine external links alone', () => {
  const md = 'See the [Wikipedia entry](https://en.wikipedia.org/wiki/Cleaning) and the [CDC guide](https://www.cdc.gov/hygiene).';
  const out = verifier.rewriteMistakenlyAbsoluteInternalLinks(md, ['/booking', '/about']);
  // Neither /wiki/Cleaning nor /hygiene are in the known-paths set, so the
  // links remain full URLs.
  assert.equal(out, md);
});

test('rewriteMistakenlyAbsoluteInternalLinks: preserves images', () => {
  const md = 'Photo: ![kitchen](https://www.spotlesshomes.com/booking-hero.jpg)';
  const out = verifier.rewriteMistakenlyAbsoluteInternalLinks(md, ['/booking']);
  assert.equal(out, md);
});

test('rewriteMistakenlyAbsoluteInternalLinks: handles trailing-slash variants', () => {
  const md = 'Visit [our booking](https://www.example.com/booking/) or [about](https://x.com/about).';
  const out = verifier.rewriteMistakenlyAbsoluteInternalLinks(md, ['/booking', '/about']);
  assert.match(out, /\[our booking\]\(\/booking\)/);
  assert.match(out, /\[about\]\(\/about\)/);
});

test('stripDeadLinksFromMarkdown rewrites [text](dead) → text and preserves live links + images', () => {
  const md = 'See the [EPA guide](https://www.epa.gov/dead) and the [Wikipedia article](https://en.wikipedia.org/wiki/Alive). Image ![alt](https://www.epa.gov/dead-image.jpg).';
  const out = verifier.stripDeadLinksFromMarkdown(md, ['https://www.epa.gov/dead']);
  assert.equal(
    out,
    'See the EPA guide and the [Wikipedia article](https://en.wikipedia.org/wiki/Alive). Image ![alt](https://www.epa.gov/dead-image.jpg).'
  );
});

// ---------------------------------------------------------------------------
// Pipeline integration — verifier failures don't fail generation
// ---------------------------------------------------------------------------

test('pipeline swallows verifier failure and preserves the article', async () => {
  // Force verifyMany to throw
  const orig = verifier.verifyMany;
  verifier.verifyMany = () => { throw new Error('verifier crashed'); };
  try {
    // Load pipeline AFTER swapping so its internal reference to
    // linkVerifier.verifyMany picks up our throwing stub via
    // require-cache.
    delete require.cache[require.resolve('../../src/services/seo/articleSeoPipeline')];
    const pipeline = require('../../src/services/seo/articleSeoPipeline');
    // Stub aiContentService so we don't hit OpenAI.
    const ai = require('../../src/services/aiContentService');
    const origGen = ai.generateArticle;
    ai.generateArticle = async () => ({
      data: ai.normalizeArticleOutput({
        title: 'Test', slug: 't', metaDescription: 'x'.repeat(150),
        markdown: '## Intro\n\nSome content with [ref](https://en.wikipedia.org/wiki/X).',
        suggestedExcerpt: 'e', suggestedSocialPost: 's',
      }),
      raw: '{}', prompt: 'p', model: 'test', usage: {}, costUsd: 0,
    });
    try {
      const result = await pipeline.generateArticleWithSeo({ keyword: 'test' });
      // Article still produced — verifier crash didn't blow the request.
      assert.ok(result.data.markdown.includes('Some content'));
    } finally {
      ai.generateArticle = origGen;
    }
  } finally {
    verifier.verifyMany = orig;
    delete require.cache[require.resolve('../../src/services/seo/articleSeoPipeline')];
  }
});
