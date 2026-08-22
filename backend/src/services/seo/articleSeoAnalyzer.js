// Deterministic article SEO analyzer.
//
// Input contract:
//   {
//     keyword: string,
//     title: string,
//     slug: string,
//     metaDescription: string,
//     markdown: string,
//     tags: string[],
//     images: [{ url, alt, isHero? }, ...],   // hero can also come via heroImage
//     heroImage: string | null,               // convenience: url of the hero
//     heroAlt: string | null,                 // convenience: alt for hero
//     knownInternalUrls: string[],            // absolute or path-prefixed URLs
//                                             // of the customer's own site
//     internalHostnames: string[],            // ['www.spotless.homes'] etc.
//   }
//
// Output: see `analyze()` return shape at bottom of file. All checks are
// dependency-free — safe to call on every keystroke behind a debounce.
//
// The analyzer never calls an LLM. We ask the model to write; we verify
// deterministically here.

const {
  SEO_ANALYZER_VERSION,
  CATEGORIES,
  THRESHOLDS,
  RULES,
  CRITICAL_RULE_IDS,
  scoreToStatus,
} = require('./articleSeoRules');
const u = require('./textUtils');

// ---------------------------------------------------------------------------
// Small helpers used across checks
// ---------------------------------------------------------------------------

function pass(label, value, extra) {
  return { status: 'passed', label, value: value || null, recommendation: null, ...extra };
}
function warn(label, value, recommendation, extra) {
  return { status: 'warning', label, value: value || null, recommendation, ...extra };
}
function fail(label, value, recommendation, extra) {
  return { status: 'failed', label, value: value || null, recommendation, ...extra };
}
function na(label, reason) {
  return { status: 'not_applicable', label, value: null, recommendation: reason || null };
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}
function isRootRelative(url) {
  return /^\//.test(url || '');
}

