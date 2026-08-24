**Note:** if your tool is externally accessible, please make sure you include screenshots or mock-ups of your tool.

**Company Name:** Geos LLC

**Business Model:** My company operates Spotless Homes, a residential cleaning service with locations in Tampa and Jacksonville, Florida, along with related small-business tooling. We run Facebook and Instagram ad campaigns for our own Spotless Homes locations (spotless.homes, spotlesshomes-tampa, spotlesshomes-jacksonville) and for a small number of connected service-business owners whose accounts we help review. We only advertise for ad accounts owned by our own company or explicitly connected to our tool by their owner via Facebook Login.

**Tool Access/Use:** Our tool, Post-To, is used by employees within our company (Spotless Homes location managers and Geos LLC marketing team) plus a small group of connected service-business owners who authenticate their own Facebook / Meta Business accounts. Users log in with Facebook, connect their Meta ad account via OAuth 2.0 with the `ads_read` and `ads_management` scopes, and view performance dashboards over their own ad accounts. The tool includes a JSON export button so authenticated users can download their own report data. Write operations are limited to a small, explicit set of actions the authenticated user reviews and confirms inside the tool's Campaign Assistant — the assistant surfaces recommended changes, the user reviews the specific entities and new values, and only after the user explicitly confirms the recommendation batch does the tool call any Marketing API mutate endpoint.

**Tool Design:** For the reporting aspect of our tool, we pull metrics from the Meta Marketing API on demand — data is not persisted to a database, every dashboard load re-queries the API live. The UI displays account, campaign, ad set, ad, and placement reports across configurable date ranges (7, 30, 90 days) alongside a diagnostics section that surfaces prioritized issues based on the account's actual returned delivery state (frequency, CPA vs. account average, delivery-status warnings and `issues_info` fields Meta itself returns). Every write operation flows through the same Campaign Assistant action-plan mechanism the tool already uses for Google Ads: the assistant compiles a plan, presents each recommended change to the user with the current value and proposed value clearly shown, and the user reviews and confirms the plan. Each mutation batch is initiated by an explicit user confirmation. The system performs only the finite set of changes displayed to the user in that confirmation; no later or background mutations occur. There is no scheduled job, cron, or automated rule engine that mutates campaigns.

**API Services Called:**

*Read (via `ads_read`):*
- List ad accounts the authenticated user has access to via `GET /me/adaccounts`
- Pull account, campaign, ad set, ad, and creative metadata via `GET /act_{ad_account_id}/{campaigns|adsets|ads|adcreatives}`
- Pull performance metrics via `GET /{node}/insights` (spend, impressions, reach, clicks, CTR, CPC, CPM, results, cost per result, ROAS, frequency, video views) with `breakdowns` for placement, device, age, gender, region as requested by the user's active dashboard view
- Read delivery status and Meta-returned issues via the `effective_status` and `issues_info` fields on ad / ad set / campaign — the tool treats Meta's returned delivery state as authoritative rather than reimplementing Meta's delivery logic
- Read attribution and conversion setup via `GET /act_{ad_account_id}/customconversions` and `GET /{pixel_id}`

*Write (via `ads_management`):*
- Toggle campaign / ad set / ad status between `ACTIVE` and `PAUSED` via `POST /{node_id}` with `status` — for the "pause underperformers" recommendation
- Update ad set `daily_budget` or `lifetime_budget` via `POST /{adset_id}` — for the "adjust budget" recommendation
- Update campaign-level budget for CBO campaigns via `POST /{campaign_id}`
- Update ad set `bid_amount` or `bid_strategy` — for the "adjust bid" recommendation

All writes are invoked from within the Campaign Assistant action-plan Apply flow. Each Apply invocation corresponds to a specific plan step the user has reviewed and confirmed. The system does not mutate ads outside of that flow — no scheduled tasks, no cron, no background loop calls any Marketing API mutate endpoint.

**Tool Mockups:** Here is a mockup of the Post-To Meta Ads dashboard:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  📘 Meta Ads (Facebook + Instagram)         [7d] [30d] [90d]            │
│  Campaign diagnostics — actions applied via Campaign Assistant.         │
│                                                                          │
│  Ad account: Spotless Homes Tampa (act_1234567890) · USD · New_York     │
│                                                                          │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐              │
│  │ Spend       │ Impressions │ Reach       │ Frequency   │              │
│  │ $2,140      │ 312,480     │ 84,220      │ 3.71        │              │
│  ├─────────────┼─────────────┼─────────────┼─────────────┤              │
│  │ CTR         │ CPM         │ Results     │ Cost/Result │              │
│  │ 1.42%       │ $6.85       │ 121         │ $17.68      │              │
│  └─────────────┴─────────────┴─────────────┴─────────────┘              │
│                                                                          │
│  [Overview] [Diagnostics] [Campaigns] [Ad Sets] [Ads] [Placements] […]  │
│  ─────────                                                              │
│                                                                          │
│  🚨 Diagnostics                                                          │
│                                                                          │
│  ⚠ HIGH  Ads with high frequency                             5 ads      │
│           Guidance: refresh creative or pause. Meta's delivery           │
│           telemetry shows CTR falling on these ads.                      │
│           [Review with Campaign Assistant →]                             │
│                                                                          │
│  ⚠ HIGH  Delivery issues reported by Meta                    3 sets     │
│           Meta returned issues_info on 3 ad sets. Surfacing              │
│           Meta's own guidance verbatim.                                  │
│           [Review with Campaign Assistant →]                             │
│                                                                          │
│  ⚠ MED   Ads with CPA > 2× account average                   4 ads      │
│           Guidance: pause outliers so budget can flow to more            │
│           efficient ads inside the same ad set.                          │
│           [Review with Campaign Assistant →]                             │
└─────────────────────────────────────────────────────────────────────────┘
```

The Meta Ads dashboard is a **read-only view**: Overview cards, tabbed section navigation (Campaigns, Ad Sets, Ads, Placements, Creatives, Demographics, Devices, Day & Hour, Delivery Issues), and a Diagnostics section. The Diagnostics tab does not itself execute any mutation — each issue card offers a "Review with Campaign Assistant" CTA that opens the assistant with the flagged entities pre-loaded as context. The assistant then produces an action plan the user reviews before confirming.

The Campaign Assistant plan-review UI (already in production for Google Ads) is where every write happens. Each plan step displays: the entity type and ID being changed, the current value, the proposed new value, and the assistant's reason. The user reviews the entire plan and confirms it explicitly. Only then does the backend translate each confirmed step into the corresponding Marketing API call.

**Data handling:**
- Access tokens are stored encrypted at rest in Supabase, keyed to the authenticated user
- Report data is not persisted between requests — every dashboard load fetches live from the API
- Action plans and step-level audit records (which entities were changed, from what value to what value, and whether the API call succeeded or failed) are stored in the existing Campaign Assistant action-plan tables (`campaign_assistant_action_plans`, `campaign_assistant_action_plan_steps`)
- No user data is shared with third parties; no data leaves Geos LLC's infrastructure except back to Meta for the API calls above
- Users can disconnect their ad account at any time via the Connections page, which revokes the token and removes all stored credentials

**Implementation note for the engineering agent:** the current Marketing API version (`v21.0` in the existing organic-posting Graph API integration is not necessarily the correct choice for the Marketing API surface) and the exact field names on `insights`, `effective_status`, and `issues_info` must be validated against Meta's live developer documentation and the actual response bodies returned by the target ad account before coding. Do not freeze an API version or field list in advance of that validation.
