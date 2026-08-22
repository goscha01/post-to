// Generation-pipeline tests.
//
// The LLM is mocked (we stub aiContentService.generateArticle +
// repairArticle) so we exercise the orchestration deterministically:
//   * enhanced prompt actually asks for SEO / structured JSON
//   * bounded repair fires only for qualifying failures
//   * at most ONE repair pass
//   * repair result is rejected if it's not an improvement
//   * initial 6-field output still parses under the enhanced schema
//   * `knownInternalUrls` empty vs populated changes the prompt

const test = require('node:test');
const assert = require('node:assert/strict');

const aiContent = require('../../src/services/aiContentService');
const seoPipeline = require('../../src/services/seo/articleSeoPipeline');
const { STRONG_BODY } = require('./fixtures');

// ---------------------------------------------------------------------------
// Prompt shape assertions (no LLM call — just build the string).
// ---------------------------------------------------------------------------

test('enhanced article prompt asks for SEO + structured JSON envelope', () => {
  const { system, user } = aiContent._internal.buildArticlePrompt({
    keyword: 'house cleaning tampa',
    knownInternalUrls: ['/services/deep-cleaning'],
  });
  assert.match(system, /SEO content writer/i);
  // Structured output keys are named in the prompt.
  for (const key of ['tags', 'searchIntent', 'faq', 'imageSuggestions', 'suggestedInternalLinks']) {
    assert.match(user, new RegExp(key), `prompt should mention "${key}"`);
  }
  // Adaptive-structure guidance.
  assert.match(user, /pick what fits/i);
  // No H1 in body rule (title is the H1).
  assert.match(user, /Never emit an H1/i);
  // Mandatory intro rule (added to fix "no intro" cases seen in prod).
  assert.match(user, /MANDATORY first block/i);
  // Enforced length floor (added after prod articles shipped ~500 words).
  assert.match(user, /at least 1,500 words|MUST be at least 1,500/i);
  // Explicit external-links requirement so `external_links_present` doesn't
  // warn on every fresh article.
  assert.match(user, /External links/);
  assert.match(user, /authoritative/i);
  // Keyword rule.
  assert.match(user, /house cleaning tampa/);
  // Internal links whitelist appears.
  assert.match(user, /\/services\/deep-cleaning/);
});

test('when no internal URLs are known, prompt explicitly forbids inventing them', () => {
  const { user } = aiContent._internal.buildArticlePrompt({
    keyword: 'house cleaning tampa',
    knownInternalUrls: [],
  });
  assert.match(user, /Do NOT invent internal links/i);
});

test('repair prompt lists analyzer failures verbatim', () => {
  const { user } = aiContent._internal.buildArticleRepairPrompt({
    previousJson: { title: 'x', slug: 'x', metaDescription: 'x', markdown: '## x', suggestedExcerpt: '', suggestedSocialPost: '', tags: [] },
    analysis: {
      checks: [
        { id: 'title_length', status: 'failed', label: 'Title length', value: '10 chars', recommendation: 'Aim for 45–65 chars.', weight: 2 },
        { id: 'meta_description_length', status: 'warning', label: 'Meta description length', value: '200 chars', recommendation: 'Trim under 160.', weight: 2 },
      ],
    },
    keyword: 'test kw',
    businessName: 'Test Co',
  });
  assert.match(user, /Aim for 45–65 chars/);
  assert.match(user, /Trim under 160/);
  assert.match(user, /Keep the overall voice/i);
});

test('repair prompt: word_count issue triggers explicit expansion instruction', () => {
  const { user } = require('../../src/services/aiContentService')._internal.buildArticleRepairPrompt({
    previousJson: { title: 't', slug: 't', metaDescription: 'x', markdown: '## t\n\nshort', suggestedExcerpt: '', suggestedSocialPost: '', tags: [] },
    analysis: { checks: [{ id: 'word_count', status: 'warning', label: 'Article length', value: '600 words', recommendation: 'Expand.', weight: 2 }] },
    keyword: 'k', businessName: 'Biz',
  });
  assert.match(user, /CRITICAL: The article is currently too short/i);
  assert.match(user, /1,500 words/);
  assert.match(user, /adding entirely new H2 sections/i);
});

test('repair prompt: external_links issue triggers allowlist reminder', () => {
  const { user } = require('../../src/services/aiContentService')._internal.buildArticleRepairPrompt({
    previousJson: { title: 't', slug: 't', metaDescription: 'x', markdown: '## t\n\nx', suggestedExcerpt: '', suggestedSocialPost: '', tags: [] },
    analysis: { checks: [{ id: 'external_links_present', status: 'warning', label: 'External links present', value: '0', recommendation: 'Add.', weight: 2 }] },
    keyword: 'k', businessName: 'Biz',
  });
  assert.match(user, /External links/);
  assert.match(user, /en\.wikipedia\.org/);
  assert.match(user, /NEVER use example\.com/i);
});

