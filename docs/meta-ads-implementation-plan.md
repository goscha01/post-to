# Meta Ads Integration — Phased Implementation Plan

Companion to [meta-ads-api-design-doc.md](./meta-ads-api-design-doc.md). This is the build order — what ships, in what phase, what the App Review milestone is between phases.

## Target architecture

**Three reporting surfaces, one action surface.**

```
Google Ads API ──────┐
                     ├── Optimization Report ── Campaign Assistant
Meta Marketing API ──┤                          │
                     │                          ├─ Google mutations
GA4 ─────────────────┘                          └─ Meta mutations
```

The Meta dashboard (`MetaAds.js`) is a **read-only reporting surface** modeled 1:1 on `GoogleAds.js`. Its Diagnostics section flags issues but offers no direct mutation controls — each issue card opens Campaign Assistant with the flagged entities pre-loaded as context. Every write flows through the assistant's existing action-plan mechanism, extended with a new provider dispatch case.

**Do not create `metaAdsActions.js`, `meta_ads_actions`, or any parallel mutation subsystem.** The existing infrastructure is already the abstraction we need — see "Reuse rationale" below.

## Reuse rationale — why we're not building a parallel mutation subsystem

The current Google Ads mutation flow lives entirely inside Campaign Assistant. Concretely:

