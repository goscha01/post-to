# SEO layer — implementation report

Extension of the existing Post-to article pipeline (Generate → Draft → Edit →
Publish → Customer site) with a deterministic SEO layer on top. Nothing in
the current flow was replaced; existing legacy articles work as-is.

---

## 1. Architecture changes

| Layer | Change |
|---|---|
| DB | 7 new nullable columns on `blog_articles` (tags TEXT[], hero_alt, search_intent, suggested_internal_links JSONB, image_suggestions JSONB, faq JSONB, seo_metadata JSONB). Idempotent migration. No backfill required. |
| Prompt | `buildArticlePrompt` rewritten — adaptive layout menu, 1500-2500 word target, structured JSON envelope, internal-link whitelist from connection metadata, "no invented URLs" rule, "body starts at H2" rule. |
| Generation | New wrapper `articleSeoPipeline.generateArticleWithSeo`. One canonical entry point — both the manual `POST /api/ai/articles` and the scheduled `automationExecutor` call it. No duplicate implementation. |
| Repair | Bounded to exactly ONE pass — fires only for repair-fixable critical failures OR adjusted-score < 60. Hero/image checks are excluded because the LLM can't attach media. Repair is rejected if it doesn't improve the analysis (audit hook exposed for observability). |
| Analyzer | Backend is sole authority. Deterministic, pure JS, dependency-free — safe to call on every keystroke behind a debounce. Legacy rows analyze on demand via `POST /api/blogs/:id/seo-analyze`. |
| Cache | `seo_metadata` JSONB stores the last analysis WITH `analyzerVersion` + `contentHash` + `analyzedAt`. Any analyzer-relevant PATCH clears the cache; opportunistic recompute on GET when stale or version-mismatched. |
| UI | Compact SEO banner on the editor; right-side checklist drawer with per-check "Fix with AI"; MetadataEditor panel with live char-count feedback and tags chip UI. |
| Publish | S3 publisher now emits `heroAlt`, `tags[]` (YAML flow sequence), and `keyword` in frontmatter. Tables / FAQ / lists / callouts pass through unchanged. `validatePublishedMarkdown` runs a last-line-of-defense structural check. `meta keywords` HTML tag is NOT emitted (with an explicit code comment why). |

---

## 2. Files changed

### New

**Backend**
- `backend/src/services/seo/articleSeoRules.js` — 34 rules, 5 categories, weights, thresholds, `SEO_ANALYZER_VERSION`.
- `backend/src/services/seo/articleSeoAnalyzer.js` — `analyze()`, `groupByCategory()`, 34 evaluators.
- `backend/src/services/seo/textUtils.js` — markdown parsing, heading/link/image extraction, keyword counting, `contentHash`.
- `backend/src/services/seo/articleSeoPipeline.js` — `generateArticleWithSeo`, `analyzeExistingArticle`, `needsRepair`.
- `backend/scripts/apply-seo-migration.js` — one-shot migration runner.
- `backend/scripts/e2e-seo.js` — full production-like E2E harness.
- `backend/scripts/e2e-playwright-fixture.js` / `e2e-playwright-cleanup.js` — Playwright fixture setup + teardown.
- `backend/tests/seo/analyzer.test.js` — 25 unit tests.
- `backend/tests/seo/fixtures.js` — 15 fixture articles.
- `backend/tests/seo/generation.test.js` — 13 pipeline tests.
- `backend/tests/blogs-seo-api.test.js` — 8 API tests.
- `backend/tests/publisher-seo.test.js` — 10 publisher tests.
- `supabase/blog-articles-seo.sql` — migration.

**Frontend**
- `frontend/src/components/seo/SeoPanel.js` — SeoBanner, SeoChecklistDrawer, MetadataEditor, useDebouncedSeo.
- `frontend/src/components/seo/SeoPanel.test.js` — 13 jest/RTL tests.
- `frontend/e2e/seo-workflow.spec.js` — Playwright test.
- `frontend/playwright.config.js`.

### Modified

