# Article Writing Functionality — How It Works

End-to-end walkthrough of the AI blog-article pipeline in Post-to: from the
"Generate blog" button in the frontend, through the LLM call and DB write, to
publishing the finished article on a customer's real website via S3.

## 1. High-level flow

```
Frontend "Generate blog" modal
        │
        ▼   POST /api/ai/articles  { keyword, connectionId?, tone?, … }
Backend routes/ai.js  (auth-only, no GMB business auth)
        │
        ├─► aiJobsService.countTodayByKind      ← daily cap check
        ├─► aiJobsService.createJob             ← ai_jobs row, status='running'
        ├─► aiContentService.generateArticle    ← OpenAI Chat Completions
        │         │
        │         └─► buildArticlePrompt(...)  → JSON with 6 required fields
        ├─► supabase.blog_articles.insert       ← status='draft'
        └─► aiJobsService.completeJob           ← tokens + cost + result_id
        │
        ▼
Frontend edits draft, then hits "Publish"
        │
        ▼   POST /api/blogs/:id/publish
Backend routes/blogs.js
        ├─► blog_articles.status='published', published_at=NOW()
        ├─► for each verified blog_domain:
        │      ├─ target='s3'     → blogPublisherS3.publish (write .md + trigger.txt)
        │      │                    then blogDeployTrigger.trigger (GH repository_dispatch)
        │      └─ target='hosted' → return https://<subdomain>/<slug>
        └─► return { urls[], deployHints[] }
```

## 2. Frontend entry point

- Component: [frontend/src/components/Blogs.js](../frontend/src/components/Blogs.js)
- Service wrapper: [frontend/src/services/blogsService.js](../frontend/src/services/blogsService.js)

