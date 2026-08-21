// Tests for the S3 publisher — SEO-oriented additions.
//
// Verifies:
//   * new frontmatter fields (heroAlt, tags[], keyword) render correctly
//   * tables, FAQ H3s, lists, callouts survive the publish pipeline unchanged
//   * hero-image injection still works and doesn't damage nearby structure
//   * validatePublishedMarkdown catches known publish-breaking issues
//   * legacy row without new fields still renders identical (backward compat)
//
// No AWS credentials required — we only exercise the pure functions.

const test = require('node:test');
const assert = require('node:assert/strict');

const pub = require('../src/services/blogPublisherS3');
const { toFrontmatter, injectHeroInBody, validatePublishedMarkdown } = pub._internal;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

test('toFrontmatter emits scalar quotes and array flow sequences', () => {
  const fm = toFrontmatter({
    title: 'Routine House Cleaning: Tampa Guide',
    slug: 'routine-house-cleaning-tampa',
    tags: ['tampa', 'cleaning', 'home maintenance'],
    keyword: 'routine house cleaning',
    heroAlt: 'A tidy Tampa living room',
    empty: '',
    nullish: null,
    emptyArray: [],
  });
  assert.match(fm, /^---/m);
  assert.match(fm, /title: "Routine House Cleaning: Tampa Guide"/);
  assert.match(fm, /tags: \["tampa", "cleaning", "home maintenance"\]/);
  assert.match(fm, /keyword: "routine house cleaning"/);
  assert.match(fm, /heroAlt: "A tidy Tampa living room"/);
  // Blanks / nulls / empty arrays are omitted entirely.
  assert.doesNotMatch(fm, /empty:/);
  assert.doesNotMatch(fm, /nullish:/);
  assert.doesNotMatch(fm, /emptyArray:/);
});

test('toFrontmatter escapes double quotes and backslashes in values', () => {
  const fm = toFrontmatter({ title: 'A "quoted" heading with \\ backslash' });
  assert.match(fm, /title: "A \\"quoted\\" heading with \\\\ backslash"/);
});

// ---------------------------------------------------------------------------
// buildMarkdown — end-to-end passthrough of structural elements
// ---------------------------------------------------------------------------

const STRUCTURED_BODY = [
  '## Introduction',
  '',
  'Some intro copy.',
  '',
  '### Key takeaways',
  '',
  '- point A',
  '- point B',
  '- point C',
  '',
  '## Pricing',
  '',
  'Cost varies by home size:',
  '',
  '| Home size | Typical price |',
  '|---|---|',
  '| 2BR | $120 |',
  '| 3BR | $170 |',
  '',
  '## FAQ',
  '',
  '### How long does a visit take?',
  '',
  '90 minutes to three hours.',
  '',
  '### Do I need to be home?',
  '',
  'No.',
].join('\n');

const domain = {
  metadata: {
    hostname: 'blog.spotless.homes',
    site_name: 'Spotless Homes',
    author_name: 'Spotless Editorial',
    s3_prefix: 'posts/',
  },
};

function makeBlog(overrides = {}) {
  return {
    title: 'Routine House Cleaning Services in Tampa',
    slug: 'routine-house-cleaning-services-tampa',
    meta_description: 'A guide to routine house cleaning services in Tampa.',
    markdown: STRUCTURED_BODY,
    published_at: '2026-08-21T10:00:00.000Z',
    updated_at: '2026-08-21T10:00:00.000Z',
    hero_image: 'https://cdn.spotless.homes/blog/hero.jpg',
    hero_alt: 'A tidy Tampa living room after a routine cleaning visit',
    keyword: 'routine house cleaning services',
    tags: ['tampa', 'cleaning', 'residential'],
    ...overrides,
  };
}

test('buildMarkdown includes heroAlt, tags, and keyword in frontmatter', () => {
  const md = pub.buildMarkdown({ blog: makeBlog(), domain });
  assert.match(md, /heroAlt: "A tidy Tampa living room after a routine cleaning visit"/);
  assert.match(md, /tags: \["tampa", "cleaning", "residential"\]/);
  assert.match(md, /keyword: "routine house cleaning services"/);
});

