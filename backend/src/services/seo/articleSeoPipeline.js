// SEO-aware article generation orchestrator.
//
// One entry point used by BOTH the manual `/api/ai/articles` route and the
// scheduled `automationExecutor`. Do not duplicate this logic in either
// caller — extend here and the automation path picks it up for free.
//
// Flow:
//   1. Call aiContentService.generateArticle (enhanced prompt, structured JSON).
//   2. Run the deterministic analyzer on the output.
//   3. If the score is low OR any critical rule failed, run ONE bounded
//      repair pass. Never more. Latency + cost stay predictable.
//   4. Re-analyze the repaired article.
//   5. Return { data, analysis, usage, costUsd, model, repairApplied, prompts }.
//
// Rules of engagement:
//   - The LLM is not asked whether the article is SEO-optimized. The analyzer
//     is the sole authority. The LLM only writes and edits.
//   - `knownInternalUrls` gates internal linking. If empty, the prompt tells
//     the model not to invent URLs and the analyzer marks the internal-links
//     check N/A instead of penalising the article.
//   - The repair is skipped when: analyzer says score ≥ 60 AND no critical
//     failures. Subjective warnings do NOT trigger a repair pass.

const aiContent = require('../aiContentService');
const analyzer = require('./articleSeoAnalyzer');
const linkVerifier = require('./externalLinkVerifier');

const REPAIR_TRIGGER = {
  scoreBelow: 60,
  criticalFailures: 1, // any critical rule failing triggers repair
};

// Repair can't attach a hero image — the user does that in the editor. So we
// exclude hero-related checks from the "should we repair?" decision even
// though they still show up in the UI checklist.
const REPAIR_IGNORED_CHECK_IDS = new Set([
  'hero_image_present',
  'hero_alt_present',
  'hero_alt_quality',
  'image_alt_coverage',   // repair can't attach images
  'keyword_in_image_alt',
]);

function buildAnalyzerInput({ generation, input, verifiedExternalLinks = null, externalLinkVerification = null }) {
  return {
    keyword: input.keyword || '',
    title: generation.title || '',
    slug: generation.slug || '',
    metaDescription: generation.metaDescription || '',
    markdown: generation.markdown || '',
    tags: generation.tags || [],
    heroImage: null,     // hero is attached later by the editor / user
    heroAlt: null,
    images: [],
    knownInternalUrls: input.knownInternalUrls || [],
    internalHostnames: input.internalHostnames || [],
    searchIntent: generation.searchIntent || '',
    // Verifier output — enables the `external_links_verified` analyzer
    // check to distinguish "3 external links present" from "3/3 links
    // still alive." When absent, the analyzer treats verification as
    // unknown and skips that check.
    verifiedExternalLinks,
    externalLinkVerification,
  };
}

// Warnings the LLM can objectively fix in a targeted revision — no
// subjective judgment required. When any of these fires, the bounded repair
// pass is worth spending on even though the analyzer marked them as warnings
// rather than failures. Kept focused so we don't turn every subjective
// warning into an automatic rewrite.
const AUTO_REPAIR_WARNING_IDS = new Set([
  'intro_present',              // no intro at all
  'keyword_in_intro',           // intro exists but keyword missing
  'keyword_in_heading',         // no heading contains the keyword
  'keyword_placement_distribution',
  'meta_description_length',    // too short or too long (mostly too short)
  'title_length',               // too short or too long
  'heading_hierarchy',          // level-skip
  'no_broken_markdown_links',
  'word_count',                 // article too short — expand relevant sections
  'external_links_present',     // no authoritative external references
  'keyword_density',            // keyword under-used (warning form only)
]);

