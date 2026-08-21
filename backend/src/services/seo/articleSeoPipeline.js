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

function buildAnalyzerInput({ generation, input }) {
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
  };
}

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

async function generateArticleWithSeo(input) {
  const businessName = input.businessName || 'the business';
  const knownInternalUrls = input.knownInternalUrls || [];

  const initial = await aiContent.generateArticle(input);
  let currentData = initial.data;
  let analysis = analyzer.analyze(buildAnalyzerInput({ generation: currentData, input }));

  let repairApplied = false;
  let repairResult = null;
  let repairAnalysis = null;

  if (needsRepair(analysis)) {
    repairApplied = true;
    try {
      repairResult = await aiContent.repairArticle({
        previousJson: currentData,
        analysis,
        keyword: input.keyword,
        businessName,
        knownInternalUrls,
        model: input.model,
      });
      const repairedData = repairResult.data;
      const repairedAnalysis = analyzer.analyze(buildAnalyzerInput({ generation: repairedData, input }));
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
  }

  const usage = addUsage(initial.usage, repairResult?.usage);
  const costUsd = Number(((initial.costUsd || 0) + (repairResult?.costUsd || 0)).toFixed(6));

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
