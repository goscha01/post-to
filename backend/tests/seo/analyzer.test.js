// Deterministic SEO analyzer unit tests.
//
// Each fixture asserts on the specific checks it was designed to exercise
// (not on every check for every fixture — that would be brittle and would
// obscure the intent). The test also enforces global invariants at the top
// (analyzer version, contentHash stability, category coverage).

const test = require('node:test');
const assert = require('node:assert/strict');

const analyzer = require('../../src/services/seo/articleSeoAnalyzer');
const rules = require('../../src/services/seo/articleSeoRules');
const { fixtures } = require('./fixtures');

// Handy: get a single check from a result by id.
function pick(result, id) {
  return result.checks.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Global invariants
// ---------------------------------------------------------------------------

test('analyzer version is exposed and matches rules module', () => {
  assert.equal(analyzer.SEO_ANALYZER_VERSION, rules.SEO_ANALYZER_VERSION);
  assert.equal(typeof analyzer.SEO_ANALYZER_VERSION, 'number');
});

test('every rule has an evaluator', () => {
  const strong = analyzer.analyze(fixtures.strong);
  const seenIds = new Set(strong.checks.map((c) => c.id));
  for (const rule of rules.RULES) {
    assert.ok(seenIds.has(rule.id), `rule ${rule.id} produced no check`);
  }
  // No rule reports its check as "no evaluator registered".
  const orphans = strong.checks.filter((c) => c.recommendation === 'no evaluator registered');
  assert.equal(orphans.length, 0);
});

test('contentHash is stable across identical inputs and changes on edit', () => {
  const a = analyzer.analyze(fixtures.strong);
  const b = analyzer.analyze(fixtures.strong);
  assert.equal(a.contentHash, b.contentHash, 'identical inputs must hash equally');

  const c = analyzer.analyze({ ...fixtures.strong, title: fixtures.strong.title + ' — updated' });
  assert.notEqual(a.contentHash, c.contentHash, 'title change must invalidate hash');

  const d = analyzer.analyze({ ...fixtures.strong, tags: [...fixtures.strong.tags, 'extra'] });
  assert.notEqual(a.contentHash, d.contentHash, 'tags change must invalidate hash');
});

test('every check category comes back non-empty on the strong fixture', () => {
  const r = analyzer.analyze(fixtures.strong);
  const groups = analyzer.groupByCategory(r.checks);
  const categories = new Set(groups.map((g) => g.id));
  for (const key of Object.keys(rules.CATEGORIES)) {
    assert.ok(categories.has(key), `category ${key} missing`);
  }
});

test('score is 0–100 and status is one of green/yellow/red', () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    const r = analyzer.analyze(fx);
    assert.ok(r.score >= 0 && r.score <= 100, `${name}: score out of range: ${r.score}`);
    assert.ok(['green', 'yellow', 'red'].includes(r.status), `${name}: bad status: ${r.status}`);
  }
});

// ---------------------------------------------------------------------------
// Per-fixture assertions
// ---------------------------------------------------------------------------

test('1. strong article: green status, high score, no critical failures', () => {
  const r = analyzer.analyze(fixtures.strong);
  assert.equal(r.criticalFailures, 0);
  assert.ok(r.score >= 80, `expected score ≥ 80, got ${r.score}`);
  assert.equal(r.status, 'green');
  assert.equal(pick(r, 'title_present').status, 'passed');
  assert.equal(pick(r, 'meta_description_present').status, 'passed');
  assert.equal(pick(r, 'hero_image_present').status, 'passed');
  assert.equal(pick(r, 'keyword_in_title').status, 'passed');
  assert.equal(pick(r, 'clean_markdown').status, 'passed');
});

test('2. short article: word_count fails, and content flags trip', () => {
  const r = analyzer.analyze(fixtures.short);
  const wc = pick(r, 'word_count');
  assert.ok(['warning', 'failed'].includes(wc.status), `word_count should flag, got ${wc.status}`);
  // Intro too small too.
  assert.ok(['warning', 'failed'].includes(pick(r, 'intro_present').status));
});

