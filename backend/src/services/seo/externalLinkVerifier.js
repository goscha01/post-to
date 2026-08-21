// Verifies external URLs picked by the LLM before we save the article.
//
// Rules of engagement (from the spec — repeated here so any future editor
// sees them without hopping to the PR description):
//   1. HTTPS-only.
//   2. Hostname must match ALLOWED_EXTERNAL_HOSTS or ALLOWED_EXTERNAL_SUFFIXES.
//   3. Short per-URL timeout (default 5s), bounded parallel concurrency
//      (default 5).
//   4. HEAD first; fall back to GET only when HEAD is refused (405 /
//      method-not-allowed / 501).
//   5. Follow up to MAX_REDIRECTS redirects manually, re-validating the
//      hostname at each hop. The FINAL destination must also be on the
//      allowlist.
//   6. Accept 200-299. Reject 4xx / 5xx.
//   7. Never allow SSRF — reject any hostname that resolves to a private
//      IP, loopback, link-local, or the string forms of those.
//   8. Verifier failure never throws to the caller. Dead / unverifiable
//      links are returned in `dead[]` and stripped from the markdown by
//      the caller — the article generation continues either way.
//
// Cache: in-process Map keyed by URL, TTL 24h. Successful verifications
// only — failures are cheap to re-check and network conditions matter.

const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Config — kept exported so tests can toggle knobs without patching the
// module internals with monkey-patches.
// ---------------------------------------------------------------------------

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'en.wikipedia.org', 'wikipedia.org',
  'www.cdc.gov', 'cdc.gov',
  'www.epa.gov', 'epa.gov',
  'www.hhs.gov', 'hhs.gov',
  'www.nih.gov', 'nih.gov',
  'www.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov',
  'www.mayoclinic.org', 'mayoclinic.org',
  'my.clevelandclinic.org',
  'www.energy.gov', 'energy.gov',
  'www.usa.gov', 'usa.gov',
  'www.consumerreports.org', 'consumerreports.org',
  'www.osha.gov', 'osha.gov',
]);

// Suffix-based (any language variant of Wikipedia — de.wikipedia.org,
// es.wikipedia.org, etc.). Also permits deep .gov subdomains like
// airnow.epa.gov, medlineplus.nih.gov.
const ALLOWED_EXTERNAL_SUFFIXES = ['.wikipedia.org', '.epa.gov', '.nih.gov', '.cdc.gov'];

const DEFAULT_OPTS = {
  timeoutMs: 5_000,
  maxRedirects: 3,
  concurrency: 5,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  userAgent: 'post-to-seo-link-verifier/1.0',
};

// Successful-verification cache: URL → { ok: true, finalUrl, at }.
// Failures aren't cached — network hiccups shouldn't lock us into "dead".
const cache = new Map();

// ---------------------------------------------------------------------------
// Host / IP checks
// ---------------------------------------------------------------------------

function isAllowedHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  if (ALLOWED_EXTERNAL_HOSTS.has(h)) return true;
  return ALLOWED_EXTERNAL_SUFFIXES.some((suf) => h.endsWith(suf));
}

// Private IPv4 ranges we always reject to prevent SSRF. Explicit string /
// numeric checks — not a full CIDR library because we only need a fixed set.
function isPrivateIpv4(ip) {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;         // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;// 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;// 100.64.0.0/10 CGNAT
  if (a === 0) return true;                        // 0.0.0.0/8 "this network"
  return false;
}

function isPrivateIpv6(ip) {
  const s = String(ip).toLowerCase();
  if (s === '::1') return true;                    // loopback
  if (s === '::') return true;                     // unspecified
  if (s.startsWith('fe80:')) return true;          // link-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique-local fc00::/7
  return false;
}

// Reject obvious internal-hostname strings even before DNS. This defends
// against redirects to "localhost" or a raw private IP that might be
// permitted by an allowlisted domain's misbehaving redirector.
function isDangerousHostString(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.corp')) return true;
  if (net.isIP(h) === 4 && isPrivateIpv4(h)) return true;
  if (net.isIP(h) === 6 && isPrivateIpv6(h)) return true;
  return false;
}