function classifyLink(link, internalHostnames = []) {
  const u = (link.url || '').trim();
  if (!u) return 'invalid';
  if (u.startsWith('#')) return 'anchor';
  if (u.startsWith('mailto:') || u.startsWith('tel:')) return 'contact';
  if (isRootRelative(u)) return 'internal';
  if (isHttpUrl(u)) {
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.toLowerCase();
      const internal = (internalHostnames || []).some((h) => {
        const hh = String(h || '').toLowerCase().replace(/^www\./, '');
        return host === h.toLowerCase() || host.endsWith('.' + hh) || host === hh || host === 'www.' + hh;
      });
      return internal ? 'internal' : 'external';
    } catch {
      return 'invalid';
    }
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Individual check evaluators.
// Each returns a { status, label, value, recommendation, ...extra }.
// ---------------------------------------------------------------------------

const evaluators = {
  // ============ Meta & Technical ============
  title_present({ title }) {
    if (!title || !title.trim()) return fail('Title present', 'missing', 'Add a page title.');
    return pass('Title present', `${title.trim().length} chars`);
  },

  title_length({ title }) {
    const len = (title || '').trim().length;
    const t = THRESHOLDS.title;
    if (!len) return na('Title length', 'no title yet');
    if (len >= t.idealMin && len <= t.idealMax) {
      return pass('Title length', `${len} characters — optimal`);
    }
    if (len < t.warnMin || len > t.warnMax) {
      return fail('Title length', `${len} characters`, `Aim for ${t.idealMin}–${t.idealMax} characters.`);
    }
    return warn('Title length', `${len} characters`, `Aim for ${t.idealMin}–${t.idealMax} characters — outside the ideal range may truncate in Google.`);
  },

  meta_description_present({ metaDescription }) {
    if (!metaDescription || !metaDescription.trim()) {
      return fail('Meta description present', 'missing', 'Add a meta description.');
    }
    return pass('Meta description present');
  },

  meta_description_length({ metaDescription }) {
    const len = (metaDescription || '').trim().length;
    const t = THRESHOLDS.metaDescription;
    if (!len) return na('Meta description length', 'no meta description yet');
    if (len >= t.idealMin && len <= t.idealMax) {
      return pass('Meta description length', `${len} characters — optimal`);
    }
    if (len < t.warnMin || len > t.warnMax) {
      return fail('Meta description length', `${len} characters`, `Aim for ${t.idealMin}–${t.idealMax} characters.`);
    }
    return warn('Meta description length', `${len} characters`, `Recommended ${t.idealMin}–${t.idealMax} characters.`);
  },

  slug_present({ slug }) {
    if (!slug || !slug.trim()) return fail('Slug present', 'missing', 'Add a URL slug.');
    return pass('Slug present', `${slug.length} chars`);
  },

  slug_seo_friendly({ slug }) {
    if (!slug) return na('SEO-friendly slug', 'no slug yet');
    const s = String(slug);
    const issues = [];
    if (s !== s.toLowerCase()) issues.push('has uppercase letters');
    if (/_/.test(s)) issues.push('uses underscores (prefer hyphens)');
    if (/\s/.test(s)) issues.push('contains whitespace');
    if (/[^a-z0-9-/]/i.test(s)) issues.push('contains special characters');
    if (/--/.test(s)) issues.push('has consecutive hyphens');
    if (s.length > THRESHOLDS.slug.maxLength) issues.push(`too long (${s.length} chars, max ${THRESHOLDS.slug.maxLength})`);
    if (issues.length) return warn('SEO-friendly slug', s, `Slug ${issues.join('; ')}.`);
    return pass('SEO-friendly slug', s);
  },

  tags_configured({ tags }) {
    const n = Array.isArray(tags) ? tags.filter(Boolean).length : 0;
    const t = THRESHOLDS.tags;
    if (n === 0) return warn('Tags configured', '0 tags', `Add ${t.idealMin}–${t.idealMax} descriptive tags.`);
    if (n < t.idealMin) return warn('Tags configured', `${n} tags`, `Add a few more (target ${t.idealMin}–${t.idealMax}).`);
    if (n > t.idealMax) return warn('Tags configured', `${n} tags`, `Trim to ${t.idealMax} focused tags.`);
    return pass('Tags configured', `${n} tags`);
  },

  // ============ Links ============
  internal_links_present({ links, internalHostnames, knownInternalUrls }) {
    const internal = links.filter((l) => classifyLink(l, internalHostnames) === 'internal');
    // If we have no LIST of known internal URLs (not just a hostname), the
    // LLM correctly refused to invent any and there's nothing the user can
    // "fix" without wiring up their sitemap. Mark N/A rather than warn on
    // an infra gap the writer can't fix.
    //
    // `internalHostnames` alone (derived from the connection URL) is only
    // used to CLASSIFY existing links — it isn't a list to link TO.
    const hasKnownUrls = Array.isArray(knownInternalUrls) && knownInternalUrls.length > 0;
    if (!hasKnownUrls && internal.length === 0) {
      return na('Internal links present', 'no known internal URLs configured for this site');
    }
    const t = THRESHOLDS.links;
    if (internal.length === 0) return warn('Internal links present', '0 internal links', 'Add 2–6 relevant internal links.');
    if (internal.length < t.idealMinInternal) return warn('Internal links present', `${internal.length} internal link${internal.length === 1 ? '' : 's'}`, `Aim for ${t.idealMinInternal}–${t.idealMaxInternal}.`);
    if (internal.length > t.idealMaxInternal) return warn('Internal links present', `${internal.length} internal links`, `Consider trimming — over ${t.idealMaxInternal} can dilute link equity.`);
    return pass('Internal links present', `${internal.length} internal link${internal.length === 1 ? '' : 's'}`);
  },

  descriptive_anchor_text({ links, internalHostnames }) {
    const eligible = links.filter((l) => {
      const kind = classifyLink(l, internalHostnames);
      return kind === 'internal' || kind === 'external';
    });
    if (eligible.length === 0) return na('Descriptive anchor text', 'no eligible links');
    const generic = eligible.filter((l) => {
      const t = (l.text || '').toLowerCase().trim();
      return THRESHOLDS.links.genericAnchors.includes(t);
    });
    if (generic.length === 0) return pass('Descriptive anchor text', `${eligible.length} link${eligible.length === 1 ? '' : 's'}`);
    return fail('Descriptive anchor text', `${generic.length} generic anchor${generic.length === 1 ? '' : 's'}`, `Replace generic anchors like "${generic[0].text}" with descriptive text.`);
  },

  external_links_present({ links, internalHostnames, searchIntent, plainText }) {
    const ext = links.filter((l) => classifyLink(l, internalHostnames) === 'external');
    if (ext.length === 0) {
      // Don't force links just to satisfy a checkbox. Skip the warning when:
      //   - Topic is conversational / opinion / news — external references
      //     aren't the point of that article type
      //   - Article is under ~1000 words — short focused articles typically
      //     don't need external citations; forcing one hurts more than it
      //     helps (see also the "reader resources, not citations" prompt
      //     framing)
      const intentNa = /opinion|announcement|update|news/i.test(String(searchIntent || ''));
      if (intentNa) return na('External links present', 'external references not required for this article type');
      const wc = u.countWords(plainText);
      if (wc > 0 && wc < 1000) return na('External links present', `short article (${wc} words) — external references optional`);
      return warn('External links present', '0 external links', 'Consider linking to 1–2 authoritative sources.');
    }
    return pass('External links present', `${ext.length} external link${ext.length === 1 ? '' : 's'}`);
  },

  // Only meaningful when the pipeline actually ran the verifier — the
  // analyzer is otherwise stateless and can't verify network reachability
  // on its own. On existing-article analysis (no verification run), this
  // rule returns N/A.
  external_links_verified({ links, internalHostnames, externalLinkVerification }) {
    const ext = links.filter((l) => classifyLink(l, internalHostnames) === 'external');
    if (ext.length === 0) return na('External links verified', 'no external links to verify');
    if (!externalLinkVerification || typeof externalLinkVerification.total !== 'number') {
      return na('External links verified', 'not verified in this pass');
    }
    const { total, verified, dead } = externalLinkVerification;
    if (dead > 0) {
      return warn('External links verified', `${verified}/${total} verified — ${dead} dead removed`, 'A dead link was stripped from the article body. The AI can try adding a replacement citation in the next repair pass.');
    }
    if (verified === total && total > 0) return pass('External links verified', `${verified}/${total} verified`);
    return warn('External links verified', `${verified}/${total} verified`, 'Some external links could not be verified.');
  },

  no_broken_markdown_links({ links }) {
    const broken = links.filter((l) => l.isMalformed);
    if (broken.length === 0) return pass('No broken markdown links');
    return fail('No broken markdown links', `${broken.length} malformed`, 'Fix links with empty text or empty/invalid URLs.');
  },

  anchor_diversity({ links, internalHostnames }) {
    const eligible = links.filter((l) => {
      const kind = classifyLink(l, internalHostnames);
      return (kind === 'internal' || kind === 'external') && l.text;
    });
    if (eligible.length < 3) return na('Anchor text diversity', 'not enough links to evaluate');
    const counts = new Map();
    for (const l of eligible) {
      const k = l.text.toLowerCase().trim();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const repeated = [...counts.entries()].filter(([, n]) => n > 1);
    if (repeated.length === 0) return pass('Anchor text diversity', `${eligible.length} unique anchors`);
    const worst = repeated.sort((a, b) => b[1] - a[1])[0];
    return warn('Anchor text diversity', `"${worst[0]}" used ${worst[1]}×`, 'Vary anchor text — repeating the same phrase looks unnatural.');
  },

  // ============ Media & Visuals ============
  hero_image_present({ heroImage, images }) {
    const hero = heroImage || (images.find((i) => i.isHero) || {}).url;
    if (!hero) return fail('Hero image present', 'no hero image', 'Add a featured/hero image.');
    return pass('Hero image present');
  },

  hero_alt_present({ heroImage, heroAlt, images }) {
    const hero = heroImage || (images.find((i) => i.isHero) || {}).url;
    if (!hero) return na('Hero image alt text', 'no hero image');
    const alt = (heroAlt || (images.find((i) => i.isHero) || {}).alt || '').trim();
    if (!alt) return fail('Hero image alt text', 'missing', 'Describe the hero image in alt text.');
    return pass('Hero image alt text', `${alt.length} chars`);
  },

  hero_alt_quality({ heroImage, heroAlt, images }) {
    const hero = heroImage || (images.find((i) => i.isHero) || {}).url;
    if (!hero) return na('Hero alt quality', 'no hero image');
    const alt = (heroAlt || (images.find((i) => i.isHero) || {}).alt || '').trim();
    if (!alt) return na('Hero alt quality', 'no alt text yet');
    const generic = THRESHOLDS.media.genericAlts.includes(alt.toLowerCase());
    if (generic) return warn('Hero alt quality', `"${alt}"`, 'Describe the actual content of the image.');
    if (alt.length < THRESHOLDS.media.heroAltMinChars) return warn('Hero alt quality', `${alt.length} chars`, 'Alt text is very short — describe the scene.');
    return pass('Hero alt quality', `"${alt.slice(0, 60)}${alt.length > 60 ? '…' : ''}"`);
  },

  image_alt_coverage({ images }) {
    if (!images || images.length === 0) return na('All images have alt text', 'no images');
    const missing = images.filter((i) => !(i.alt || '').trim());
    if (missing.length === 0) return pass('All images have alt text', `${images.length} image${images.length === 1 ? '' : 's'}`);
    return fail('All images have alt text', `${missing.length}/${images.length} missing alt`, 'Add alt text to every image.');
  },

  keyword_in_image_alt({ keyword, images }) {
    if (!keyword || !images || images.length === 0) return na('Keyword in image alt', 'no keyword or images');
    const withAlt = images.filter((i) => (i.alt || '').trim());
    if (withAlt.length === 0) return na('Keyword in image alt', 'no alt text to check');
    const hit = withAlt.some((i) => u.containsKeywordSemantic(i.alt, keyword));
    if (hit) return pass('Keyword in image alt', 'appears in at least one alt');
    return warn('Keyword in image alt', 'not present', 'Include the target keyword in one image alt where it fits naturally.');
  },

  // ============ Content Quality ============
  word_count({ plainText }) {
    const n = u.countWords(plainText);
    const t = THRESHOLDS.wordCount;
    if (n === 0) return fail('Article length', '0 words', 'Write the article body.');
    if (n < t.hardFloor) return fail('Article length', `${n} words`, `Very thin content — target ${t.idealMin}–${t.idealMax}.`);
    if (n < t.warnMin) return warn('Article length', `${n} words`, `Under ${t.warnMin} words — consider expanding useful sections.`);
    if (n > t.warnMax) return warn('Article length', `${n} words`, `Over ${t.warnMax} words — check for padding.`);
    if (n >= t.idealMin && n <= t.idealMax) return pass('Article length', `${n} words`);
    return pass('Article length', `${n} words`);
  },

  paragraph_length({ paragraphs }) {
    if (paragraphs.length === 0) return na('Average paragraph length', 'no paragraphs yet');
    const counts = paragraphs.map((p) => u.countWords(p));
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const rounded = Math.round(avg);
    if (avg > THRESHOLDS.paragraph.warnAvgWords) {
      return warn('Average paragraph length', `${rounded} words avg`, 'Break long paragraphs into shorter ones for readability.');
    }
    return pass('Average paragraph length', `${rounded} words avg`);
  },

  no_wall_of_text({ paragraphs }) {
    if (paragraphs.length === 0) return na('No wall-of-text paragraphs', 'no paragraphs yet');
    const longest = paragraphs.map((p) => u.countWords(p)).sort((a, b) => b - a)[0];
    if (longest > THRESHOLDS.paragraph.wallOfTextWords) {
      return warn('No wall-of-text paragraphs', `longest: ${longest} words`, `Split any paragraph over ${THRESHOLDS.paragraph.wallOfTextWords} words.`);
    }
    return pass('No wall-of-text paragraphs', `longest: ${longest} words`);
  },

  heading_hierarchy({ headings }) {
    if (headings.length === 0) return warn('Logical heading hierarchy', 'no headings', 'Add H2/H3 headings to structure the article.');
    // The article title is the H1; the markdown body itself should start with
    // H2 and never skip a level.
    const h1s = headings.filter((h) => h.level === 1);
    if (h1s.length > 0) {
      return warn('Logical heading hierarchy', `${h1s.length} H1 in body`, 'The article title is the H1 — the body should start with H2.');
    }
    let skipped = false;
    for (let i = 1; i < headings.length; i++) {
      if (headings[i].level > headings[i - 1].level + 1) {
        skipped = true;
        break;
      }
    }
    if (skipped) return warn('Logical heading hierarchy', 'level skipped', 'Do not skip heading levels (H2 → H4).');
    return pass('Logical heading hierarchy', `${headings.length} headings`);
  },

  h2_count({ headings }) {
    const h2 = headings.filter((h) => h.level === 2).length;
    if (h2 === 0) return warn('Enough H2 sections', '0 H2s', 'Add H2 sections to structure the article.');
    if (h2 < THRESHOLDS.headings.minH2) return warn('Enough H2 sections', `${h2} H2s`, `Aim for at least ${THRESHOLDS.headings.minH2} H2 sections.`);
    return pass('Enough H2 sections', `${h2} H2s`);
  },

  unique_headings({ headings }) {
    if (headings.length === 0) return na('Unique headings', 'no headings');
    const seen = new Map();
    for (const h of headings) {
      const k = h.text.toLowerCase().trim();
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const dups = [...seen.entries()].filter(([, n]) => n > 1);
    if (dups.length === 0) return pass('Unique headings', `${headings.length} headings`);
    return warn('Unique headings', `${dups.length} duplicate${dups.length === 1 ? '' : 's'}`, `Reword duplicate heading "${dups[0][0]}".`);
  },

  lists_present({ markdown }) {
    if (!markdown) return na('Uses lists where useful', 'no content');
    const hasList = /(^|\n)\s{0,3}([-*+]|\d+\.)\s+/.test(markdown);
    if (hasList) return pass('Uses lists where useful');
    return warn('Uses lists where useful', 'no lists', 'Use bullet or numbered lists where they aid scanning.');
  },

  faq_present({ markdown, searchIntent }) {
    const { present, count } = u.detectFaq(markdown);
    // FAQ isn't right for every article — treat as N/A unless the topic
    // signals it, or the article already includes one.
    const isQaIntent = searchIntent
      ? /faq|question|q\s*&\s*a|qna/i.test(String(searchIntent))
      : false;
    if (!present && !isQaIntent) return na('FAQ section', 'not needed for this article');
    if (!present) return warn('FAQ section', 'missing', 'Consider adding an FAQ — the topic looks Q&A-shaped.');
    if (count < 2) return warn('FAQ section', `${count} question`, 'Add a couple more common questions.');
    return pass('FAQ section', `${count} questions`);
  },

  intro_present({ intro }) {
    const n = u.countWords(intro);
    if (n === 0) return fail('Introduction present', 'missing', 'Add an introduction before the first H2.');
    if (n < 40) return warn('Introduction present', `${n} words`, 'Expand the intro to at least 40–80 words.');
    return pass('Introduction present', `${n} words`);
  },

  conclusion_present({ markdown }) {
    const { present } = u.detectConclusion(markdown);
    if (present) return pass('Conclusion / takeaways');
    return warn('Conclusion / takeaways', 'not detected', 'Add a "Conclusion" or "Key takeaways" section near the end.');
  },

  clean_markdown({ markdown }) {
    if (!markdown) return na('Clean markdown', 'no content');
    const issues = [];
    // #Heading (no space) is a common mistake — the renderer treats it as prose.
    if (/^#{1,6}[^#\s]/m.test(markdown)) issues.push('missing space after # in a heading');
    // Unclosed code fence.
    const fenceCount = (markdown.match(/^```/gm) || []).length;
    if (fenceCount % 2 !== 0) issues.push('unbalanced code fence');
    // Orphan reference-style link.
    if (/\]\[\]/.test(markdown)) issues.push('empty reference-style link');
    if (issues.length === 0) return pass('Clean markdown');
    return fail('Clean markdown', `${issues.length} issue${issues.length === 1 ? '' : 's'}`, issues.join('; ') + '.');
  },

  // ============ Search Term Optimization ============
  keyword_in_title({ keyword, title }) {
    if (!keyword) return na('Keyword in title', 'no keyword');
    // Semantic match: for long-tail keywords like "ann russell how to clean
    // everything" the natural title ("Ann Russell's Guide: How to Clean
    // Everything Effectively") uses every meaningful token in proximity but
    // isn't the literal phrase. Google treats these the same; the analyzer
    // should too.
    if (u.containsKeywordSemantic(title, keyword)) return pass('Keyword in title');
    return fail('Keyword in title', 'not present', 'Work the target keyword into the title.');
  },

  keyword_in_meta_description({ keyword, metaDescription }) {
    if (!keyword) return na('Keyword in meta description', 'no keyword');
    if (!metaDescription) return na('Keyword in meta description', 'no meta description');
    if (u.containsKeywordSemantic(metaDescription, keyword)) return pass('Keyword in meta description');
    return warn('Keyword in meta description', 'not present', 'Include the target keyword naturally in the meta description.');
  },

  keyword_in_slug({ keyword, slug }) {
    if (!keyword) return na('Keyword in slug', 'no keyword');
    if (!slug) return na('Keyword in slug', 'no slug');
    const slugTokens = new Set(u.tokenize(slug));
    const kwTokens = u.tokenize(keyword);
    if (kwTokens.length === 0) return na('Keyword in slug', 'keyword has no tokens');
    const hits = kwTokens.filter((t) => slugTokens.has(t)).length;
    const ratio = hits / kwTokens.length;
    if (ratio >= 0.5) return pass('Keyword in slug', `${hits}/${kwTokens.length} tokens`);
    return warn('Keyword in slug', `${hits}/${kwTokens.length} tokens`, 'Include the main keyword tokens in the slug.');
  },

  keyword_in_intro({ keyword, intro }) {
    if (!keyword) return na('Keyword in introduction', 'no keyword');
    if (!intro) return warn('Keyword in introduction', 'no intro', 'Add an introduction that includes the keyword.');
    if (u.containsKeywordSemantic(intro, keyword)) return pass('Keyword in introduction');
    return warn('Keyword in introduction', 'not present', 'Mention the keyword naturally in the first paragraph.');
  },

  keyword_in_heading({ keyword, headings }) {
    if (!keyword) return na('Keyword in a heading', 'no keyword');
    if (headings.length === 0) return warn('Keyword in a heading', 'no headings', 'Add H2/H3 sections including the keyword where natural.');
    // Ideal: a heading contains the full semantic keyword (all required
    // tokens in proximity). But for long-tail queries a full match is
    // unnatural — accept ≥ 50% token overlap in any single heading too.
    const fullHit = headings.some((h) => u.containsKeywordSemantic(h.text, keyword));
    if (fullHit) return pass('Keyword in a heading');
    const partialHit = headings.some((h) => u.keywordOverlapRatio(h.text, keyword) >= 0.5);
    if (partialHit) return pass('Keyword in a heading', 'partial keyword coverage across headings');
    return warn('Keyword in a heading', 'not present', 'Include the keyword (or key tokens from it) in at least one H2 or H3.');
  },

  keyword_density({ keyword, plainText }) {
    if (!keyword) return na('Keyword usage', 'no keyword');
    const words = u.countWords(plainText);
    if (words === 0) return na('Keyword usage', 'no article body');
    // Count both exact-phrase and semantic hits. Semantic hits use a
    // proximity window so an article that says "Ann Russell's guide … clean
    // everything" for a long-tail keyword still gets credit even when the
    // literal phrase never appears. Take the max so short-tail keywords
    // (single words) still work under the classic exact-count logic.
    const exact = u.countKeywordOccurrences(plainText, keyword);
    const semantic = u.countKeywordSemanticHits(plainText, keyword);
    const count = Math.max(exact, semantic);
    // Density is `count / words` — use the effective count (semantic when
    // it's higher). Previously used exact/words which under-counted
    // long-tail keywords: an article that mentions "apartment cleaning" +
    // "tampa" 3 times in proximity but the literal phrase only once would
    // show "3× (0.18%)" — count from semantic, density from exact.
    // Stuffing detection still uses exact-only density since padding
    // repeat literal phrases is the actual stuffing signal.
    const effectiveDensity = count / words;
    const exactDensity = exact / words;
    const t = THRESHOLDS.keyword;
    const pct = (effectiveDensity * 100).toFixed(2) + '%';
    if (exactDensity >= t.stuffingDensity) {
      return fail('Keyword usage', `${exact}× exact (${pct})`, 'Keyword density is unnaturally high — reduce repetition.');
    }
    if (count < t.minOccurrences) {
      return warn('Keyword usage', `${count}×`, `Use the keyword at least ${t.minOccurrences} times naturally.`);
    }
    if (effectiveDensity < t.idealMinDensity) {
      return warn('Keyword usage', `${count}× (${pct})`, 'A little light — mention the keyword a few more times where natural.');
    }
    if (effectiveDensity > t.idealMaxDensity) {
      return warn('Keyword usage', `${count}× (${pct})`, 'Slightly dense — trim a couple mentions.');
    }
    return pass('Keyword usage', `${count}× — natural usage`);
  },

  keyword_placement_distribution({ keyword, intro, conclusionText, plainText }) {
    if (!keyword) return na('Keyword placement across article', 'no keyword');
    if (!plainText) return na('Keyword placement across article', 'no article body');
    // Semantic checks — "keyword present" here means "topic clearly covered
    // in this region," not "exact phrase appears verbatim."
    const totalSemantic = u.countKeywordSemanticHits(plainText, keyword);
    if (totalSemantic === 0) return warn('Keyword placement across article', 'not present', 'Include the keyword through the article.');
    const introHit = u.containsKeywordSemantic(intro, keyword);
    const concHit = u.containsKeywordSemantic(conclusionText, keyword);
    if (introHit && concHit) return pass('Keyword placement across article', 'intro + body + conclusion');
    if (!introHit && !concHit) return warn('Keyword placement across article', 'body only', 'Include the keyword in both the intro and conclusion for even placement.');
    if (!introHit) return warn('Keyword placement across article', 'missing from intro', 'Include the keyword in the introduction.');
    return warn('Keyword placement across article', 'missing from conclusion', 'Include the keyword in the conclusion or takeaways.');
  },
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function analyze(input) {
  const {
    keyword = '',
    title = '',
    slug = '',
    metaDescription = '',
    markdown = '',
    tags = [],
    images = [],
    heroImage = null,
    heroAlt = null,
    knownInternalUrls = [],
    internalHostnames = [],
    searchIntent = '',
    // Set by the pipeline when it runs the external-link verifier before
    // analysis. Existing-article analysis (routes/blogs.js#/seo-analyze)
    // leaves these null → the `external_links_verified` check returns N/A.
    externalLinkVerification = null,
    verifiedExternalLinks = null,
  } = input || {};

  // Pre-compute derived structures once and pass them to evaluators — avoids
  // re-parsing the markdown 30+ times.
  const plainText = u.markdownToPlainText(markdown);
  const paragraphs = u.extractParagraphs(markdown);
  const headings = u.extractHeadings(markdown);
  const links = u.extractLinks(markdown);
  const bodyImages = u.extractImages(markdown);
  const heroFromInput = heroImage
    ? [{ url: heroImage, alt: heroAlt || '', isHero: true, source: 'input' }]
    : [];
  // Dedupe hero if it's also in the body markdown.
  const allImages = [
    ...heroFromInput,
    ...bodyImages.filter((i) => !heroImage || i.url !== heroImage),
    // Accept an explicit images array too (used by tests / non-markdown flows).
    ...(images || []).filter((i) => i && i.url && (!heroImage || i.url !== heroImage)),
  ];
  const intro = u.extractIntro(markdown);
  const conclusionText = u.extractConclusionText(markdown);

  const ctx = {
    keyword, title, slug, metaDescription, markdown, tags,
    images: allImages, heroImage, heroAlt,
    knownInternalUrls, internalHostnames, searchIntent,
    plainText, paragraphs, headings, links, intro, conclusionText,
    externalLinkVerification, verifiedExternalLinks,
  };

  let passed = 0;
  let warnings = 0;
  let failed = 0;
  let notApplicable = 0;
  let criticalFailures = 0;
  let scoreNumerator = 0;
  let scoreDenominator = 0;

  const checks = RULES.map((rule) => {
    const fn = evaluators[rule.id];
    if (!fn) {
      return {
        id: rule.id,
        category: rule.category,
        categoryLabel: CATEGORIES[rule.category],
        label: rule.label,
        weight: rule.weight,
        status: 'not_applicable',
        value: null,
        recommendation: 'no evaluator registered',
      };
    }
    let result;
    try {
      result = fn(ctx) || na(rule.label, 'evaluator returned nothing');
    } catch (err) {
      result = fail(rule.label, 'evaluator error', String(err?.message || err));
    }
    const status = result.status;
    switch (status) {
      case 'passed': passed++; scoreNumerator += rule.weight; scoreDenominator += rule.weight; break;
      case 'warning':
        warnings++;
        // Warnings count as half-credit toward the score.
        scoreNumerator += rule.weight * 0.5;
        scoreDenominator += rule.weight;
        break;
      case 'failed':
        failed++;
        scoreDenominator += rule.weight;
        if (CRITICAL_RULE_IDS.has(rule.id)) criticalFailures++;
        break;
      case 'not_applicable':
      default:
        notApplicable++;
        break;
    }
    return {
      id: rule.id,
      category: rule.category,
      categoryLabel: CATEGORIES[rule.category],
      label: result.label || rule.label,
      weight: rule.weight,
      status,
      value: result.value ?? null,
      recommendation: result.recommendation ?? null,
    };
  });

  const score = scoreDenominator === 0 ? 0 : Math.round((scoreNumerator / scoreDenominator) * 100);
  const status = scoreToStatus({ score, criticalFailures });
  const wordCount = u.countWords(plainText);

  return {
    analyzerVersion: SEO_ANALYZER_VERSION,
    analyzedAt: new Date().toISOString(),
    contentHash: u.contentHash({ keyword, title, slug, metaDescription, markdown, tags, images: allImages }),
    keyword: keyword || null,
    wordCount,
    score,
    status,        // 'green' | 'yellow' | 'red'
    passed,
    warnings,
    failed,
    notApplicable,
    criticalFailures,
    checks,
  };
}

// Group checks by category for the drawer UI.
function groupByCategory(checks) {
  const groups = {};
  for (const c of checks) {
    const key = c.category;
    if (!groups[key]) {
      groups[key] = {
        id: key,
        label: CATEGORIES[key] || key,
        passed: 0, warnings: 0, failed: 0, notApplicable: 0,
        checks: [],
      };
    }
    const g = groups[key];
    g.checks.push(c);
    if (c.status === 'passed') g.passed++;
    else if (c.status === 'warning') g.warnings++;
    else if (c.status === 'failed') g.failed++;
    else g.notApplicable++;
  }
  return Object.values(groups);
}

module.exports = {
  analyze,
  groupByCategory,
  SEO_ANALYZER_VERSION,
  // exported for tests
  _internal: { evaluators, classifyLink },
};