// ---------------------------------------------------------------------------
// normalizeArticleOutput contract.
// ---------------------------------------------------------------------------

test('normalizeArticleOutput defaults new fields when the LLM omits them', () => {
  const out = aiContent.normalizeArticleOutput({
    title: 'T', slug: 's', metaDescription: 'm', markdown: 'md',
    suggestedExcerpt: 'e', suggestedSocialPost: 's',
  });
  assert.deepEqual(out.tags, []);
  assert.deepEqual(out.faq, []);
  assert.deepEqual(out.imageSuggestions, []);
  assert.deepEqual(out.suggestedInternalLinks, []);
  assert.equal(out.searchIntent, '');
});

test('normalizeArticleOutput throws when any legacy field is missing', () => {
  assert.throws(() => aiContent.normalizeArticleOutput({ title: 't' }), /missing field/);
});

test('normalizeArticleOutput coerces tags to lowercase strings and caps length', () => {
  const out = aiContent.normalizeArticleOutput({
    title: 'T', slug: 's', metaDescription: 'm', markdown: 'md',
    suggestedExcerpt: 'e', suggestedSocialPost: 's',
    tags: ['Tampa', 'CLEANING', '  cleaning ', 42, null, 'x'.repeat(200)],
  });
  assert.ok(out.tags.every((t) => typeof t === 'string'));
  assert.ok(out.tags.every((t) => t === t.toLowerCase()));
  assert.ok(out.tags.includes('tampa'));
  assert.ok(out.tags.length <= 12);
});

// ---------------------------------------------------------------------------
// Pipeline orchestration — mock the LLM.
// ---------------------------------------------------------------------------

// Small helper to swap generateArticle / repairArticle atomically for a test.
function stubLLM({ generate, repair }) {
  const original = { g: aiContent.generateArticle, r: aiContent.repairArticle };
  aiContent.generateArticle = generate;
  aiContent.repairArticle = repair;
  return () => { aiContent.generateArticle = original.g; aiContent.repairArticle = original.r; };
}

function fakeLLMOutput(overrides = {}) {
  return {
    data: aiContent.normalizeArticleOutput({
      title: 'Routine House Cleaning Services in Tampa: A Complete Guide',
      slug: 'routine-house-cleaning-services-tampa',
      metaDescription: 'Routine house cleaning services in Tampa: what they cover, how often to book, what they cost, and how to make bi-weekly cleaning work in Florida humidity.',
      markdown: STRONG_BODY,
      suggestedExcerpt: 'A guide to routine house cleaning services in Tampa.',
      suggestedSocialPost: 'New guide up on routine cleaning in Tampa — booking cadence, cost ranges, and what to expect.',
      tags: ['tampa', 'cleaning'],
      searchIntent: 'informational',
      faq: [{ question: 'q', answer: 'a' }],
      imageSuggestions: [{ description: 'a clean kitchen', alt: 'a clean kitchen after routine cleaning' }],
      suggestedInternalLinks: [{ anchor: 'deep cleaning', url: '/services/deep-cleaning' }],
      ...overrides,
    }),
    raw: 'raw',
    prompt: 'p',
    model: 'gpt-4o-mini',
    usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 },
    costUsd: 0.001,
  };
}

test('pipeline: strong initial output → analyzer reports high score', async () => {
  const calls = { generate: 0, repair: 0 };
  const restore = stubLLM({
    generate: async () => { calls.generate++; return fakeLLMOutput(); },
    repair: async () => { calls.repair++; return fakeLLMOutput(); },
  });
  try {
    const result = await seoPipeline.generateArticleWithSeo({
      keyword: 'routine house cleaning services',
      businessName: 'Spotless Homes',
      knownInternalUrls: ['/services/deep-cleaning'],
      internalHostnames: ['spotless.homes'],
    });
    assert.equal(calls.generate, 1);
    // Repair may fire on a single warning like external_links_present or
    // meta_description_length under the (deliberately) aggressive
    // 1+-fixable-warning trigger. Either way, at most ONE repair pass.
    assert.ok(calls.repair <= 1, 'at most one repair pass');
    // Hero image is attached in the editor (post-generation), so the analyzer
    // legitimately reports it failed at this point — that's fine and the
    // banner shows red as a nudge to the user. What matters here is the
    // pipeline correctly ignored hero for the repair decision.
    assert.ok(result.analysis.score >= 80);
  } finally { restore(); }
});

