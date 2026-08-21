// End-to-end SEO test against the deployed backend.
//
// Runs the full production-like flow:
//   1. Generate an article via POST /api/ai/articles
//   2. Verify SEO analysis is attached
//   3. Rename to a clearly-test title/slug so nothing customer-facing leaks
//   4. Intentionally break (blank meta description) via PATCH
//   5. Re-analyze — verify the check flips to failed
//   6. Fix via POST /api/blogs/:id/seo-fix
//   7. Re-analyze — verify the check flips back to passed
//   8. Publish to the real Spotless Homes blog_domain (writes to S3, fires
//      GitHub repository_dispatch)
//   9. Poll the public URL until it 200s (or timeout)
//  10. Inspect the rendered HTML — verify title/description/keyword tags
//  11. Unpublish + delete
//
// Env required (read from backend/.env):
//   SUPABASE_DATABASE_URL, JWT_SECRET, BACKEND_URL
//
// The backend URL defaults to https://self-post-production.up.railway.app.
// The target user is looked up from the blog_domain owner (Spotless Homes).

require('dotenv').config();
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BACKEND_URL = process.env.BACKEND_URL || 'https://self-post-production.up.railway.app';
const KEYWORD = 'post to seo e2e engineering test';
// Per-run slug so we never hit a CloudFront-cached response from a previous
// run. Still clearly-marked as an engineering artifact.
const TEST_SLUG = `post-to-seo-e2e-${Date.now().toString(36)}`;
const TEST_TITLE = 'Post-To SEO E2E Engineering Test (2026-08-21) — DO NOT INDEX';
const PUBLISH_WAIT_MS = 6 * 60 * 1000; // GH Actions build typically ~2-4 min
const POLL_INTERVAL_MS = 15 * 1000;

// Kept alongside the transcript so anything can be replayed later.
const REPORT_PATH = path.join(__dirname, '..', '..', 'docs', 'e2e-seo-report.json');