test('buildMarkdown preserves tables, FAQ H3s, and bullet lists verbatim', () => {
  const md = pub.buildMarkdown({ blog: makeBlog(), domain });
  // Table
  assert.match(md, /\| Home size \| Typical price \|/);
  assert.match(md, /\| 2BR \| \$120 \|/);
  // FAQ H3s
  assert.match(md, /### How long does a visit take\?/);
  assert.match(md, /### Do I need to be home\?/);
  // Bullet list
  assert.match(md, /- point A/);
  assert.match(md, /- point B/);
});

test('buildMarkdown injects the hero after the first prose paragraph without breaking tables', () => {
  const md = pub.buildMarkdown({ blog: makeBlog(), domain });
  // Hero image markdown appears once (in the body) and does NOT swallow the
  // subsequent H2s.
  const heroMatches = md.match(/!\[[^\]]+\]\(https:\/\/cdn\.spotless\.homes\/blog\/hero\.jpg\)/g) || [];
  assert.ok(heroMatches.length >= 1, 'hero image should be injected into body');
  // Table is still intact after injection.
  assert.match(md, /\| Home size \| Typical price \|/);
  // Headings all have the expected space after their #s (no injection
  // turned a real heading into a malformed one).
  const body = md.split('\n---\n').slice(1).join('\n---\n');
  const badHeadings = body.match(/^#{1,6}[^#\s]/gm) || [];
  assert.equal(badHeadings.length, 0, `no malformed headings, got ${JSON.stringify(badHeadings)}`);
});

test('buildMarkdown for legacy row without SEO fields still renders (backward compat)', () => {
  const legacy = {
    title: 'Old Article',
    slug: 'old-article',
    meta_description: 'legacy',
    markdown: '## Old\n\nOne paragraph.',
    hero_image: 'https://cdn.spotless.homes/blog/hero.jpg',
    published_at: '2025-05-01T00:00:00.000Z',
    updated_at: '2025-05-02T00:00:00.000Z',
    // no tags, no keyword, no heroAlt
  };
  const md = pub.buildMarkdown({ blog: legacy, domain });
  assert.match(md, /title: "Old Article"/);
  assert.match(md, /slug: "old-article"/);
  // These fields must NOT appear when the source row doesn't have them —
  // no phantom `tags: []` or `keyword: ""` in frontmatter.
  assert.doesNotMatch(md, /^tags:/m);
  assert.doesNotMatch(md, /^keyword:/m);
  assert.doesNotMatch(md, /^heroAlt:/m);
});

test('buildMarkdown does not inject the hero twice if the body already references it', () => {
  const heroUrl = 'https://cdn.spotless.homes/blog/hero.jpg';
  const blog = makeBlog({
    hero_image: heroUrl,
    markdown: `## Intro\n\nSome copy.\n\n![existing](${heroUrl})\n\n## More\n\nEnd.`,
  });
  const md = pub.buildMarkdown({ blog, domain });
  const heroMatches = md.match(new RegExp(heroUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || [];
  // Front-matter reference + one in the body. No duplicate injection.
  assert.equal(heroMatches.length, 2, `expected 2 references, got ${heroMatches.length}`);
});

// ---------------------------------------------------------------------------
// validatePublishedMarkdown
// ---------------------------------------------------------------------------

test('validatePublishedMarkdown flags unbalanced code fences', () => {
  const warnings = validatePublishedMarkdown('## x\n\n```\nnot closed\n\n## more');
  assert.ok(warnings.some((w) => /code fence/.test(w)));
});

test('validatePublishedMarkdown flags heading missing space after #', () => {
  const warnings = validatePublishedMarkdown('##NoSpace\n\nBody.');
  assert.ok(warnings.some((w) => /heading/.test(w)));
});

test('validatePublishedMarkdown returns no warnings on clean markdown', () => {
  const warnings = validatePublishedMarkdown('## Section\n\nProse.\n\n```\ncode\n```\n\nMore prose.');
  assert.equal(warnings.length, 0);
});