test('pipeline: bad initial output → exactly ONE repair pass, accepted when better', async () => {
  const calls = { generate: 0, repair: 0 };
  const badOutput = fakeLLMOutput({
    title: 'short',                       // too short
    metaDescription: '',                  // missing (critical)
    markdown: '## Small\n\nHi.',          // way too thin
    slug: 'x',
  });
  const goodOutput = fakeLLMOutput();      // strong repair result
  const restore = stubLLM({
    generate: async () => { calls.generate++; return badOutput; },
    repair: async () => { calls.repair++; return goodOutput; },
  });
  try {
    const result = await seoPipeline.generateArticleWithSeo({
      keyword: 'routine house cleaning services',
      businessName: 'Spotless Homes',
      knownInternalUrls: ['/services/deep-cleaning'],
      internalHostnames: ['spotless.homes'],
    });
    assert.equal(calls.generate, 1);
    assert.equal(calls.repair, 1, 'exactly one repair pass');
    assert.equal(result.repairApplied, true);
    // Repair produced a better analysis, so we ended up on the good one.
    // Hero-image failure is expected (attached later by the editor) — the
    // pipeline's needsRepair ignores hero checks, and here we just verify
    // repair-fixable criticals (title/meta/etc.) are gone.
    const repairableCritical = result.analysis.checks.filter(
      (c) => c.status === 'failed' && c.weight >= 3
        && !['hero_image_present', 'hero_alt_present', 'image_alt_coverage'].includes(c.id),
    ).length;
    assert.equal(repairableCritical, 0, 'no repair-fixable critical failures remain');
    // Cost + usage accumulated across both calls.
    assert.equal(result.usage.total_tokens, 6000);
    assert.ok(result.costUsd > 0.001);
  } finally { restore(); }
});

test('pipeline: repair worse than initial → repair rejected, initial kept', async () => {
  const calls = { generate: 0, repair: 0 };
  const badInitial = fakeLLMOutput({
    // Missing meta description — critical failure triggers repair.
    metaDescription: '',
  });
  const evenWorseRepair = fakeLLMOutput({
    // Repair somehow makes it worse (also drops the title).
    title: '',
    metaDescription: '',
    markdown: '## bad\n\ntoo short',
  });
  const restore = stubLLM({
    generate: async () => { calls.generate++; return badInitial; },
    repair: async () => { calls.repair++; return evenWorseRepair; },
  });
  try {
    const result = await seoPipeline.generateArticleWithSeo({
      keyword: 'routine house cleaning services',
      businessName: 'Spotless Homes',
      knownInternalUrls: ['/services/deep-cleaning'],
      internalHostnames: ['spotless.homes'],
    });
    assert.equal(calls.repair, 1);
    assert.equal(result.repairApplied, true, 'repair was attempted');
    // The kept article is the INITIAL one — data.title still has the strong
    // title from the initial output.
    assert.notEqual(result.data.title, '', 'initial (non-empty) title preserved');
    // A repairAnalysis is exposed so callers can audit the rejection.
    assert.ok(result.repairAnalysis, 'repairAnalysis available for audit');
  } finally { restore(); }
});

test('pipeline: repair throws → falls back to initial without failing the whole call', async () => {
  const calls = { generate: 0, repair: 0 };
  const badInitial = fakeLLMOutput({ metaDescription: '' });
  const restore = stubLLM({
    generate: async () => { calls.generate++; return badInitial; },
    repair: async () => { calls.repair++; throw new Error('repair boom'); },
  });
  try {
    const result = await seoPipeline.generateArticleWithSeo({
      keyword: 'routine house cleaning services',
      businessName: 'Spotless Homes',
    });
    assert.equal(calls.repair, 1);
    // Article still returns — just without an accepted repair.
    assert.equal(result.repairApplied, true);
    assert.ok(result.data.title.length > 0);
  } finally { restore(); }
});

test('pipeline: post-generation analysis is always attached', async () => {
  const restore = stubLLM({
    generate: async () => fakeLLMOutput(),
    repair: async () => fakeLLMOutput(),
  });
  try {
    const result = await seoPipeline.generateArticleWithSeo({
      keyword: 'routine house cleaning services',
      businessName: 'Spotless Homes',
      knownInternalUrls: ['/services/deep-cleaning'],
      internalHostnames: ['spotless.homes'],
    });
    assert.ok(result.analysis);
    assert.ok(Array.isArray(result.analysis.checks));
    assert.ok(result.analysis.checks.length > 0);
    assert.ok(['green', 'yellow', 'red'].includes(result.analysis.status));
  } finally { restore(); }
});