// DNS resolution + private-IP check. Uses dns.lookup rather than dns.resolve
// so /etc/hosts is honored (matching what a real HTTP request would use).
async function resolvesToPublicIp(hostname, { timeoutMs = 3000 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // dns.lookup doesn't take a signal directly, so wrap it in Promise.race.
    const lookup = dns.lookup(hostname, { all: true }).finally(() => clearTimeout(timer));
    const race = await Promise.race([
      lookup,
      new Promise((_, rej) => setTimeout(() => rej(new Error('DNS timeout')), timeoutMs)),
    ]);
    for (const { address, family } of race) {
      if (family === 4 && isPrivateIpv4(address)) return false;
      if (family === 6 && isPrivateIpv6(address)) return false;
    }
    return true;
  } catch {
    return false; // unresolvable → treat as unsafe
  }
}

// ---------------------------------------------------------------------------
// Single-URL verification
// ---------------------------------------------------------------------------

function safeParse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// One-hop request. Never follows redirects itself — the outer loop handles
// hops so we can re-check the allowlist + DNS at every step.
async function requestOne(url, method, { timeoutMs, userAgent }) {
  return axios.request({
    url, method,
    timeout: timeoutMs,
    maxRedirects: 0,
    validateStatus: () => true,
    headers: { 'User-Agent': userAgent, Accept: '*/*' },
    // Cap GET body so a rogue allowlisted domain can't stream us gigabytes.
    maxContentLength: 512 * 1024,
    responseType: method === 'GET' ? 'stream' : undefined,
    decompress: true,
  }).then((res) => {
    // For GET-stream, immediately destroy the stream — we only wanted the
    // status + headers, not the body.
    if (method === 'GET' && res.data && typeof res.data.destroy === 'function') {
      try { res.data.destroy(); } catch { /* ignore */ }
    }
    return res;
  });
}

// Verify a single URL. Returns { ok, url, finalUrl?, reason? }.
// Never throws.
async function verifyOne(rawUrl, opts) {
  const options = { ...DEFAULT_OPTS, ...opts };

  // Cache hit — successful verification within TTL.
  const cached = cache.get(rawUrl);
  if (cached && cached.ok && (Date.now() - cached.at) < options.cacheTtlMs) {
    return { ok: true, url: rawUrl, finalUrl: cached.finalUrl, cached: true };
  }

  const parsed = safeParse(rawUrl);
  if (!parsed) return { ok: false, url: rawUrl, reason: 'malformed_url' };
  if (parsed.protocol !== 'https:') return { ok: false, url: rawUrl, reason: 'non_https' };
  if (isDangerousHostString(parsed.hostname)) return { ok: false, url: rawUrl, reason: 'unsafe_host' };
  if (!isAllowedHost(parsed.hostname)) return { ok: false, url: rawUrl, reason: 'non_allowlisted_host' };
  const dnsOk = await resolvesToPublicIp(parsed.hostname, { timeoutMs: Math.min(3000, options.timeoutMs) });
  if (!dnsOk) return { ok: false, url: rawUrl, reason: 'unsafe_dns' };

  // Follow up to MAX_REDIRECTS manually, re-validating each hop.
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    let res;
    try {
      res = await requestOne(currentUrl, 'HEAD', options);
    } catch (e) {
      return { ok: false, url: rawUrl, reason: `head_error:${e.code || e.message || 'unknown'}` };
    }

    // Some sites (mayoclinic, occasionally cdc) 405 HEAD → try GET.
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      try {
        res = await requestOne(currentUrl, 'GET', options);
      } catch (e) {
        return { ok: false, url: rawUrl, reason: `get_error:${e.code || e.message || 'unknown'}` };
      }
    }

    // 3xx: re-validate hop and continue.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.location;
      if (!loc) return { ok: false, url: rawUrl, reason: 'redirect_no_location' };
      // Location may be relative to currentUrl.
      let nextUrl;
      try {
        nextUrl = new URL(loc, currentUrl).toString();
      } catch {
        return { ok: false, url: rawUrl, reason: 'redirect_malformed_location' };
      }
      const nextParsed = safeParse(nextUrl);
      if (!nextParsed) return { ok: false, url: rawUrl, reason: 'redirect_malformed' };
      if (nextParsed.protocol !== 'https:') return { ok: false, url: rawUrl, reason: 'redirect_non_https' };
      if (isDangerousHostString(nextParsed.hostname)) return { ok: false, url: rawUrl, reason: 'redirect_unsafe_host' };
      if (!isAllowedHost(nextParsed.hostname)) return { ok: false, url: rawUrl, reason: 'redirect_off_allowlist' };
      const nextDnsOk = await resolvesToPublicIp(nextParsed.hostname, { timeoutMs: Math.min(3000, options.timeoutMs) });
      if (!nextDnsOk) return { ok: false, url: rawUrl, reason: 'redirect_unsafe_dns' };
      currentUrl = nextUrl;
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      cache.set(rawUrl, { ok: true, finalUrl: currentUrl, at: Date.now() });
      return { ok: true, url: rawUrl, finalUrl: currentUrl, status: res.status };
    }
    return { ok: false, url: rawUrl, reason: `status_${res.status}` };
  }

  return { ok: false, url: rawUrl, reason: 'too_many_redirects' };
}