- `campaign_assistant_action_plan_steps` — [supabase/campaign-assistant-action-plans.sql](../supabase/campaign-assistant-action-plans.sql) — has `type`, `action_type`, `action_params` JSONB, `status` (pending → done | skipped | applied | failed), `applied_at`, `applied_error`, `notes`. This IS the audit trail.
- The Apply dispatcher — [backend/src/routes/campaignAssistant.js:2069](../backend/src/routes/campaignAssistant.js#L2069) — is a `switch (step.action_type)` with one case per Google Ads mutation, each resolving customer + login-customer-id + owner-Google access token, invoking the service, and shaping `executed.summary` + `noop` for the client.
- The conversation table `campaign_assistant_conversations` already carries `google_ads_customer_id`, `google_ads_login_customer_id`, `ga4_property_id`, `ga4_app_property_id`.

To add Meta mutations, we need:
1. A new `type` value: `meta_ads_action` (currently only `google_ads_action` and `app_code_change` are Apply-able — [campaignAssistant.js:2046](../backend/src/routes/campaignAssistant.js#L2046))
2. New `action_type` strings: `pause_meta_ad`, `resume_meta_ad`, `set_meta_adset_budget`, etc. — dispatched as new cases in the same switch
3. A new column on `campaign_assistant_conversations`: `meta_ads_account_id` (with a nullable `meta_ads_business_id` for the Business Manager case)
4. A `resolveMetaAdAccount(userId, adAccountId)` helper mirroring the existing `resolveAdsCustomer(userId, cid)` — resolves account + owning Facebook identity + long-lived access token

That's it. Everything else — action-plan generation from the assistant, plan review UI, confirm-and-apply flow, per-step audit — already handles the new provider once the type value and dispatch cases exist.

## Prior art in this repo we're modeling on

- **[backend/src/services/googleAdsService.js](../backend/src/services/googleAdsService.js)** — read-only client shape (direct axios, no SDK dep) + write methods (`pauseCampaign`, `setCampaignDailyBudget`, etc.) at the bottom. Same file structure for Meta.
- **[backend/src/routes/googleAds.js](../backend/src/routes/googleAds.js)** — one route per dashboard section, no write endpoints (writes live only in Campaign Assistant).
- **[frontend/src/components/GoogleAds.js](../frontend/src/components/GoogleAds.js)** — the 17-tab dashboard UI.
- **[backend/src/services/optimizationReportService.js](../backend/src/services/optimizationReportService.js)** — the cross-channel report that Campaign Assistant reads. Meta must be added here in Phase 1D.
- **[backend/src/services/metaService.js](../backend/src/services/metaService.js)** — Graph API client for organic FB/IG posts. **Reused for OAuth + token refresh only** — the Ads endpoints go into a new service.

## Phase 0 — Meta App setup (blocking, ~1 day of clock time)

1. In Meta App Dashboard, add **Marketing API** product to the existing Post-To app (same `META_APP_ID` we already use for Pages/IG).
2. Request the new scopes on the OAuth flow: `ads_read`, `ads_management`, and keep the existing Pages/IG scopes.
3. **Verify the correct Marketing API version against Meta's live documentation.** The organic-posting Graph API version currently pinned in `metaService.js` (`v21.0`) is not necessarily the right target for the Marketing API surface. Confirm both the current stable Marketing API version and its sunset date before pinning `META_ADS_API_VERSION` in the env.
4. Confirm business verification status is still `Verified`; if not, redo.

No App Review needed to build in dev — the developer + admins of the app can call all endpoints with their own tokens. Review is only needed to ship to arbitrary users.

## Phase 1 — Read-only dashboard + cross-channel report + assistant awareness (target: 5–7 days)

Ship parity with Google Ads' read dashboard, feed Meta into the optimization report, and give Campaign Assistant read-only awareness of Meta so cross-channel questions work before any mutation ships.

### 1A — Backend service: `backend/src/services/metaAdsService.js`

Model after `googleAdsService.js`. One file, direct axios, no `facebook-nodejs-business-sdk` dep. Public surface:

```js
listAdAccounts(userAccessToken)                      // GET /me/adaccounts
describeAdAccount(token, adAccountId)                // GET /act_{id}
getInsights({ token, node, level, since, until, breakdowns })
                                                     // GET /{node}/insights
getCampaigns(token, adAccountId, dateRange)
getAdSets(token, adAccountId, dateRange)
getAds(token, adAccountId, dateRange)
getAdCreatives(token, adAccountId)
getDeliveryIssues(token, adAccountId)                // effective_status + issues_info
getPixel(token, pixelId)
normalizeApiError(err)                               // mirrors metaService.js normalizeApiError
```

**Before coding**, the agent MUST validate against Meta's live docs and the target ad account's actual responses:
- Current stable Marketing API version and its sunset horizon
- Exact field names on each `insights` breakdown (`publisher_platform`, `platform_position`, `device_platform`, `age`, `gender`, `hourly_stats_aggregated_by_advertiser_time_zone`) — Meta renames these periodically
- Exact shape of `issues_info` and `effective_status` in the current API version
- Whether `recommendations` is exposed on the Marketing API at all (it exists in the Ads Manager UI; API exposure has varied by version)

Do not freeze the API version or field list until this validation is done.

Reuse `metaService.exchangeCodeForToken` / `getLongLivedUserToken` for auth — same Meta OAuth flow, extra scopes. Token storage: extend the existing `provider='facebook'` `connected_accounts` row's `metadata` with `ad_account_ids: [...]`. Single Meta identity per user, multi-purpose token.

### 1B — Routes: `backend/src/routes/metaAds.js`

One endpoint per section, mirroring `routes/googleAds.js`. **Read only** — no `POST`/`DELETE`/`PATCH` handlers in this router at all:

```
GET  /api/meta-ads/accounts             → list of ad accounts
POST /api/meta-ads/accounts             → save picked ad account (this is the only non-GET; it writes to our DB, not to Meta)
GET  /api/meta-ads/connected            → list user's saved ad accounts
GET  /api/meta-ads/_diagnose            → scope + token introspection
GET  /api/meta-ads/overview             → aggregated KPIs
GET  /api/meta-ads/campaigns
GET  /api/meta-ads/adsets
GET  /api/meta-ads/ads
GET  /api/meta-ads/placements           → breakdowns=publisher_platform,platform_position
GET  /api/meta-ads/devices              → breakdowns=device_platform
GET  /api/meta-ads/demographics         → breakdowns=age,gender
GET  /api/meta-ads/day-hour             → breakdowns=hourly_stats_aggregated_by_advertiser_time_zone
GET  /api/meta-ads/creatives
GET  /api/meta-ads/delivery-issues
GET  /api/meta-ads/diagnostics          → computed server-side
```

Grep invariant to enforce in Phase 1: `grep -RE "axios\.(post|delete|put|patch)" backend/src/routes/metaAds.js backend/src/services/metaAdsService.js` returns nothing. This is the property the `ads_read`-only App Review submission depends on.

### 1C — Diagnostics engine + `MetaAds.js` dashboard

Diagnostics live in a new file `backend/src/services/metaAdsDiagnostics.js`. Pure function — takes raw campaign/adset/ad rows + insights and produces a prioritized list. Prefer **Meta's own returned signals** over reimplementing Meta's logic:

| Rule | Severity | Data needed |
|---|---|---|
| `effective_status` in `WITH_ISSUES` or `PENDING_REVIEW` on any entity | Passed through from Meta | `effective_status` |
| `issues_info` present on ad / adset / campaign | Passed through, use Meta's message verbatim | `issues_info` |
| Ad frequency > 4 with ≥1000 impressions | HIGH | `ads` insights `frequency` |
| Ad set spend < 20% of daily_budget × days | HIGH | `adsets` insights + budget |
| Ad CPA > 2× account average CPA | MED | `ads` insights + cost per result |
| Ad CTR < 0.5% with ≥5000 impressions | MED | `ads` insights + CTR |
| Ad set with only 1 active ad | LOW | `adsets` + `ads` |

Each rule outputs `{ severity, title, count, entityIds: [...], guidance }`. Do **not** invent Meta operational rules ("50-conversion learning threshold" etc.) — either surface Meta's own returned guidance verbatim, or use empirical rules that operate on numbers the API returns directly.

Frontend: copy `GoogleAds.js` as the template, swap:
- Icon: `Facebook` (from lucide)
- Tab list: `overview | diagnostics | campaigns | adsets | ads | placements | creatives | devices | demographics | day-hour | delivery`
- Overview cards: spend, impressions, reach, frequency, CTR, CPM, results, cost per result
- Reuse day-range control, JSON export, connection picker

Each Diagnostics issue card shows a **"Review with Campaign Assistant →"** CTA. It does NOT surface Apply / Pause buttons directly. The CTA opens Campaign Assistant with the flagged entity IDs pre-loaded as context; the assistant produces the action plan.

Add `MetaAds.js` to sidebar navigation next to the Google Ads entry.

### 1D — Extend `optimizationReportService.js` with Meta

This is the strategic step. The optimization report currently fans out to Google Ads + GA4 and returns a merged JSON blob the assistant reads. Add Meta:

```js
{
  meta: { ... },        // account, spend, campaigns, adsets, ads, insights, diagnostics
  googleAds: { ... },
  analytics: { ... },
  summary: { ... },     // extend to include cross-channel KPIs
  alerts: [ ... ],      // extend to include Meta diagnostics
  crossReference: {
    byCampaign: [...],           // existing: Ads↔GA4 join
    googleByCampaign: [...],     // alias for the above (naming for parity)
    metaByCampaign: [...]        // new: Meta campaign ↔ GA4 source=facebook|instagram / medium=cpc|paid_social
  }
}
```

The `metaByCampaign` join is the highest-value addition — it's what unlocks "why are Facebook leads getting more expensive?" and "should I move budget from Google to Meta?" for the assistant.

Add a `metaAdAccountId` query param to `GET /api/optimization-report` alongside the existing `customerId` and `propertyId`. If not supplied, the report skips the Meta section but keeps working.

### 1E — Give Campaign Assistant read-only awareness of Meta

- Add `meta_ads_account_id` column to `campaign_assistant_conversations` (nullable — existing conversations continue to work)
- When the conversation loads a Meta-connected user, the assistant's report snapshot includes the Meta section from the optimization report
- Update the system prompt to describe Meta as a channel the assistant can reason about but **cannot yet execute changes on**. The assistant produces observation-only steps (`type='observation'`) for Meta findings in Phase 1E — Apply-able Meta actions come in Phase 2

At the end of Phase 1E, cross-channel questions work end-to-end (assistant sees + reasons about Meta), no Meta mutations exist yet.

### Phase 1 exit criteria

- All Meta read tabs work against a real Spotless Homes ad account
- Diagnostics surface at least 3 real issues on the live account, referencing Meta's own returned signals where present
- `GET /api/optimization-report?metaAdAccountId=…&customerId=…&propertyId=…` returns a merged blob with `meta`, `googleAds`, `analytics`, `crossReference.metaByCampaign`
- Campaign Assistant can answer "which Meta ads have fatigue?" and "should I move budget from Google to Meta?" using the extended report
- No writes anywhere — enforced by the grep invariant in 1B

## Phase 1.5 — App Review submission for `ads_read`

Once Phase 1 is stable in production against our own accounts, submit App Review for `ads_read` **only**.

Deliverables Meta asks for:
- Screencast: log in → connect Meta ad account → view dashboard → download JSON → disconnect
- Written description: paste from [meta-ads-api-design-doc.md](./meta-ads-api-design-doc.md) "Tool Design" section, edit to reflect that Phase 1 is read-only
- Business verification: already done
- Data-handling / deletion instructions URL: reuse the existing Privacy Policy page

Do not start Phase 2 until Phase 1.5 is approved.

## Phase 2 — Meta mutations, dispatched through Campaign Assistant (target: 3–4 days after Phase 1.5 approval)

Every mutation is user-confirmed via the existing action-plan Apply flow. No new mutation subsystem.

### 2A — Extend `metaAdsService.js` with mutation methods

```js
setAdStatus(token, adId, status)                     // POST /{ad_id} status=ACTIVE|PAUSED
setAdSetStatus(token, adSetId, status)
setCampaignStatus(token, campaignId, status)
updateAdSetBudget(token, adSetId, { dailyBudget | lifetimeBudget })
updateCampaignBudget(token, campaignId, { dailyBudget | lifetimeBudget })
```

Same file the reads live in, appended below the reads. Match the `pauseCampaign(...)` etc. pattern in `googleAdsService.js`:
- Return `{ noop: true, reason }` when the target is already in the requested state
- Return `{ previousStatus, newStatus }` or `{ previousDailyBudget, newDailyBudget }` on success (used by the assistant to summarize what happened)

### 2B — Extend the action-plan schema (minimal)

Two changes, both trivial:

1. **New `type` value** on `campaign_assistant_action_plan_steps`: `meta_ads_action`. This is just a `VARCHAR(32)` — no schema migration required, just an update to the assistant's plan-generation prompt so it can emit the new type.
2. **New column** on `campaign_assistant_conversations`: `meta_ads_account_id VARCHAR(64) NULL` and optionally `meta_ads_business_id VARCHAR(64) NULL`. Single ALTER TABLE.

### 2C — Extend the Apply dispatcher at [campaignAssistant.js:2069](../backend/src/routes/campaignAssistant.js#L2069)

Add:
- `if (step.type !== 'google_ads_action' && step.type !== 'meta_ads_action' && step.type !== 'app_code_change')` — permit the new type at the top-of-handler guard ([campaignAssistant.js:2046](../backend/src/routes/campaignAssistant.js#L2046))
- New `switch` cases:
  - `case 'pause_meta_ad':`
  - `case 'resume_meta_ad':`
  - `case 'pause_meta_adset':`
  - `case 'resume_meta_adset':`
  - `case 'set_meta_adset_budget':`
  - (Optionally `pause_meta_campaign` / `resume_meta_campaign` / `set_meta_campaign_budget` — but Meta budget optimization typically lives on the ad set, so ad-set-level cases cover most usage.)

Each case:
1. Resolves the Meta ad account via a new `resolveMetaAdAccount(userId, conv.meta_ads_account_id)` helper mirroring the existing `resolveAdsCustomer`
2. Resolves the long-lived Meta access token via `metaService.getLongLivedUserToken` (or the cached one on `connected_accounts`)
3. Validates required `action_params` (entity id, new value)
4. Calls the `metaAdsService` mutation method
5. Shapes `executed.summary` (e.g. "Paused ad 123456 (was ACTIVE). Re-enable in Meta Ads Manager → Ads → toggle status.") and `noop`

No new table, no `metaAdsActions.js`, no `meta_ads_actions` audit table. The `status='applied'|'failed'` transition on `campaign_assistant_action_plan_steps` plus `applied_at`, `applied_error`, and `notes` IS the audit trail — same as Google Ads has today.

### 2D — Ship pause/resume + budget only

Explicitly out of scope for the first Meta write release:
- **Boost Post** (creating a new campaign + adset + ad from an organic post) — this is a substantially larger mutation than changing one field on an existing entity. Deferred to Phase 2E.
- Bid strategy changes — deferrable; add if a specific customer needs it.
- Creative updates — deferrable.
- Custom Audiences uploads — separate scope + separate PII review, not planned.

### 2E — (Later) Boost Post

Ship after 2A–2D are proven in production. Boost Post is a multi-endpoint sequence (`POST /campaigns`, `POST /adsets`, `POST /adcreatives`, `POST /ads`) and warrants its own action_type (`boost_post`) with its own dispatcher case and its own review-panel UI in Campaign Assistant. Do not bundle it into the first write submission.

### Phase 2 exit criteria

- Pause/resume works end-to-end for ad, ad set, and (if included) campaign level
- Budget adjustment works end-to-end at the ad set level
- Every mutation appears in `campaign_assistant_action_plan_steps` with `status='applied'` or `'failed'` and populated `applied_at`, `applied_error`, `notes`
- No scheduled/background jobs invoke any Meta mutation — verifiable by grepping `campaignMonitorService.js`, `automationExecutor.js`, and any cron/tick endpoints for Meta mutation service methods (should be zero)

## Phase 2.5 — App Review for `ads_management`

Deliverables Meta will scrutinize:
- Screencast showing every write action end-to-end through Campaign Assistant: assistant produces a plan → user reviews plan with current/proposed values visible → user confirms → mutation happens → success state visible
- Confirmation dialogs must be visible in the screencast — reviewers reject aggressively for anything that looks like automation
- Written justification: paste from [meta-ads-api-design-doc.md](./meta-ads-api-design-doc.md) "Write" section
- Explicit statement of the invariant: **Each mutation batch is initiated by an explicit user confirmation. The system performs only the finite set of changes displayed to the user in that confirmation; no later or background mutations occur.**

## What we're NOT building

- **Automated rules** ("if CPA > $80 then pause") — deferred indefinitely. Different compliance risk profile, harder App Review, easier to burn spend on a bug.
- **A separate Meta mutation router or audit table** — the Campaign Assistant action-plan tables already handle this.
- **Bulk creative generation** — different product concern.
- **Custom Audiences uploads** — requires separate scope + PII review.
- **A reimplementation of Meta's delivery optimization logic** — surface Meta's `effective_status` and `issues_info` verbatim instead.

## Effort estimate

| Phase | Work | Elapsed |
|---|---|---|
| 0 | Meta app setup + API version verification | 0.5 day |
| 1A | metaAdsService read client | 1 day |
| 1B | Read routes | 0.5 day |
| 1C | Diagnostics engine + MetaAds.js dashboard | 2 days |
| 1D | Meta in optimizationReportService | 1 day |
| 1E | Assistant read-awareness + conversation column | 0.5 day |
| 1.5 | ads_read App Review submission | ~2h work, 3–7 business days wait |
| 2A | Meta mutation methods in metaAdsService | 0.5 day |
| 2B | Schema: new type value + conversation column | 0.25 day |
| 2C | Extend Apply dispatcher + resolveMetaAdAccount helper | 1 day |
| 2D | Ship pause/resume + budget | ~1 day of QA against real account |
| 2.5 | ads_management App Review submission | ~4h work, 5–14 business days wait |

Total build effort: ~8–9 working days. Total calendar time incl. Meta reviews: ~3–4 weeks. Boost Post (2E) adds another ~2–3 days if pursued.