test('needsRepair: 2+ auto-fixable warnings triggers repair (no intro + keyword-in-intro miss)', () => {
  // These are the exact warnings we saw in prod on the apartment-cleaning
  // article — no intro at all → keyword_in_intro and keyword_placement also
  // warn. Repair should fire even though nothing is critical.
  const trigger = seoPipeline.needsRepair({
    checks: [
      { id: 'title_present', status: 'passed', weight: 3 },
      { id: 'meta_description_present', status: 'passed', weight: 3 },
      { id: 'clean_markdown', status: 'passed', weight: 3 },
      { id: 'keyword_in_title', status: 'passed', weight: 3 },
      { id: 'intro_present', status: 'warning', weight: 2 },
      { id: 'keyword_in_intro', status: 'warning', weight: 2 },
      { id: 'keyword_placement_distribution', status: 'warning', weight: 1 },
      { id: 'word_count', status: 'passed', weight: 2 },
    ],
    criticalFailures: 0,
    score: 82,
  });
  assert.equal(trigger, true, 'objectively-fixable warning cluster must trigger repair');
});

test('needsRepair: repair-fixable critical failures trigger; hero and warnings do not', () => {
  // Hero-only failure → not triggering (repair can't attach a hero).
  const heroOnly = seoPipeline.needsRepair({
    checks: [
      { id: 'hero_image_present', status: 'failed', weight: 3 },
      { id: 'title_present', status: 'passed', weight: 3 },
    ],
    criticalFailures: 1,
    score: 90,
  });
  assert.equal(heroOnly, false, 'hero-only failure must not trigger repair');

  // A repair-fixable critical → triggers.
  const metaFail = seoPipeline.needsRepair({
    checks: [
      { id: 'meta_description_present', status: 'failed', weight: 3 },
      { id: 'title_present', status: 'passed', weight: 3 },
    ],
    criticalFailures: 1,
    score: 90,
  });
  assert.equal(metaFail, true, 'critical failure the LLM can fix must trigger');

  // Only truly subjective warnings (not in AUTO_REPAIR_WARNING_IDS) →
  // no trigger. `tags_configured` and `anchor_diversity` are user-judgment
  // items that shouldn't force a rewrite.
  const subjectiveWarningsOnly = seoPipeline.needsRepair({
    checks: [
      { id: 'title_present', status: 'passed', weight: 3 },
      { id: 'meta_description_present', status: 'passed', weight: 3 },
      { id: 'slug_present', status: 'passed', weight: 3 },
      { id: 'clean_markdown', status: 'passed', weight: 3 },
      { id: 'keyword_in_title', status: 'passed', weight: 3 },
      { id: 'meta_description_length', status: 'passed', weight: 2 },
      { id: 'word_count', status: 'passed', weight: 2 },
      { id: 'heading_hierarchy', status: 'passed', weight: 2 },
      { id: 'tags_configured', status: 'warning', weight: 1 },
      { id: 'anchor_diversity', status: 'warning', weight: 1 },
    ],
    criticalFailures: 0,
    score: 88,
  });
  assert.equal(subjectiveWarningsOnly, false, 'subjective warnings alone must not trigger repair');

  // An auto-fixable warning (meta_description_length) SHOULD trigger, even
  // alone — that's the improvement over the previous 2+ threshold.
  const autoFixableSingle = seoPipeline.needsRepair({
    checks: [
      { id: 'title_present', status: 'passed', weight: 3 },
      { id: 'meta_description_present', status: 'passed', weight: 3 },
      { id: 'clean_markdown', status: 'passed', weight: 3 },
      { id: 'meta_description_length', status: 'warning', weight: 2 },
      { id: 'word_count', status: 'passed', weight: 2 },
    ],
    criticalFailures: 0,
    score: 92,
  });
  assert.equal(autoFixableSingle, true, 'a single auto-fixable warning must trigger repair');
});

test('analyzeExistingArticle works on a legacy DB row (snake_case, no new fields)', () => {
  const legacyRow = {
    keyword: 'routine house cleaning services',
    title: 'Routine House Cleaning Services in Tampa',
    slug: 'routine-house-cleaning-services-tampa',
    meta_description: 'Routine house cleaning services in Tampa: what they cover, cost, cadence.',
    markdown: STRONG_BODY,
    hero_image: 'https://cdn.spotless.homes/blog/hero.jpg',
    hero_alt: null,
    tags: null,
    search_intent: null,
  };
  const analysis = seoPipeline.analyzeExistingArticle({
    article: legacyRow,
    internalHostnames: ['spotless.homes'],
    knownInternalUrls: ['/services/deep-cleaning'],
  });
  assert.ok(analysis.score > 0);
  assert.equal(typeof analysis.contentHash, 'string');
});