The `GeneratorModal` (defined inside `Blogs.js` around
[Blogs.js:295](../frontend/src/components/Blogs.js#L295)) collects:

| Field | Required | Notes |
|---|---|---|
| `connectionId` | soft | Pre-selected from the current Connection filter or the first available website connection. Optional — the backend accepts a bare keyword too. |
| `keyword` | **yes** | Target SEO keyword (min 2, max 255 chars) |
| `tone` | no | Free-text ("helpful, local, professional") |
| `targetAudience` | no | Free-text ("homeowners and renters in Florida") |

Submit calls `blogsService.generate(...)` →
`POST /api/ai/articles` with a 60s Axios timeout
([blogsService.js:36](../frontend/src/services/blogsService.js#L36)).

There is also an entry from the GSC keyword panel (`GscKeywordsPanel` in the
same file, [Blogs.js:724](../frontend/src/components/Blogs.js#L724)): each
Search-Console-top-keyword row has a "Generate blog" button that pre-fills
`keyword` and opens the same modal.

## 3. Backend: `POST /api/ai/articles`

File: [backend/src/routes/ai.js](../backend/src/routes/ai.js) —
handler at [routes/ai.js:44](../backend/src/routes/ai.js#L44).

Auth: `authMiddleware` only (mounted globally on the router at
[routes/ai.js:27](../backend/src/routes/ai.js#L27)). **No `requireBusinessAuth`**
— article generation doesn't touch GMB, so a revoked GMB token doesn't block it.

Steps inside the handler:

1. **Validate** the body (`express-validator`) — the only strictly required
   field is `keyword`.
2. **Cap check** — `aiJobs.countTodayByKind(userId, 'article_generation')` vs
   `AI_DAILY_ARTICLE_CAP` (default **10/user/day**). Over cap → HTTP 429 with
   `{ used, cap }`.
3. **Connection prefill** (optional) — if `connectionId` is provided, load the
   `connected_accounts` row and prefill `businessName` from `display_name` and
   `businessType` from the scraped site's `metadata.description` (first 200
   chars). **Body values always win** — connection only fills in what the
   caller omitted.
4. **Build input object** with defaults geared at Spotless Homes:
   ```js
   { businessName: 'Spotless Homes',
     businessType: 'residential cleaning company',
     service: 'recurring cleaning',
     city: 'Tampa',
     tone: 'helpful, local, professional',
     targetAudience: 'homeowners and renters in Florida',
     keyword: req.body.keyword }
   ```
5. **Create `ai_jobs` row** with `status='running'` **before** the LLM call.
   This is intentional: a failed generation still consumes a slot against the
   daily cap, blocking retry-abuse. Documented as a gotcha in the Obsidian
   note ("I hit my cap but nothing succeeded" is expected).
6. **Call `aiContent.generateArticle(input)`** (see §4).
7. **Slugify** `ai.slug || ai.title`
   ([routes/ai.js:29](../backend/src/routes/ai.js#L29)) — lowercases,
   NFKD-normalizes, strips combining diacritics + non-alphanumerics, collapses
   whitespace to hyphens, caps at 200 chars.
8. **Insert into `blog_articles`** with `status='draft'`, capturing the input
   context (business_name/type, service, city, keyword) alongside the AI
   output (title/slug/meta_description/markdown/suggested_excerpt/
   suggested_social_post).
9. **Complete the job** — `aiJobs.completeJob(job.id, { prompt, outputJson,
   model, usage, costUsd, resultTable: 'blog_articles', resultId })`.
10. **Return 201** with the new row.

On any error after step 5, `aiJobs.failJob(job.id, err.message)` is called and
the client receives HTTP 502 with the message + `jobId`.

## 4. LLM call: `aiContentService.generateArticle`

File: [backend/src/services/aiContentService.js](../backend/src/services/aiContentService.js)

- Provider: OpenAI, called via raw `axios.post` to
  `https://api.openai.com/v1/chat/completions` (no `openai` package added on
  purpose — avoids a new dep). See `callOpenAI` at
  [aiContentService.js:67](../backend/src/services/aiContentService.js#L67).
- Model: `AI_MODEL` env, default `gpt-4o-mini`.
- Temperature: `0.7`, `max_tokens: 3000`, `response_format: { type: 'json_object' }`
  (forces valid JSON output).
- Provider selection is env-gated (`AI_PROVIDER`, default `openai`) — the
  shape is provider-agnostic but only OpenAI is wired in today.

### Prompt shape (`buildArticlePrompt`)

- **System**: `"You are an SEO content writer for local service businesses. You always reply with valid JSON only — no prose, no code fences."`
- **User**: parameterised block that includes business/service/city/keyword/
  tone/audience plus these hard rules:
  - Clear American English
  - Local & practical, not generic
  - No overpromising, no fake stats, no unverified certifications
  - Include practical advice + mention when hiring a pro makes sense
  - Naturally include the city/area and service
  - Soft CTA for `businessName`
  - Body: **700–1100 words**, H2/H3 subheadings, short intro + conclusion
  - Slug: lowercase, hyphen-separated
  - Meta description: **< 160 chars**

The model must return JSON with exactly these 6 keys:

```json
{
  "title": "…",
  "slug": "…",
  "metaDescription": "…",
  "markdown": "…",
  "suggestedExcerpt": "…",
  "suggestedSocialPost": "…"
}
```

Missing any of these keys → thrown error → job marked `failed`.

### JSON parsing safety net

`extractJson` at [aiContentService.js:38](../backend/src/services/aiContentService.js#L38)
tolerates the model wrapping output in ` ```json ` fences or emitting leading
prose — it strips fences and, failing that, scans for the outermost `{ … }`
substring before parsing.

### Cost bookkeeping

`estimateCostUsd(model, usage)` uses a static per-1K-token price table
(`MODEL_PRICING`) to compute an approximate USD cost from the OpenAI `usage`
object. Persisted onto `ai_jobs.cost_usd`. Adjust the table when new models
land.

## 5. Data model

Migration: [supabase/ai-pipeline-tables.sql](../supabase/ai-pipeline-tables.sql)
(idempotent — safe to re-run). Three tables:

### `blog_articles`

The article record itself. Key fields:

| Field | Purpose |
|---|---|
| `user_id UUID` | Owner (no FK — deliberate; migration comment notes the two conflicting `users` table patterns in the repo) |
| `business_profile_id UUID` | Optional link to the caller's business profile |
| `connection_id UUID` | Optional link to the `connected_accounts` row used to prefill business context (added by connections work, not in this SQL file) |
| `business_name`, `business_type`, `service`, `city`, `keyword` | Frozen input context (so future edits don't lose "what was this generated from") |
| `title`, `slug`, `meta_description`, `markdown`, `suggested_excerpt`, `suggested_social_post` | AI output |
| `hero_image`, `hero_image_source_id`, `visual_search_query` | Added by the hero-image feature — populated separately after generation |
| `status` | `draft` \| `published` \| `failed` |
| `published_at TIMESTAMPTZ` | Added by `supabase/blog-articles-published-at.sql` (ran 2026-07-28). Powers the reader-facing sitemap ordering. |

### `ai_jobs`

Audit log for every generation attempt. Fields include `kind`
(`article_generation` here), `status` (`queued` / `running` / `done` /
`failed`), the full `prompt` and `output_json`, token counts, `cost_usd`, and
`result_table` + `result_id` pointer back to the blog_articles row.

Daily-cap counting is a plain `count(*)` over
`user_id + kind + status IN (running, done) + created_at >= today (UTC)`
([aiJobsService.js:65](../backend/src/services/aiJobsService.js#L65)).

### `ai_generated_posts`

Not used by the article flow — this is where the review-post drafts land.
Mentioned here only to distinguish it from `blog_articles`.

All three tables have RLS **enabled but permissive** (`FOR ALL USING (true)`)
because access is always via the server-side service role key. Do not lift
this to client-side without adding real policies.

## 6. Editing the draft

Once the draft exists, the frontend uses the CRUD endpoints in
[backend/src/routes/blogs.js](../backend/src/routes/blogs.js) — none of these
call the LLM, they just manage rows.

| Verb | Route | Purpose |
|---|---|---|
| `GET` | `/api/blogs` | List (filter by `connectionId` / `status`, limit) |
| `GET` | `/api/blogs/:id` | Single article, with `hero_image_preview_url` computed via pre-signed S3 URL |
| `PATCH` | `/api/blogs/:id` | Update any of: `title`, `slug`, `metaDescription`, `markdown`, `suggestedExcerpt`, `suggestedSocialPost`, `status`, `heroImage`. Whitelist enforced by `EDITABLE_FIELDS_MAP`. |
| `DELETE` | `/api/blogs/:id` | Delete row (fan-out removal from S3 domains happens on unpublish/delete) |
| `POST` | `/api/blogs/:id/hero-image` | Upload a hero image (multer, ≤10MB, image mime-types only) |
| `POST` | `/api/blogs/:id/hero-image/from-url` | Attach a hero from a stock-image URL |
| `GET` | `/api/blogs/:id/suggest-hero-images` | Suggest images via `stockImageService` |
| `POST` | `/api/blogs/:id/unpublish` | Flip back to draft **and** fan-out removal from all verified S3 blog domains |

## 7. Publishing: `POST /api/blogs/:id/publish`

File: [backend/src/routes/blogs.js:315](../backend/src/routes/blogs.js#L315)

1. Load the article (ownership: `user_id = req.user.userId`).
2. Reject if `title` or `slug` is missing.
3. Flip `status='published'`, stamp `published_at = NOW()`.
4. Load the caller's verified `blog_domains` rows (via
   `blogDomainsService.getForUser` — needed because it returns raw metadata
   including the S3 secret, which is normally stripped from list responses).
5. For each verified domain, route by `metadata.publish_target`:
   - **`s3`** → `blogPublisherS3.publish` + `blogDeployTrigger.trigger`
   - **`hosted`** (or unset) → legacy path: URL is
     `https://<subdomain>/<slug>` served by the `post-to-blogs` Vercel
     project.
6. Return `{ blog, urls[], hasVerifiedDomain, deployHints[] }`.

### S3 publish — `blogPublisherS3.publish`

File: [backend/src/services/blogPublisherS3.js](../backend/src/services/blogPublisherS3.js)

- Object key follows the Spotless / StampMaker convention:
  `<prefix>/<YYYY-MM-DD>-<slug>.md` (prefix defaults to `posts/`, configurable
  via `domain.metadata.s3_prefix`).
- Body is YAML frontmatter (`title`, `slug`, `date`, `updated`, `author`,
  `description`, `heroImage`) + the article markdown, with the hero image
  injected **after the first prose paragraph** (`injectHeroInBody`) so the
  body has the same visual rhythm as Spotless's hand-written posts. Skipped
  if the body already references that image URL.
- Also writes a `posts/trigger.txt` with the current ISO timestamp so S3-event
  watchers rebuild even when the article file was overwritten with identical
  content (e.g. re-publishing an edited draft that kept its slug + date).
- S3 credentials come from the `blog_domain.metadata` fields
  (`s3_region`, `s3_bucket`, `s3_access_key_id`, `s3_access_key_secret`).
  Missing any of them → throws with `status=500`.

### Deploy trigger — `blogDeployTrigger.trigger`

File: [backend/src/services/blogDeployTrigger.js](../backend/src/services/blogDeployTrigger.js)

Currently supports one provider: **GitHub `repository_dispatch`**.

- Fires `POST https://api.github.com/repos/:owner/:repo/dispatches` with
  `{ event_type: metadata.github_workflow_event || 'publish-blog',
     client_payload: { slug, title, published_at } }`.
- Uses `metadata.github_token` (needs `repo` scope, or fine-grained
  contents:R/W + metadata:R) and `metadata.github_repo` (`owner/repo`).
- On success (HTTP 204) → `{ ok: true, provider: 'github_actions' }` →
  frontend shows "auto-deploy fired".
- On any failure → `{ ok: false, error }` → frontend shows "run your site
  build to publish it live". **Never throws** to the caller — the S3 write
  already succeeded, so a trigger failure just means the customer will deploy
  manually.

End state: article live at `https://www.<customer-domain>/blog/<slug>` within
~2 minutes of the GitHub Action completing.

## 8. Automation path (no UI generation)

Article generation can also be initiated automatically by a schedule (added
under `automations`). See
[backend/src/services/automationExecutor.js](../backend/src/services/automationExecutor.js)
around line 126:

- Same `aiContentService.generateArticle` call → same `blog_articles` insert
  → same `ai_jobs` accounting (so the same per-user daily caps apply).
- If the rule has `auto_publish: true`, it flips `status='published'` +
  `published_at=NOW()` directly against Supabase (no HTTP hop through
  `/publish`) and then fans out to S3 domains via `blogPublisherS3.publish` +
  `blogDeployTrigger.trigger` — matching the shape of the manual publish
  route.

## 9. Environment variables

| Var | Purpose | Default |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI creds | (required) |
| `AI_PROVIDER` | Reserved for future provider swap | `openai` |
| `AI_MODEL` | Model ID passed to OpenAI | `gpt-4o-mini` |
| `AI_DAILY_ARTICLE_CAP` | Per-user articles/day | `10` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | DB access | (required) |

Per-domain (stored on `blog_domains.metadata`, not env):
`s3_region`, `s3_bucket`, `s3_prefix`, `s3_access_key_id`,
`s3_access_key_secret`, `hostname`, `public_hostname`, `public_url_pattern`,
`author_name`, `site_name`, `deploy_trigger` (`github_actions`),
`github_token`, `github_repo`, `github_workflow_event`.

## 10. Testing

- **Live smoke test**: [backend/scripts/test-ai-pipelines.sh](../backend/scripts/test-ai-pipelines.sh)
  — hits `POST /api/ai/articles` + `POST /api/ai/review-post` against a
  running server. Requires `JWT_TOKEN` and `BACKEND_URL` env.
- **Unit tests** (Node's built-in test runner):
  [backend/tests/reviews-generate-post.test.js](../backend/tests/reviews-generate-post.test.js)
  — covers the sibling review-post route; the pattern (mock supabase, stub
  `aiContentService`, spin up a real express app) is what to copy for any
  new article-generation tests.

## 11. Known gotchas

- **Cap-consumes-on-failure is intentional** — the `ai_jobs` row is created
  with `status='running'` *before* the LLM call. Debugging "I hit my cap but
  nothing succeeded" almost always means transient OpenAI errors ate the
  slots.
- **`slugify` in `routes/ai.js` uses literal combining-diacritic characters**
  in its regex (`[̀-ͯ]`). Some editors render this as a single weird
  character — it is correct.
- **`connectionId` is a soft prefill only**. Explicit body fields always
  override. Missing connection → 404 (only when `connectionId` is present but
  the row doesn't belong to the user).
- **No FK from `blog_articles.user_id` to `auth.users(id)`** — deliberate, to
  dodge the ambiguity between `setup-database.sql`'s custom `users` table and
  `gmb-tables.sql`'s reference to `auth.users`.
- **Cost estimation is best-effort** via the static `MODEL_PRICING` table.
  Update `aiContentService.js` when adding new models or prices change.
- **Publishing to `s3` domains is best-effort per-domain** — one domain
  failing doesn't block the others; each shows up in `deployHints[]` with
  its own success/failure reason.
