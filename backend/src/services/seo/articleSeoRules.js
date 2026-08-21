// Canonical SEO rule definitions and thresholds.
//
// Every knob the analyzer uses lives in this file so criteria can be tuned in
// one place. Bump SEO_ANALYZER_VERSION whenever a change in this file could
// make a previously-computed analysis wrong — the version travels in the
// seo_metadata JSONB so we can detect stale results and re-run.
//
// Categories match the checklist UI:
//   meta     — Meta & Technical
//   links    — Links
//   media    — Media & Visuals
//   content  — Content Quality
//   keyword  — Search Term Optimization
//
// Weights let some checks matter more than others in the overall score:
//   3 = critical (missing title, meta description, hero image, keyword stuffing)
//   2 = standard (most rules)
//   1 = nice-to-have (external links, image-alt keyword, tags)

const SEO_ANALYZER_VERSION = 1;

const CATEGORIES = {
  meta: 'Meta & Technical',
  links: 'Links',
  media: 'Media & Visuals',
  content: 'Content Quality',
  keyword: 'Search Term Optimization',
};

const THRESHOLDS = {
  title: {
    idealMin: 45,
    idealMax: 65,
    warnMin: 30,
    warnMax: 75,
  },
  metaDescription: {
    idealMin: 140,
    idealMax: 160,
    warnMin: 110,
    warnMax: 180,
  },
  slug: {
    maxLength: 75, // long slugs get truncated in SERPs and shared cards
  },
  tags: {
    idealMin: 3,
    idealMax: 8,
  },
  wordCount: {
    idealMin: 1500,
    idealMax: 2500,
    warnMin: 800,
    warnMax: 4000,
    hardFloor: 400,   // below this, the article is genuinely thin
  },
  paragraph: {
    warnAvgWords: 120,     // average paragraph length
    wallOfTextWords: 250,  // any single paragraph over this is a wall
  },
  headings: {
    minH2: 3,
  },
  keyword: {
    minOccurrences: 3,
    idealMinDensity: 0.005, // 0.5%
    idealMaxDensity: 0.025, // 2.5%
    stuffingDensity: 0.04,  // 4%+ is stuffing → fail
  },
  links: {
    idealMinInternal: 2,
    idealMaxInternal: 8,
    // Anchors we always flag as non-descriptive.
    genericAnchors: [
      'click here', 'here', 'read more', 'learn more', 'this', 'this article',
      'this page', 'this link', 'link', 'more', 'this post',
    ],
  },
  media: {
    heroAltMinChars: 10,
    // "Photo of a house" is fine; "image", "photo" alone is not.
    genericAlts: ['image', 'photo', 'picture', 'img', 'hero', 'featured image'],
  },
};

