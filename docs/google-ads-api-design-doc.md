**Note:** if your tool is externally accessible, please make sure you include screenshots or mock-ups of your tool.

**Company Name:** Geos LLC

**Business Model:** My company operates Spotless Homes, a residential cleaning service with locations in Tampa and Jacksonville, Florida, along with related small-business tooling. We run Google Ads campaigns for our own Spotless Homes locations (spotless.homes, spotlesshomes-tampa, spotlesshomes-jacksonville) and for a small number of connected service-business owners whose accounts we help review. We only advertise for accounts owned by our own company or explicitly connected to our tool by their owner via OAuth.

**Tool Access/Use:** Our tool, Post-To, is used by employees within our company (Spotless Homes location managers and Geos LLC marketing team) plus a small group of connected service-business owners who authenticate their own Google Ads accounts. Users log in with Google, connect their Google Ads customer via OAuth 2.0 with the `adwords` scope, and view read-only performance dashboards. The tool includes a JSON export button so authenticated users can download their own report data. There is no ability to make changes to campaigns, bids, budgets, keywords, ads, conversions, or any other account resource — the entire integration is read-only.

**Tool Design:** For the reporting aspect of our tool, we pull metrics from the Google Ads API on demand — data is not persisted to a database, every dashboard load re-queries the API live. The UI displays campaign, ad group, keyword, search-term, and quality-score reports across configurable date ranges (7, 30, 90 days) alongside a diagnostics section that surfaces prioritized issues (lost impression share to budget/rank, low ad strength, low quality-score keywords, wasted spend, missing primary conversion actions). No hourly sync, no automated ad management, no writes of any kind.

**API Services Called:**
- List accessible customers via `CustomerService.listAccessibleCustomers`
- Pull account, campaign, ad group, keyword, search-term, ad, asset, conversion, geographic, audience, quality-score, and change-history reports via `GoogleAdsService.Search` (GAQL SELECT queries only)
- Read Google's own recommendations via the `recommendation` resource
- All operations are read-only. No mutate services are called (no `CampaignService.mutate`, `AdGroupService.mutate`, `ConversionUploadService`, `OfflineUserDataJobService`, `UserDataService`, etc.)

**Tool Mockups:** Here is a mockup of the Post-To Google Ads dashboard:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  📢 Google Ads                                    [7d] [30d] [90d]      │
│  Read-only campaign diagnostics — no bid changes, no edits.             │
│                                                                          │
│  Customer: Spotless Homes Tampa (123-456-7890) · USD · America/New_York │
│                                                                          │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐              │
│  │ Spend       │ Impressions │ Clicks      │ CTR         │              │
│  │ $1,038      │ 101,120     │ 5,430       │ 5.37%       │              │
│  ├─────────────┼─────────────┼─────────────┼─────────────┤              │
│  │ Avg CPC     │ Conversions │ Cost / Conv │ Conv. Rate  │              │
│  │ $0.19       │ 492         │ $2.11       │ 9.06%       │              │
│  └─────────────┴─────────────┴─────────────┴─────────────┘              │
│                                                                          │
│  [Overview] [Diagnostics] [Campaigns] [Keywords] [Search Terms] [...]   │
│  ─────────                                                              │
│                                                                          │
│  🚨 Diagnostics                                                          │
│                                                                          │
│  ⚠ HIGH  Search impression share lost due to budget          34%        │
│           2 campaigns · Guidance: raise budgets on campaigns             │
│           where lost IS (budget) >5% AND ROAS is healthy.               │
│                                                                          │
│  ⚠ HIGH  Search terms with spend but no conversions          $187       │
│           18 terms · Guidance: add these as negative keywords            │
│           if intent is off, or improve ads if intent is right.          │
│                                                                          │
│  ⚠ MED   Ad strength below Good                              3 ads      │
│           Guidance: add more headlines/descriptions to reach            │
│           Good/Excellent. Google recommends 15 headlines +              │
│           4 descriptions per RSA.                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

The mockup shows the Overview cards (spend/impressions/clicks/CTR/CPC/conversions/CPA/conversion rate), tabbed section navigation, and the Diagnostics section which surfaces prioritized issues with severity, count, and specific guidance for each. The full tool includes additional tabs for Campaigns, Ad Groups, Keywords, Search Terms, Ads, Assets, Recommendations, Conversions, Devices, Locations, Day & Hour heatmap, Audience, Auction Insights, Quality Scores, and Change History — all read-only, all showing data live-fetched from the Google Ads API for the authenticated user's own connected customer.