// ---------------------------------------------------------------------------
// Batch verification with bounded concurrency
// ---------------------------------------------------------------------------

// Verify N URLs in parallel with a bounded pool. Returns:
//   { results: [{ ok, url, finalUrl?, reason? }, ...],
//     summary: { total, ok, dead, cached } }
async function verifyMany(urls, opts = {}) {
  const options = { ...DEFAULT_OPTS, ...opts };
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return { results: [], summary: { total: 0, ok: 0, dead: 0, cached: 0 } };

  const results = [];
  let i = 0;
  const worker = async () => {
    while (i < unique.length) {
      const idx = i++;
      const url = unique[idx];
      try {
        results[idx] = await verifyOne(url, options);
      } catch (e) {
        results[idx] = { ok: false, url, reason: `unexpected:${e.message}` };
      }
    }
  };
  const pool = Array.from({ length: Math.min(options.concurrency, unique.length) }, () => worker());
  await Promise.all(pool);

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    dead: results.filter((r) => !r.ok).length,
    cached: results.filter((r) => r.cached).length,
  };
  return { results, summary };
}

// ---------------------------------------------------------------------------
// Markdown helpers — extract external URLs and strip dead ones
// ---------------------------------------------------------------------------

// Return the set of unique external URLs found in the markdown, in order of
// first appearance. Skips code blocks and images. Root-relative and hash
// anchors are dropped (those are internal / on-page).
function extractExternalLinksFromMarkdown(markdown) {
  if (!markdown) return [];
  const src = String(markdown).replace(/```[\s\S]*?```/g, ' ');
  const seen = new Set();
  const out = [];
  const re = /(?<!\!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const url = (m[2] || '').trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue; // internal / anchor / mailto / etc.
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

// Rewrite `[text](deadUrl)` → `text` for every dead URL. Preserves the
// prose exactly, only the parentheses + URL are removed. Case-sensitive
// URL match (URLs are case-sensitive in path).
function stripDeadLinksFromMarkdown(markdown, deadUrls) {
  if (!markdown || !deadUrls || deadUrls.length === 0) return markdown;
  let out = String(markdown);
  const dead = new Set(deadUrls);
  // Non-image links only. Replace with the anchor text alone.
  const re = /(!)?\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  out = out.replace(re, (full, bang, text, url) => {
    if (bang) return full; // preserve images
    return dead.has(url.trim()) ? text : full;
  });
  return out;
}

// Test hook — clear the in-process cache. Not exported publicly; use via
// _internal in tests.
function _resetCache() { cache.clear(); }

module.exports = {
  verifyOne,
  verifyMany,
  extractExternalLinksFromMarkdown,
  stripDeadLinksFromMarkdown,
  isAllowedHost,
  ALLOWED_EXTERNAL_HOSTS,
  ALLOWED_EXTERNAL_SUFFIXES,
  DEFAULT_OPTS,
  _internal: { isPrivateIpv4, isPrivateIpv6, isDangerousHostString, resolvesToPublicIp, safeParse, _resetCache },
};