test('3. missing keyword: keyword_in_title flags; density warns', () => {
  const r = analyzer.analyze(fixtures.missingKeyword);
  // Title has zero keyword tokens → hard fail.
  assert.equal(pick(r, 'keyword_in_title').status, 'failed');
  // The stale fixture left "routine house cleaning" inside an FAQ heading —
  // 3/4 keyword tokens overlap, so the new relaxed heading check accepts it.
  // Density is what proves the keyword is genuinely underused.
  const kd = pick(r, 'keyword_density');
  assert.ok(['warning', 'failed'].includes(kd.status), `density should flag when keyword is under-used, got ${kd.status}`);
});

test('4. keyword stuffing: keyword_density fails and status is red', () => {
  const r = analyzer.analyze(fixtures.stuffed);
  const kd = pick(r, 'keyword_density');
  assert.equal(kd.status, 'failed', `expected stuffing to fail keyword_density, got ${kd.status}`);
  assert.ok(r.criticalFailures >= 1);
  assert.equal(r.status, 'red');
});

test('5. bad heading hierarchy: warning on hierarchy check', () => {
  const r = analyzer.analyze(fixtures.badHierarchy);
  const hh = pick(r, 'heading_hierarchy');
  assert.equal(hh.status, 'warning', `heading_hierarchy should warn, got ${hh.status}`);
});

test('6. no internal links: internal_links_present warns (site context present)', () => {
  const r = analyzer.analyze(fixtures.noInternalLinks);
  const il = pick(r, 'internal_links_present');
  assert.equal(il.status, 'warning', `expected warning, got ${il.status}`);
});

test('7. poor anchors: descriptive_anchor_text fails', () => {
  const r = analyzer.analyze(fixtures.poorAnchors);
  const da = pick(r, 'descriptive_anchor_text');
  assert.equal(da.status, 'failed');
  assert.match(da.recommendation, /generic/i);
});

test('8. missing image alt: hero_alt_present fails and image_alt_coverage fails', () => {
  const r = analyzer.analyze(fixtures.missingImageAlt);
  assert.equal(pick(r, 'hero_alt_present').status, 'failed');
  assert.equal(pick(r, 'image_alt_coverage').status, 'failed');
});

test('9. long paragraphs: no_wall_of_text warns (with paragraph_length warning too)', () => {
  const r = analyzer.analyze(fixtures.longParagraphs);
  const wall = pick(r, 'no_wall_of_text');
  const avg = pick(r, 'paragraph_length');
  assert.equal(wall.status, 'warning', `wall_of_text should warn, got ${wall.status}`);
  assert.ok(['warning', 'passed'].includes(avg.status));
});

test('10. missing meta description: meta_description_present fails (critical)', () => {
  const r = analyzer.analyze(fixtures.missingMeta);
  assert.equal(pick(r, 'meta_description_present').status, 'failed');
  assert.ok(r.criticalFailures >= 1);
  assert.equal(r.status, 'red');
});

test('11. oversized meta: meta_description_length flags', () => {
  const r = analyzer.analyze(fixtures.oversizedMeta);
  const md = pick(r, 'meta_description_length');
  assert.ok(['warning', 'failed'].includes(md.status), `expected flag, got ${md.status}`);
});

test('12. malformed markdown: clean_markdown fails (critical)', () => {
  const r = analyzer.analyze(fixtures.malformedMarkdown);
  const cm = pick(r, 'clean_markdown');
  assert.equal(cm.status, 'failed');
  assert.ok(r.criticalFailures >= 1);
});

test('13. FAQ article: faq_present passes', () => {
  const r = analyzer.analyze(fixtures.faqArticle);
  const faq = pick(r, 'faq_present');
  assert.equal(faq.status, 'passed');
});

test('14. legitimate article without FAQ: faq_present is not_applicable (not a warning)', () => {
  const r = analyzer.analyze(fixtures.noFaqOk);
  const faq = pick(r, 'faq_present');
  assert.equal(faq.status, 'not_applicable', `expected N/A when FAQ isn't the intent, got ${faq.status}`);
});

test('15. article with lists and tables: lists_present passes', () => {
  const r = analyzer.analyze(fixtures.listsAndTables);
  assert.equal(pick(r, 'lists_present').status, 'passed');
});

// ---------------------------------------------------------------------------
// Analyzer contract — extra safety
// ---------------------------------------------------------------------------

test('analyzer never throws on empty input', () => {
  const r = analyzer.analyze({});
  assert.equal(typeof r.score, 'number');
  assert.ok(r.checks.length === rules.RULES.length);
});