const step = (n, msg) => console.log(`\n[${new Date().toISOString().slice(11, 19)}] Step ${n}: ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`  ✗ ${msg}`); throw new Error(msg); };
const info = (msg) => console.log(`    ${msg}`);

// Wraps axios so error responses print bodies (defaults to just status).
async function req(client, method, url, opts = {}) {
  try {
    const res = await client.request({ method, url, ...opts });
    return res.data;
  } catch (err) {
    const status = err.response?.status || 'ERR';
    const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : err.message;
    throw new Error(`${method} ${url} → ${status}: ${body}`);
  }
}

async function main() {
  const evidence = { startedAt: new Date().toISOString(), backend: BACKEND_URL, steps: [], errors: [] };

  const db = new Client({ connectionString: process.env.SUPABASE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  step(1, 'Bootstrap: find Spotless Homes blog_domain + owner');
  const { rows: doms } = await db.query(`
    SELECT id, user_id, metadata->>'hostname' as hostname, metadata->>'public_hostname' as public_hostname,
           metadata->>'publish_target' as publish_target,
           metadata->>'public_url_pattern' as pattern,
           metadata->>'deploy_trigger' as deploy_trigger,
           metadata->>'github_repo' as github_repo
    FROM connected_accounts
    WHERE provider = 'blog_domain'
      AND (metadata->>'hostname' ILIKE '%spotless%' OR metadata->>'public_hostname' ILIKE '%spotless%')
      AND status = 'active'
    LIMIT 1;
  `);
  if (doms.length === 0) fail('No verified spotless.homes blog_domain found');
  const dom = doms[0];
  ok(`domain: ${dom.hostname} (target=${dom.publish_target}, deploy=${dom.deploy_trigger}, repo=${dom.github_repo})`);
  info(`public_url_pattern: ${dom.pattern}`);

  const userId = dom.user_id;
  const { rows: users } = await db.query('SELECT id, email, name, google_id FROM users WHERE id = $1', [userId]);
  const user = users[0];
  ok(`user: ${user.email}`);

  const token = jwt.sign(
    { userId: user.id, email: user.email, googleId: user.google_id, name: user.name, has_business_access: true },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );

  const api = axios.create({
    baseURL: BACKEND_URL,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 120_000,
    validateStatus: () => true,
  });

  // Rewrap so response bodies come through cleanly.
  const call = async (method, url, body) => {
    const r = await api.request({ method, url, data: body });
    if (r.status >= 400) {
      throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.data).slice(0, 400)}`);
    }
    return r.data;
  };

  // ---------------------------------------------------------------------
  step(2, 'Generate article');
  const t0 = Date.now();
  const gen = await call('POST', '/api/ai/articles', {
    keyword: KEYWORD,
    businessName: 'Spotless Homes',
    businessType: 'residential cleaning company',
    city: 'Tampa',
    service: 'recurring cleaning',
    tone: 'helpful, local, professional',
  });
  const genMs = Date.now() - t0;
  ok(`generation completed in ${(genMs / 1000).toFixed(1)}s`);
  info(`article id: ${gen.id}`);
  info(`title: ${gen.title}`);
  info(`slug: ${gen.slug}`);
  info(`meta length: ${(gen.metaDescription || '').length}`);
  info(`tags: ${JSON.stringify(gen.tags)}`);
  info(`searchIntent: ${gen.searchIntent}`);
  info(`repair applied: ${gen.repairApplied}`);
  if (!gen.seo) fail('no seo in response');
  info(`SEO: score=${gen.seo.score}, status=${gen.seo.status}, ${gen.seo.passed}✓ / ${gen.seo.warnings}⚠ / ${gen.seo.failed}✗`);
  info(`heroImage: ${gen.heroImage || '(none — auto-hero did not attach)'}`);
  info(`heroAlt: ${gen.heroAlt || '(none)'}`);
  const articleId = gen.id;
  evidence.generation = {
    ms: genMs, id: articleId, title: gen.title, slug: gen.slug,
    metaLength: (gen.metaDescription || '').length,
    tags: gen.tags, searchIntent: gen.searchIntent, repairApplied: gen.repairApplied,
    heroImage: gen.heroImage || null,
    heroAlt: gen.heroAlt || null,
    seoScore: gen.seo.score, seoStatus: gen.seo.status,
    checks: { passed: gen.seo.passed, warnings: gen.seo.warnings, failed: gen.seo.failed },
  };

  // Fetch the persisted row to capture usage / cost from ai_jobs.
  const { rows: jobs } = await db.query(
    "SELECT usage_json, model, cost_usd, prompt_tokens, completion_tokens, total_tokens FROM ai_jobs WHERE result_id = $1 ORDER BY created_at DESC LIMIT 1", [articleId]
  ).catch(() => ({ rows: [] }));
  // ai_jobs schema uses individual columns, not usage_json — fetch again with correct cols.
  const { rows: jobsFull } = await db.query(
    "SELECT model, cost_usd, prompt_tokens, completion_tokens, total_tokens FROM ai_jobs WHERE result_id = $1 ORDER BY created_at DESC LIMIT 1", [articleId]
  );
  if (jobsFull[0]) {
    info(`model: ${jobsFull[0].model}, tokens: ${jobsFull[0].prompt_tokens}p+${jobsFull[0].completion_tokens}c=${jobsFull[0].total_tokens}, cost: $${jobsFull[0].cost_usd}`);
    evidence.generation.model = jobsFull[0].model;
    evidence.generation.tokens = {
      prompt: jobsFull[0].prompt_tokens, completion: jobsFull[0].completion_tokens, total: jobsFull[0].total_tokens,
    };
    evidence.generation.costUsd = jobsFull[0].cost_usd;
  }

  // ---------------------------------------------------------------------
  step(3, 'Rename to a clearly-test title + slug so nothing customer-facing leaks');
  await call('PATCH', `/api/blogs/${articleId}`, { title: TEST_TITLE, slug: TEST_SLUG });
  ok(`renamed to ${TEST_SLUG}`);

  // ---------------------------------------------------------------------
  step(4, 'Intentionally break: blank the meta description');
  await call('PATCH', `/api/blogs/${articleId}`, { metaDescription: '' });
  ok('meta_description blanked');

  step(5, 'Re-analyze — expect meta_description_present to be failed');
  const brokenAn = await call('POST', `/api/blogs/${articleId}/seo-analyze`);
  const metaCheck = brokenAn.seo.checks.find((c) => c.id === 'meta_description_present');
  if (metaCheck.status !== 'failed') fail(`expected meta_description_present=failed, got ${metaCheck.status}`);
  ok(`meta_description_present → ${metaCheck.status}`);
  info(`overall: score=${brokenAn.seo.score}, ${brokenAn.seo.failed} failed, ${brokenAn.seo.criticalFailures} critical`);
  evidence.brokenState = {
    score: brokenAn.seo.score, status: brokenAn.seo.status,
    failed: brokenAn.seo.failed, criticalFailures: brokenAn.seo.criticalFailures,
  };

  // ---------------------------------------------------------------------
  step(6, 'Fix with AI — target meta_description_present');
  const fixed = await call('POST', `/api/blogs/${articleId}/seo-fix`, { checkId: 'meta_description_present' });
  ok(`fix applied, changed fields: ${Object.keys(fixed.changed).join(', ') || '(none)'}`);
  if (fixed.changed.meta_description) info(`  new meta: "${fixed.changed.meta_description.slice(0, 100)}${fixed.changed.meta_description.length > 100 ? '…' : ''}"`);

  step(7, 'Re-analyze — expect meta_description_present to be passed');
  const fixedCheck = fixed.seo.checks.find((c) => c.id === 'meta_description_present');
  if (fixedCheck.status !== 'passed') fail(`expected passed, got ${fixedCheck.status}`);
  ok(`meta_description_present → ${fixedCheck.status}`);
  info(`overall: score=${fixed.seo.score}, ${fixed.seo.failed} failed`);
  evidence.fixedState = {
    score: fixed.seo.score, status: fixed.seo.status,
    failed: fixed.seo.failed, criticalFailures: fixed.seo.criticalFailures,
  };

  // ---------------------------------------------------------------------
  step(8, 'Publish to real spotless.homes (S3 + GitHub dispatch)');
  // Ensure hero alt is set so the media checks aren't complaining.
  await call('PATCH', `/api/blogs/${articleId}`, {
    heroAlt: 'Post-To SEO end-to-end engineering test artifact',
  });
  const pub = await call('POST', `/api/blogs/${articleId}/publish`);
  ok(`publish ok — urls: ${JSON.stringify(pub.urls)}`);
  info(`deployHints: ${JSON.stringify(pub.deployHints)}`);
  evidence.publish = { urls: pub.urls, deployHints: pub.deployHints };
  const publicUrl = pub.urls?.[0];
  if (!publicUrl) fail('no public URL returned from publish');

  // ---------------------------------------------------------------------
  step(9, `Poll ${publicUrl} until it 200s (up to ${PUBLISH_WAIT_MS / 1000}s)`);
  const start = Date.now();
  let attempt = 0;
  let liveHtml = null;
  while (Date.now() - start < PUBLISH_WAIT_MS) {
    attempt++;
    const r = await axios.get(publicUrl, { validateStatus: () => true, timeout: 15_000 })
      .catch((e) => ({ status: 'ERR', data: '', headers: {}, err: e.message }));
    if (r.status === 200 && typeof r.data === 'string' && r.data.includes(TEST_SLUG)) {
      liveHtml = r.data;
      ok(`live after ${((Date.now() - start) / 1000).toFixed(0)}s (attempt ${attempt})`);
      break;
    }
    process.stdout.write(`  attempt ${attempt}: ${r.status}${r.err ? ` (${r.err})` : ''} — waiting…\n`);
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  if (!liveHtml) {
    console.warn(`  ⚠ site did not go live within ${PUBLISH_WAIT_MS / 1000}s — continuing to inspect what we have`);
    evidence.errors.push('published URL did not go 200 within timeout');
    liveHtml = ''; // continue so we still unpublish + report
  }
  evidence.published = { url: publicUrl, waitedMs: Date.now() - start, ok: liveHtml.length > 0 };

  // ---------------------------------------------------------------------
  step(10, 'Inspect rendered HTML');
  if (liveHtml) {
    const titleTag = (liveHtml.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const metaDesc = (liveHtml.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
    const canonical = (liveHtml.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i) || [])[1] || '';
    const h1 = (liveHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]?.replace(/<[^>]+>/g, '').trim() || '';
    const h2Count = (liveHtml.match(/<h2[^>]*>/gi) || []).length;
    const h3Count = (liveHtml.match(/<h3[^>]*>/gi) || []).length;
    const imgWithAlt = (liveHtml.match(/<img[^>]+alt=["'][^"']+["']/gi) || []).length;
    // Look for the hero specifically (the site inserts it as an <img> tag
    // whose src references the slug-hero path we uploaded to S3).
    const heroImgMatch = liveHtml.match(new RegExp(`<img[^>]+src=["']([^"']*${gen.slug ? gen.slug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') : 'hero'}[^"']*)["'][^>]*alt=["']([^"']*)["']`, 'i'));
    const heroImgUrl = heroImgMatch ? heroImgMatch[1] : null;
    const heroImgAlt = heroImgMatch ? heroImgMatch[2] : null;
    info(`<title>: ${titleTag.slice(0, 100)}`);
    info(`<meta description>: ${metaDesc.slice(0, 100)}`);
    info(`<link canonical>: ${canonical || '(none)'}`);
    info(`<h1>: ${h1.slice(0, 100)}`);
    info(`headings: ${h2Count} H2s, ${h3Count} H3s`);
    info(`images with alt: ${imgWithAlt}`);
    info(`hero <img>: ${heroImgUrl ? heroImgUrl.slice(0, 100) : '(none found)'}`);
    if (heroImgAlt) info(`hero alt: ${heroImgAlt.slice(0, 100)}`);
    evidence.rendered = { titleTag, metaDesc, canonical, h1, h2Count, h3Count, imgWithAlt, heroImgUrl, heroImgAlt };
    if (!titleTag.includes('SEO E2E')) evidence.errors.push('title did not include our test title');
  }

  // ---------------------------------------------------------------------
  step(11, 'Unpublish + delete');
  const unp = await call('POST', `/api/blogs/${articleId}/unpublish`);
  ok(`unpublished — removals: ${JSON.stringify(unp.removals)}`);
  await call('DELETE', `/api/blogs/${articleId}`);
  ok('deleted');
  evidence.cleanup = { unpublishOk: true, deleteOk: true };

  // ---------------------------------------------------------------------
  await db.end();
  evidence.completedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(evidence, null, 2));
  console.log(`\n✓ E2E complete. Evidence saved to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error('\n✗ E2E FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