- `backend/src/services/aiContentService.js` — `buildArticlePrompt`, `buildArticleRepairPrompt`, `normalizeArticleOutput`, `repairArticle`, `estimateCostUsd` (prefix match for versioned model IDs), `DEFAULT_ARTICLE_MODEL` env.
- `backend/src/routes/ai.js` — persist new SEO columns, return `{ seo, repairApplied }`.
- `backend/src/routes/blogs.js` — PUBLIC_FIELDS + EDITABLE_FIELDS_MAP extended, PATCH invalidates cached SEO, GET auto-recomputes stale/missing, new `POST /:id/seo-analyze` and `POST /:id/seo-fix`.
- `backend/src/services/automationExecutor.js` — routes through the SEO pipeline (single implementation).
- `backend/src/services/blogPublisherS3.js` — new frontmatter fields, `validatePublishedMarkdown`, array support in YAML frontmatter.
- `backend/.env.example` — `AI_ARTICLE_MODEL` doc.
- `frontend/src/components/Blogs.js` — EditView wired to SeoBanner + SeoChecklistDrawer + MetadataEditor.
- `frontend/src/services/blogsService.js` — `analyzeSeo`, `fixSeo`.
- `frontend/.gitignore` — Playwright artifacts.

---

## 3. DB migrations

`supabase/blog-articles-seo.sql` — idempotent, applied to production (verified via `apply-seo-migration.js`).

Columns added:
```
tags                       TEXT[] DEFAULT '{}'
hero_alt                   TEXT
search_intent              VARCHAR(64)
suggested_internal_links   JSONB
image_suggestions          JSONB
faq                        JSONB
seo_metadata               JSONB
```

Index: `idx_blog_articles_seo_status` on `(user_id, seo_metadata->>'status')`.

---

## 4. Exact SEO checks implemented (34 rules across 5 categories)

**Meta & Technical (7)** — title_present · title_length · meta_description_present · meta_description_length · slug_present · slug_seo_friendly · tags_configured

**Links (5)** — internal_links_present · descriptive_anchor_text · external_links_present · no_broken_markdown_links · anchor_diversity

**Media & Visuals (5)** — hero_image_present · hero_alt_present · hero_alt_quality · image_alt_coverage · keyword_in_image_alt

**Content Quality (10)** — word_count · paragraph_length · no_wall_of_text · heading_hierarchy · h2_count · unique_headings · lists_present · faq_present · intro_present · conclusion_present · clean_markdown

**Search Term Optimization (7)** — keyword_in_title · keyword_in_meta_description · keyword_in_slug · keyword_in_intro · keyword_in_heading · keyword_density · keyword_placement_distribution

Each check returns `passed | warning | failed | not_applicable`. FAQ is N/A unless the topic/searchIntent signals Q&A. Internal-links check is N/A when the caller doesn't provide site context (never invents URLs). Density check fails on stuffing (≥4%), warns outside 0.5–2.5%.

Critical checks (their failure gates status to red): title_present · meta_description_present · slug_present · hero_image_present · image_alt_coverage · keyword_in_title · keyword_density · clean_markdown.

---

## 5. Generation prompt changes