// The complete rule catalog. Each rule declares:
//   id, category, label, weight, evaluator (function name in the analyzer)
// Whether a rule fires as N/A vs a real status is decided in the evaluator
// itself — see articleSeoAnalyzer.js.
const RULES = [
  // --- Meta & Technical ------------------------------------------------
  { id: 'title_present',            category: 'meta',    label: 'Title present',            weight: 3 },
  { id: 'title_length',             category: 'meta',    label: 'Title length',             weight: 2 },
  { id: 'meta_description_present', category: 'meta',    label: 'Meta description present', weight: 3 },
  { id: 'meta_description_length',  category: 'meta',    label: 'Meta description length',  weight: 2 },
  { id: 'slug_present',             category: 'meta',    label: 'Slug present',             weight: 3 },
  { id: 'slug_seo_friendly',        category: 'meta',    label: 'SEO-friendly slug',        weight: 2 },
  { id: 'tags_configured',          category: 'meta',    label: 'Tags configured',          weight: 1 },

  // --- Links -----------------------------------------------------------
  { id: 'internal_links_present',   category: 'links',   label: 'Internal links present',   weight: 2 },
  { id: 'descriptive_anchor_text',  category: 'links',   label: 'Descriptive anchor text',  weight: 2 },
  { id: 'external_links_present',   category: 'links',   label: 'External links present',   weight: 1 },
  { id: 'external_links_verified',  category: 'links',   label: 'External links verified',  weight: 2 },
  { id: 'no_broken_markdown_links', category: 'links',   label: 'No broken markdown links', weight: 2 },
  { id: 'anchor_diversity',         category: 'links',   label: 'Anchor text diversity',    weight: 1 },

  // --- Media & Visuals -------------------------------------------------
  { id: 'hero_image_present',       category: 'media',   label: 'Hero image present',       weight: 3 },
  { id: 'hero_alt_present',         category: 'media',   label: 'Hero image alt text',      weight: 2 },
  { id: 'hero_alt_quality',         category: 'media',   label: 'Hero alt quality',         weight: 1 },
  { id: 'image_alt_coverage',       category: 'media',   label: 'All images have alt text', weight: 2 },
  { id: 'keyword_in_image_alt',     category: 'media',   label: 'Keyword in image alt',     weight: 1 },

  // --- Content Quality -------------------------------------------------
  { id: 'word_count',               category: 'content', label: 'Article length',           weight: 2 },
  { id: 'paragraph_length',         category: 'content', label: 'Average paragraph length', weight: 1 },
  { id: 'no_wall_of_text',          category: 'content', label: 'No wall-of-text paragraphs', weight: 2 },
  { id: 'heading_hierarchy',        category: 'content', label: 'Logical heading hierarchy', weight: 2 },
  { id: 'h2_count',                 category: 'content', label: 'Enough H2 sections',        weight: 1 },
  { id: 'unique_headings',          category: 'content', label: 'Unique headings',          weight: 1 },
  { id: 'lists_present',            category: 'content', label: 'Uses lists where useful',  weight: 1 },
  { id: 'faq_present',              category: 'content', label: 'FAQ section',              weight: 1 },
  { id: 'intro_present',            category: 'content', label: 'Introduction present',     weight: 2 },
  { id: 'conclusion_present',       category: 'content', label: 'Conclusion / takeaways',   weight: 1 },
  { id: 'clean_markdown',           category: 'content', label: 'Clean markdown',           weight: 3 },

  // --- Search Term Optimization ---------------------------------------
  { id: 'keyword_in_title',         category: 'keyword', label: 'Keyword in title',         weight: 3 },
  { id: 'keyword_in_meta_description', category: 'keyword', label: 'Keyword in meta description', weight: 2 },
  { id: 'keyword_in_slug',          category: 'keyword', label: 'Keyword in slug',          weight: 2 },
  { id: 'keyword_in_intro',         category: 'keyword', label: 'Keyword in introduction',  weight: 2 },
  { id: 'keyword_in_heading',       category: 'keyword', label: 'Keyword in a heading',     weight: 2 },
  { id: 'keyword_density',          category: 'keyword', label: 'Keyword usage',            weight: 2 },
  { id: 'keyword_placement_distribution', category: 'keyword', label: 'Keyword placement across article', weight: 1 },
];

// A rule is "critical" when a failure is a hard problem worth flagging red.
// Used by scoreToStatus.
const CRITICAL_RULE_IDS = new Set([
  'title_present',
  'meta_description_present',
  'slug_present',
  'hero_image_present',
  'image_alt_coverage',
  'keyword_in_title',
  'keyword_density',      // catches stuffing
  'clean_markdown',
]);

// Green/yellow/red for the banner. Uses both the numeric score AND whether any
// critical rule failed so a single critical miss can't be masked by 20 easy
// wins.
function scoreToStatus({ score, criticalFailures }) {
  if (criticalFailures > 0) return 'red';
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  return 'red';
}

module.exports = {
  SEO_ANALYZER_VERSION,
  CATEGORIES,
  THRESHOLDS,
  RULES,
  CRITICAL_RULE_IDS,
  scoreToStatus,
};