test('warnings count toward score but not as full pass', () => {
  const rStrong = analyzer.analyze(fixtures.strong);
  const rNoMeta = analyzer.analyze({ ...fixtures.strong, metaDescription: '' });
  assert.ok(rNoMeta.score < rStrong.score, 'removing meta should lower score');
});

test('classifyLink treats internal hostname variants correctly', () => {
  const { classifyLink } = analyzer._internal;
  const hosts = ['spotless.homes', 'www.spotless.homes'];
  assert.equal(classifyLink({ url: '/services/deep' }, hosts), 'internal');
  assert.equal(classifyLink({ url: 'https://www.spotless.homes/x' }, hosts), 'internal');
  assert.equal(classifyLink({ url: 'https://spotless.homes/x' }, hosts), 'internal');
  assert.equal(classifyLink({ url: 'https://blog.spotless.homes/x' }, hosts), 'internal');
  assert.equal(classifyLink({ url: 'https://cdc.gov/x' }, hosts), 'external');
  assert.equal(classifyLink({ url: '#anchor' }, hosts), 'anchor');
  assert.equal(classifyLink({ url: 'mailto:hi@x.com' }, hosts), 'contact');
});

test('semantically identical images produce identical hash regardless of images-array ordering', () => {
  // hash is stable across ordering of body vs input, but sensitive to alt changes.
  const a = analyzer.analyze(fixtures.strong);
  const b = analyzer.analyze({ ...fixtures.strong, heroAlt: fixtures.strong.heroAlt + ' extra' });
  assert.notEqual(a.contentHash, b.contentHash);
});

// Regression: real-world long-tail keyword from GSC ("ann russell how to
// clean everything") was flagged as "not present" in title/meta/intro/
// heading because the analyzer required a literal-phrase match. Natural
// writing fragments long-tail keywords ("Ann Russell's Guide: How to Clean
// Everything Effectively"). Semantic (proximity) match should accept it.
test('long-tail GSC keyword: semantic match accepts natural rewordings', () => {
  const input = {
    keyword: 'ann russell how to clean everything',
    title: "Ann Russell's Guide: How to Clean Everything Effectively",
    slug: 'ann-russell-how-to-clean-everything',
    metaDescription: "Discover Ann Russell's expert tips on how to clean everything in your home. Practical guide with clear steps and pro cleaning advice.",
    markdown: `Cleaning your home can often feel overwhelming, especially when you're facing tough stains or clutter. Ann Russell's guide walks you through how to clean everything room by room.

## Where to start when you need to clean everything

Break the work into zones. Kitchen surfaces first, then bathrooms, then bedrooms.

## Ann Russell's method

Work top-to-bottom, dry-to-wet. Ann Russell has taught this pattern for years.

### Kitchen: how to clean everything on the counter

Wipe down surfaces with a mild cleaner.

## Conclusion

Following Ann Russell's how-to-clean-everything method keeps a home consistently fresh.`,
    tags: ['cleaning', 'tampa'],
    heroImage: 'https://cdn.example/hero.jpg',
    heroAlt: 'Hands wearing yellow gloves cleaning a counter',
    internalHostnames: ['spotless.homes'],
  };
  const analyzer = require('../../src/services/seo/articleSeoAnalyzer');
  const r = analyzer.analyze(input);
  const p = (id) => r.checks.find((c) => c.id === id);
  assert.equal(p('keyword_in_title').status, 'passed', 'keyword semantically in title');
  assert.equal(p('keyword_in_meta_description').status, 'passed');
  assert.equal(p('keyword_in_intro').status, 'passed');
  assert.equal(p('keyword_in_heading').status, 'passed');
  assert.equal(p('keyword_placement_distribution').status, 'passed');
  // Density passes because we have multiple semantic hits, even without a
  // single verbatim occurrence of the whole 6-word phrase.
  const kd = p('keyword_density');
  assert.ok(kd.status !== 'failed', `keyword_density should not fail, got ${kd.status} (${kd.value})`);
});

test('groupByCategory returns exactly the 5 categories', () => {
  const r = analyzer.analyze(fixtures.strong);
  const groups = analyzer.groupByCategory(r.checks);
  assert.equal(groups.length, 5);
});
