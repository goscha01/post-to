# Post-to Campaign Assistant: ad-hoc conversations (no campaign required)

## Context + motivation

The Campaign Assistant chat currently requires picking a Google Ads customer + campaign before the composer activates. The intent was to anchor the AI with a full optimization report snapshot. But in practice we have a growing set of tasks that need NO ad data — pure admin operations the Assistant can run via its tools:

- Register GA4 custom dimensions (`ga4_create_custom_dimension`)
- Mark events as GA4 Key Events (`markConversionEvent` / existing)
- Query ASC install funnel for a specific question
- One-off questions about settings / connections that don't need per-campaign context

Today users can't do these without first running a fake "campaign analysis" that pulls megabytes of irrelevant data. **Goal: let the user type a request directly in the chat and have it work, with the conversation showing up in Past analyses like a regular one.**

Reference example conversation the user tried to run and couldn't:
> *"Register two event-scoped custom dimensions: plan_id and billing_period."*

---

## Current state (file:line)

### Frontend ([frontend/src/components/CampaignAssistant.js](frontend/src/components/CampaignAssistant.js))

- Composer `<textarea>` at line 959 — disabled when `!activeConversation` (line 973)
- Placeholder "Start a new analysis first (pick a customer + campaign on the left)" (line 970-972)
- "Pick a customer and campaign to start" empty-state card at line 3146
- `activeConversation` state at line 149
- Create flow: `handleCreateConversation` validates customer + campaign at line 329, then calls `createConversation` at line 335
- Past analyses sidebar renders conversations from `conversations` state, click sets `activeConversation`

### Backend ([backend/src/routes/campaignAssistant.js](backend/src/routes/campaignAssistant.js))

- `POST /conversations` (line 559) hard-requires `customerId` (line 590) and `campaignId` (line 593)
- Runs full `optimizationReport.generateReport` (line 610) — expensive, pulls Google Ads + GA4 + Meta data
- Stores `report_snapshot` on conversation row (`campaign_assistant_conversations` table)
- `POST /conversations/:id/chat` (line 814) loads `report_snapshot` and inlines it into the system prompt — expects it to exist
- `resolveGa4ToolContext` (line 367) already has a fallback to the user's connected GA4 property if the conversation doesn't carry one (added in commit `bc67b6c`) — that fallback already works for ad-hoc flows
- Chat tool executor at line 1006-1013 — `ga4ToolCtx` / `ascToolCtx` already load regardless of whether a campaign is attached

---

## Required changes

### 1. Backend: new "ad-hoc" conversation path

Preferred: **extend `POST /conversations`** to accept an ad-hoc mode (so one endpoint, one path) rather than add a second route. Changes:

- Accept a new body flag like `mode: 'ad_hoc'` (or infer: if `customerId` is absent, treat as ad-hoc)
- When ad-hoc:
  - Skip the `customerId` / `campaignId` validation
  - Skip `optimizationReport.generateReport` entirely — no report snapshot to build
  - Store conversation row with `report_snapshot: null` and a reasonable default title (e.g. `title || "Ad-hoc chat · <YYYY-MM-DD>"`)
  - Still write to `campaign_assistant_conversations` so it shows up in Past analyses
- Keep the existing path (customer + campaign) completely unchanged — ad-hoc is additive

### 2. Backend: chat endpoint handles null report

`POST /conversations/:id/chat` currently assumes `conv.report_snapshot` is a populated object. Audit the system-prompt / message-building code to tolerate null:

- Where the report is injected into the prompt (`campaignAssistant.streamOpenAI` / `streamClaude` call sites around line 1019-1050), add a null-safe path. For ad-hoc chats, replace the "Here's the campaign report" block with a short "This is a general-purpose chat with access to the following tools" preface.
- Tools stay enabled — the `ga4ToolCtx` / `ascToolCtx` fallback already works. Only `googleAds` tool context will typically be unavailable in ad-hoc; `dispatchGoogleAds` already returns an "ads not connected for this conversation" error when it is, so that's safe.

### 3. Frontend: always-enabled composer

In [CampaignAssistant.js](frontend/src/components/CampaignAssistant.js):

- Enable the composer at line 973 even when `!activeConversation` (change `disabled={!activeConversation || streaming}` → `disabled={streaming}` once the compose-and-send path can create a conversation on the fly)
- Change the placeholder (line 970-972) to something like: *"Type a message to start — or pick a customer + campaign on the left for a full campaign analysis"*
- On first message when no `activeConversation`, auto-create an ad-hoc conversation (`POST /conversations` with `mode: 'ad_hoc'` + optional title derived from first ~40 chars of the message), then immediately send the message via the normal chat flow
- Keep the "+ Run analysis" button — that path is unchanged, just no longer the only way in

### 4. Frontend: Past analyses sidebar

Already renders every conversation — ad-hoc ones will show up automatically once backend creates them. Minor UX polish:
- Visually distinguish ad-hoc rows (small icon or `· ad-hoc` suffix) so users can tell "campaign analysis" from "chat"
- Default title for ad-hoc: use first 40 chars of the first user message if the user didn't specify

### 5. (Optional, scope-dependent) Empty-state card

The "Pick a customer and campaign to start" card at line 3146 — change messaging to invite ad-hoc chats:
> *"Type a question below for a quick answer, or pick a customer + campaign on the left for a full analysis."*

---

## Non-goals (don't do these)

- Don't change the existing campaign-analysis flow in any way beyond letting it coexist with ad-hoc
- Don't try to retrofit `report_snapshot` with "whatever data we can scrape" for ad-hoc chats — null is correct
- Don't add a separate ad-hoc endpoint — one unified `POST /conversations` with a mode flag is cleaner and the chat endpoint already works polymorphically
- Don't surface the mode flag in the UI as a toggle — infer from "did the user pick customer+campaign or not"

---

## Verification

1. Open Campaign Assistant with nothing selected
2. Composer should be active immediately
3. Type: *"List my GA4 custom dimensions"* and send to Claude
4. Expect: new conversation appears in Past analyses, Claude calls `ga4_list_custom_dimensions`, returns the list
5. Reload the page, click the new entry in Past analyses — conversation history should restore cleanly
6. Verify existing flow still works: pick a customer + campaign → "Run analysis" → full report generates as before

---

## Reference commits / files

- Chat tool executor + GA4 fallback: [backend/src/routes/campaignAssistant.js:367-402](backend/src/routes/campaignAssistant.js#L367-L402) (commit `bc67b6c`)
- GA4 custom dimension tools: [backend/src/services/campaignAssistantTools.js](backend/src/services/campaignAssistantTools.js) (commit `2d3ded1`)
- `campaign_assistant_conversations` table schema — check `backend/migrations/` or Supabase for the current column set; `report_snapshot` should already be nullable