function needsRepair(analysis) {
  if (!analysis) return false;
  // Only count *repairable* critical failures — the LLM can't attach a hero
  // image, so ignore hero/image-related checks even if they'd otherwise be
  // critical. This prevents an unwinnable repair loop on missing media.
  const repairableCritical = (analysis.checks || []).filter((c) => {
    if (c.status !== 'failed') return false;
    if (REPAIR_IGNORED_CHECK_IDS.has(c.id)) return false;
    return (c.weight || 0) >= 3;
  }).length;
  if (repairableCritical >= REPAIR_TRIGGER.criticalFailures) return true;

  // Objectively-fixable warnings (missing intro, meta too short, keyword
  // missing from intro/headings, article too short, etc.) trigger the
  // repair. These are not judgment calls — a targeted revision reliably
  // passes them without padding or spam. Cap at 1 pass; the pipeline never
  // loops. Threshold is 1+ (previously 2+) because for a single-warning
  // article the user experience of "already 93 green but still one warning
  // left" is worse than eating one extra LLM call on the initial write.
  const autoFixableWarnings = (analysis.checks || []).filter(
    (c) => c.status === 'warning' && AUTO_REPAIR_WARNING_IDS.has(c.id),
  ).length;
  if (autoFixableWarnings >= 1) return true;

  // Score-based trigger uses the ratio without the hero checks so a
  // pre-hero article isn't repaired purely for missing media.
  const repairableChecks = (analysis.checks || []).filter(
    (c) => !REPAIR_IGNORED_CHECK_IDS.has(c.id) && c.status !== 'not_applicable',
  );
  if (repairableChecks.length > 0) {
    let num = 0, den = 0;
    for (const c of repairableChecks) {
      den += c.weight;
      if (c.status === 'passed') num += c.weight;
      else if (c.status === 'warning') num += c.weight * 0.5;
    }
    const adjustedScore = Math.round((num / den) * 100);
    if (adjustedScore < REPAIR_TRIGGER.scoreBelow) return true;
  }
  return false;
}

// Sum two OpenAI-shaped usage objects (either may be null).
function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
  };
}