- Adaptive layout: model picks from a menu (intro, key takeaways, definition, how-to, comparison, table, checklist, cost, mistakes, FAQ, conclusion) — explicitly told **not** to use every section every time.
- Target range 1500–2500 words; longer allowed when justified; padding forbidden.
- Body starts at H2 (article title = site's H1).
- Short scannable paragraphs, lists for scanning, tables for multi-dimensional data.
- Keyword rules: in title + intro + at least one heading + conclusion; density natural, no stuffing.
- Internal-link whitelist: only URLs from `connection.metadata.internal_urls|pages|sitemap_urls`. Empty list → prompt says "do NOT invent internal links, skip the array."
- Trust rules: no invented stats/awards/certifications, cost ranges caveated, DIY vs pro when appropriate.
- Structured output beyond legacy 6 fields: `tags`, `searchIntent`, `faq[]`, `imageSuggestions[]`, `suggestedInternalLinks[]`. All defaulted in `normalizeArticleOutput` so partial responses don't crash callers.

Repair prompt is targeted: given the analyzer failures verbatim + the previous JSON, "keep structure and voice, edit only what needs editing." Same schema round-trip. Never asked to invent URLs.

---

## 6. UI changes

- **SeoBanner**: `Words: 2,184 | Search term: house cleaning tampa | ● 22 of 24 SEO checks passed · 2 warnings · View details →`. Colored dot (green/yellow/red). Spinner while re-analyzing.
- **SeoChecklistDrawer**: right-side, categories collapsible, per-check status icon + value + recommendation, "Fix with AI" button on every failed/warning row. Score + status label in the sticky header. Analyzer version + timestamp in the footer.
- **MetadataEditor**: dedicated panel with Search Term, Meta Description (live char count with optimal/recommended/outside tone), Slug + Title (with char count), Tags chip UI (Enter-to-add), Hero Image Alt.
- **useDebouncedSeo**: bumps a version counter on any relevant edit → debounces 700ms → server re-analysis → keeps previous result visible during the request → ignores stale in-flight responses.

Old inline title/slug/meta inputs removed from the EditView (they now live in MetadataEditor — no duplication).

---

## 7. Test counts / results

| Layer | Tool | Files | Tests | Status |
|---|---|---|---|---|
| Analyzer unit | Node `--test` | `tests/seo/analyzer.test.js` | 25 | ✅ pass |
| Generation pipeline | Node `--test` | `tests/seo/generation.test.js` | 13 | ✅ pass |
| API (blogs SEO) | Node `--test` | `tests/blogs-seo-api.test.js` | 8 | ✅ pass |
| Publisher | Node `--test` | `tests/publisher-seo.test.js` | 10 | ✅ pass |
| Pre-existing | Node `--test` | `tests/reviews-generate-post.test.js` | 6 | ✅ pass |
| **Backend total** | | | **62** | ✅ **62/62** |
| Frontend components | Jest / RTL | `frontend/src/components/seo/SeoPanel.test.js` | 13 | ✅ pass |
| Playwright E2E | @playwright/test | `frontend/e2e/seo-workflow.spec.js` | 1 | ✅ pass |
| Real-world API E2E | Custom Node | `backend/scripts/e2e-seo.js` | 11 steps | ✅ pass (see below) |

Frontend `npm run build` fails on **pre-existing lint warnings** in files this PR did not touch (BusinessProfiles.js, Reviews.js, GoogleAds.js, etc.). Verified by `git stash` — pristine master fails identically. Not a regression introduced here.

---

## 8. Real test article URL

Test article was published live to `https://www.spotless.homes/blog/post-to-seo-e2e-2026-08-21`, verified rendering, then **unpublished and deleted**. Cleanup confirmed — S3 object removed, GitHub deploy re-fired.

**HTML verified while live** (see `docs/e2e-seo-report.json`):
- `<title>`: `Post-To SEO E2E Engineering Test (2026-08-21) — DO NOT INDEX | Spotless Homes`
- `<meta description>`: `Discover the importance of post to SEO E2E engineering tests for homeowners and renters in Tampa, an…`
- `<link canonical>`: `https://www.spotless.homes/blog/post-to-seo-e2e-2026-08-21/`
- `<h1>`: `Post-To SEO E2E Engineering Test (2026-08-21) — DO NOT INDEX`
- Headings: 7 H2s, 15 H3s (FAQ H3s render)
- Images with alt attribute: 3

---

## 9. Before/after SEO analysis (from the real E2E)

| State | Score | Status | Passed | Warnings | Failed | Critical failures |
|---|---|---|---|---|---|---|
| Generation (initial + repair applied) | 77 | red | 17 | 8 | 2 | (hero not attached — red is expected pre-hero) |
| Broken (meta_description blanked) | 67 | red | — | — | 4 | 3 |
| Fixed (targeted Fix-with-AI on meta_description_present) | 73 | red | — | — | 3 | 2 |

Notes:
- Red status remains after the fix because the hero image was never attached in this engineering test (the pipeline analyzer legitimately reports `hero_image_present=failed` for a pre-hero draft — that's a nudge to the user, not a repair trigger).
- Repair pass fired once and was accepted (score went from initial → 77 after the bounded repair).
- Fix-with-AI cost: single targeted meta rewrite, ~300 tokens.

Generation metrics:
- Model: `gpt-4o-mini-2024-07-18`
- Tokens: 2,491 prompt + 1,989 completion = 4,480 total
- Latency: 34.6 s (includes initial + repair pass)
- Estimated cost: **~$0.0016** at gpt-4o-mini rates (the versioned model id matches the family via prefix lookup after the fix in `estimateCostUsd`)

---

## 10. Screenshots

Captured by Playwright at `frontend/e2e/screenshots/`:

- `01-editor.png` — Editor drawer with SEO banner ("Words: 490 | Search term: playwright ui screensh… | 18 of 27 SEO checks passed · 6 warnings · 3 failed") and MetadataEditor panel (Search term, Meta description with live "123 chars — recommended 140-160" count, Slug, Title with "43 chars — recommended 45-65" count, Tags chip UI, Hero image alt text).
- `02-checklist.png` — SEO Checklist drawer open. Header: "Score 75 · Significant issues" with red dot. All 5 categories visible (Meta & Technical · Links · Media & Visuals · Content Quality · Search Term Optimization) with per-category pass/warn/fail counts. Meta & Technical + Search Term Optimization expanded showing per-check rows with status icons, measured values ("43 characters"), recommendations, and "Fix with AI" buttons on failed/warning rows.
- `03-metadata.png` — MetadataEditor with all fields visible (used after closing the drawer).

Full evidence blob: `docs/e2e-seo-report.json`.

---

## 11. Known limitations

1. **Live re-analysis on unsaved UI edits reads the DB, not the in-memory state.** The `useDebouncedSeo` hook calls `POST /:id/seo-analyze` which reads the row from Supabase. Editing the keyword field in the UI doesn't reflect in the banner until Save is clicked (which PATCHes and invalidates the cache). Fix would be either auto-save on debounce or accept an inline body on `/seo-analyze` — deferred to keep this PR scoped. Client-side char-count tone for meta description + title works immediately (that logic lives in the MetadataEditor component and is display-only).
2. **Model default not changed.** Current `AI_MODEL=gpt-4o-mini` remains the default. New `AI_ARTICLE_MODEL` env is available for per-project override. Benchmark before flipping the default (per your instruction to decouple).
3. **Frontend `npm run build` is red** due to pre-existing lint warnings in unrelated files (verified with `git stash`). This blocks the Vercel deploy but nothing in this PR contributes new warnings.
4. **Playwright test scope is intentionally narrow** — screenshots + UI wiring only. Exhaustive analyzer permutations live in the Node `--test` unit suite.
5. **No client-side analyzer.** Backend is sole authority per the spec. Client-side tone hints for meta/title are display-only and never contradict the server.
6. **Repair pass ignores hero-related failures for triggering.** They still show up in the checklist as critical → user gets a red banner until they attach a hero. Deliberate: repair can't fix media, so it would loop forever on those.

---

## 12. Deployment status

- **Migration** applied to production Supabase (`blog-articles-seo.sql`, verified via `apply-seo-migration.js`).
- **Backend** deployed to Railway `self-post-production` via `git push origin master` — new SEO routes verified live (`/api/blogs/:id/seo-analyze` and `/api/blogs/:id/seo-fix` return 401 without JWT, meaning they're wired).
- **Frontend** NOT yet deployed to Vercel — the pre-existing lint warnings block CI. Options: (a) fix the pre-existing lint issues in a separate PR, (b) set `CI=false` on Vercel to treat warnings as warnings. Not blocking backend or the analyzer / repair flow.
- **Automation path** picks up the enhanced pipeline automatically (no separate deploy).
- Real E2E run: article published live to `https://www.spotless.homes/blog/post-to-seo-e2e-2026-08-21`, HTML verified via curl, then unpublished + deleted; both S3 object and GitHub deploy fired on cleanup.