// Verify every external link in `markdown` against the allowlist + HTTP
// reachability. Dead links are stripped from the markdown (their anchor
// text is kept). Returns the possibly-mutated markdown + verifier
// telemetry. NEVER throws — verifier failures are caught and treated as
// "0 links verified" so a broken verifier can't fail generation.
//
// Also runs a pre-verification rescue step: any link written as a full
// URL whose PATH matches a known internal URL gets rewritten to a
// relative path first. Fixes the observed prod case where the model
// hallucinated `https://spotlesshomes.com/booking` when the real domain
// is `spotless.homes` and `/booking` was a real internal page — the
// verifier would otherwise strip it as an unknown-domain external link.
async function verifyAndCleanExternalLinks(markdown, { knownInternalUrls = [] } = {}) {
  const empty = { markdown, verification: { total: 0, verified: 0, dead: 0, deadUrls: [], rewritten: 0, durationMs: 0 } };
  if (!markdown) return empty;

  // Rescue "internal links written as full URLs" first.
  const rescued = linkVerifier.rewriteMistakenlyAbsoluteInternalLinks(markdown, knownInternalUrls);
  const rewritten = rescued !== markdown ? 1 : 0;

  const urls = linkVerifier.extractExternalLinksFromMarkdown(rescued);
  if (urls.length === 0) {
    return { ...empty, markdown: rescued, verification: { ...empty.verification, rewritten } };
  }
  const t0 = Date.now();
  try {
    const { results, summary } = await linkVerifier.verifyMany(urls);
    const deadUrls = results.filter((r) => !r.ok).map((r) => r.url);
    const cleaned = deadUrls.length > 0
      ? linkVerifier.stripDeadLinksFromMarkdown(rescued, deadUrls)
      : rescued;
    return {
      markdown: cleaned,
      verification: {
        total: summary.total,
        verified: summary.ok,
        dead: summary.dead,
        deadUrls,
        rewritten,
        durationMs: Date.now() - t0,
      },
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('external-link verification failed:', err.message);
    return {
      ...empty,
      markdown: rescued,
      verification: { ...empty.verification, rewritten, durationMs: Date.now() - t0, error: err.message },
    };
  }
}

async function generateArticleWithSeo(input) {
  const businessName = input.businessName || 'the business';
  const knownInternalUrls = input.knownInternalUrls || [];
  const timing = { generation_ms: 0, external_link_verification_ms: 0, seo_analysis_ms: 0, repair_ms: 0, total_ms: 0 };
  const t_start = Date.now();

  const t_gen = Date.now();
  const initial = await aiContent.generateArticle(input);
  timing.generation_ms = Date.now() - t_gen;

  let currentData = initial.data;

  // External-link verification BEFORE the draft is finalized. Dead links
  // are stripped from the markdown; the prose survives. Runs synchronously
  // but with bounded concurrency + short per-URL timeout so 5 links don't
  // add 5×timeout latency. Verifier failure never throws.
  const initialVerification = await verifyAndCleanExternalLinks(currentData.markdown, { knownInternalUrls });
  currentData = { ...currentData, markdown: initialVerification.markdown };
  timing.external_link_verification_ms = initialVerification.verification.durationMs;
  const verification = initialVerification.verification;

  const t_analysis = Date.now();
  let analysis = analyzer.analyze(buildAnalyzerInput({
    generation: currentData, input,
    verifiedExternalLinks: linkVerifier.extractExternalLinksFromMarkdown(currentData.markdown),
    externalLinkVerification: verification,
  }));
  timing.seo_analysis_ms = Date.now() - t_analysis;

  let repairApplied = false;
  let repairResult = null;
  let repairAnalysis = null;

  if (needsRepair(analysis)) {
    repairApplied = true;
    const t_repair = Date.now();
    try {
      repairResult = await aiContent.repairArticle({
        previousJson: currentData,
        analysis,
        keyword: input.keyword,
        businessName,
        knownInternalUrls,
        model: input.model,
      });
      let repairedData = repairResult.data;
      // The repair pass may have introduced new external links (or reworked
      // existing ones). Verify + clean again before scoring so the analyzer
      // sees the actual final markdown.
      const repairedVerification = await verifyAndCleanExternalLinks(repairedData.markdown, { knownInternalUrls });
      repairedData = { ...repairedData, markdown: repairedVerification.markdown };
      timing.external_link_verification_ms += repairedVerification.verification.durationMs;

      const t_repair_analysis = Date.now();
      const repairedAnalysis = analyzer.analyze(buildAnalyzerInput({
        generation: repairedData, input,
        verifiedExternalLinks: linkVerifier.extractExternalLinksFromMarkdown(repairedData.markdown),
        externalLinkVerification: repairedVerification.verification,
      }));
      timing.seo_analysis_ms += Date.now() - t_repair_analysis;

      // Only accept the repair if it actually improved the score OR reduced
      // critical failures. Otherwise keep the initial draft — this stops the
      // model making things worse by over-editing.
      const better =
        repairedAnalysis.criticalFailures < analysis.criticalFailures ||
        (repairedAnalysis.criticalFailures === analysis.criticalFailures && repairedAnalysis.score >= analysis.score);
      if (better) {
        currentData = repairedData;
        analysis = repairedAnalysis;
      } else {
        repairAnalysis = repairedAnalysis; // for audit
      }
    } catch (err) {
      // Repair failure never fails the whole generation — the initial draft
      // is still valid, we just log and move on.
      // eslint-disable-next-line no-console
      console.warn('article SEO repair failed:', err.message);
    }
    timing.repair_ms = Date.now() - t_repair;
  }

  const usage = addUsage(initial.usage, repairResult?.usage);
  const costUsd = Number(((initial.costUsd || 0) + (repairResult?.costUsd || 0)).toFixed(6));
  timing.total_ms = Date.now() - t_start;

  return {
    data: currentData,
    analysis,
    initialAnalysis: analysis === repairAnalysis ? null : (repairApplied ? analyzer.analyze(buildAnalyzerInput({ generation: initial.data, input })) : null),
    repairAnalysis,     // filled only when the repair was worse and got rejected
    repairApplied,
    usage,
    costUsd,
    model: (repairResult || initial).model,
    prompts: {
      initial: initial.prompt,
      repair: repairResult?.prompt || null,
    },
    externalLinkVerification: verification,
    timing,
  };
}

// Analyze an article that already exists in the database. Used by the
// on-demand SEO endpoint so legacy rows and freshly-edited drafts share one
// analyzer entry point.
function analyzeExistingArticle({ article, connection = null, internalHostnames = [], knownInternalUrls = [] }) {
  // The DB stores per-row context; the analyzer expects camelCase input.
  const images = [];
  return analyzer.analyze({
    keyword: article.keyword || '',
    title: article.title || '',
    slug: article.slug || '',
    metaDescription: article.meta_description || '',
    markdown: article.markdown || '',
    tags: Array.isArray(article.tags) ? article.tags : [],
    heroImage: article.hero_image || null,
    heroAlt: article.hero_alt || null,
    images,
    internalHostnames,
    knownInternalUrls,
    searchIntent: article.search_intent || '',
  });
}

module.exports = {
  generateArticleWithSeo,
  analyzeExistingArticle,
  needsRepair,
  buildAnalyzerInput,
  // exported for tests
  _internal: { REPAIR_TRIGGER, addUsage },
};
