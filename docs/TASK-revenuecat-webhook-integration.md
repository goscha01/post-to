# Post-to: RevenueCat webhook integration — real trial state in the Analytics funnel

## Why

Today the Analytics page's "In trial / incomplete purchase (est.)" section ([frontend/src/components/Analytics.js:1075-1133](../frontend/src/components/Analytics.js#L1075-L1133)) is an arithmetic estimate: `purchase_started − purchase` from GA4 events. It conflates four distinct populations into one number:

1. Users actively in trial right now
2. Users whose trial ended and they canceled
3. Users whose trial ended and they converted to a paid plan (but the `purchase` event didn't fire or was deduped)
4. Payment failures / billing issues

GA4 **cannot** answer "when does this user's trial end", "did they cancel", or "which plan did they convert to". That state lives in RevenueCat. The existing in-app `purchase` event fires only from Apple Server Notifications V2 for confirmed paid periods ([backend/src/services/analyticsService.js:112-119](../backend/src/services/analyticsService.js#L112-L119)) — trial transitions are invisible.

This task wires a RevenueCat webhook into Post-to's backend, persists per-subscriber trial/subscription state, and surfaces it in the Analytics page.

---

## End-state UI (what the user sees)

Replace / augment the "In trial / incomplete purchase (est.)" block with two real sections, both backed by live RevenueCat data:

### Section A — Active trials (status = `trialing`)

```
Active trials                                           12
  ↳ pro        monthly   ends in 3d · 4 users
  ↳ business   annual    ends in 5d · 3 users
  ↳ pro        annual    ends in 7d · 2 users
  ↳ business   monthly   ends in 1d · 2 users
  ↳ starter    monthly   ends tomorrow · 1 user
```

Per-user ETA computed from `trial_end_at`. Row ordering: soonest-ending first (urgency surfaces churn risk).

### Section B — Post-trial outcome (last N days)

```
Post-trial outcome (last 30 days)                       26 ended
  Converted to paid                                     18 (69%)
    ↳ pro        monthly    8 users
    ↳ business   annual     5 users
    ↳ pro        annual     3 users
    ↳ business   monthly    2 users
  Canceled in trial                                      7 (27%)
    ↳ pro        monthly    4 users
    ↳ business   annual     2 users
    ↳ starter    monthly    1 user
  Expired (payment failed)                               1 (4%)
    ↳ pro        annual     1 user
```

Status buckets come from the derived `status` column (see schema below).

---

## Architecture

```
RevenueCat (SaaS)
  │
  │  POST /api/webhooks/revenuecat
  │  Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>
  ▼
Post-to backend (self-post Railway service)
  │
  │  INSERT into subscription_events
  │  UPSERT into trial_states
  ▼
Supabase (postgres)
  │
  │  GET /api/analytics/subscription-state?days=30
  ▼
Analytics page
```

**Why webhooks (not polling the RevenueCat REST API):** RC fires each lifecycle event as it happens — no reconciliation drift. Our ingestion is append-only (`subscription_events`) + a derived upsert (`trial_states`), both idempotent on `event_id`.

---

## Task 1 — RevenueCat side (one-time config)

Done in the RevenueCat dashboard under **Integrations → Webhooks** for the ProofPix project:

- URL: `https://self-post-production.up.railway.app/api/webhooks/revenuecat`
- Authorization header: `Bearer <REVENUECAT_WEBHOOK_SECRET>` (generate a 32+ byte token, store in Railway env + AWS Secrets Manager `geos-dashboard-tokens` as `REVENUECAT_WEBHOOK_SECRET`)
- Events to subscribe: `INITIAL_PURCHASE`, `RENEWAL`, `CANCELLATION`, `UNCANCELLATION`, `NON_RENEWING_PURCHASE`, `EXPIRATION`, `BILLING_ISSUE`, `PRODUCT_CHANGE`, `SUBSCRIBER_ALIAS`, `SUBSCRIPTION_PAUSED`, `TRANSFER` (ingest all; backend decides which affect `trial_states`)

Confirm RC's `app_user_id` is set to the same identifier Post-to can tie back to a user (GA4 `user_id` dimension, or an auth user id if the mobile app logs in).

---

## Task 2 — Backend: webhook ingestion + schema

### Schema (two new tables)

Append to the existing Supabase SQL migrations folder (or add via Supabase SQL editor — this project doesn't appear to use a migration framework; grep `backend/src/db` to confirm the convention before writing).

```sql
-- Raw event log — append-only, source of truth.
CREATE TABLE subscription_events (
  id                BIGSERIAL PRIMARY KEY,
  event_id          TEXT UNIQUE NOT NULL,       -- RC event.id — dedupe key
  event_type        TEXT NOT NULL,              -- INITIAL_PURCHASE / CANCELLATION / …
  app_user_id       TEXT NOT NULL,              -- RC subscriber identifier
  product_id        TEXT,                       -- apple/google product id (e.g. com.post_to.pro.monthly)
  period_type       TEXT,                       -- TRIAL / NORMAL / INTRO
  purchased_at      TIMESTAMPTZ,
  expiration_at     TIMESTAMPTZ,
  is_trial_period   BOOLEAN,
  cancel_reason     TEXT,                       -- CUSTOMER_SUPPORT / PRICE_INCREASE / UNSUBSCRIBE / …
  environment       TEXT,                       -- SANDBOX / PRODUCTION
  store             TEXT,                       -- APP_STORE / PLAY_STORE / STRIPE / PROMOTIONAL
  raw               JSONB NOT NULL,             -- full RC payload for forensic queries
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON subscription_events (app_user_id, received_at DESC);
CREATE INDEX ON subscription_events (event_type, received_at DESC);

-- Derived per-subscriber current state. Upserted on every event.
CREATE TABLE trial_states (
  app_user_id       TEXT PRIMARY KEY,
  plan_id           TEXT,                       -- pro / business / starter — mapped from product_id
  billing_period    TEXT,                       -- monthly / annual
  product_id        TEXT,
  status            TEXT NOT NULL,              -- trialing / active / canceled_in_trial /
                                                -- converted / expired / billing_issue / paused
  trial_start_at    TIMESTAMPTZ,
  trial_end_at      TIMESTAMPTZ,                -- NULL when not currently trialing
  canceled_at       TIMESTAMPTZ,                -- when CANCELLATION fired (not when sub actually ends)
  converted_at      TIMESTAMPTZ,                -- when trial → active transition observed
  last_event_type   TEXT,
  last_event_at     TIMESTAMPTZ NOT NULL,
  environment       TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON trial_states (status, trial_end_at);  -- for "ending soon" query
```

### `product_id` → `plan_id` + `billing_period` mapping

Hard-code a small map in `backend/src/services/subscriptionState.js` — exact IDs come from App Store Connect / Google Play consoles. **Grep ProofPix repo for the real product IDs before writing** (don't guess). Shape:

```js
const PRODUCT_MAP = {
  'com.post_to.pro.monthly':      { planId: 'pro',      billingPeriod: 'monthly' },
  'com.post_to.pro.annual':       { planId: 'pro',      billingPeriod: 'annual'  },
  'com.post_to.business.monthly': { planId: 'business', billingPeriod: 'monthly' },
  'com.post_to.business.annual':  { planId: 'business', billingPeriod: 'annual'  },
  'com.post_to.starter.monthly':  { planId: 'starter',  billingPeriod: 'monthly' },
};
```

Unknown product_ids → `planId: 'unknown', billingPeriod: 'unknown'` (do not throw; some promotional/test products won't be in the map).

### Status derivation (apply in order)

```
is_trial_period && event_type ∈ {INITIAL_PURCHASE, RENEWAL}  →  trialing
event_type == CANCELLATION && current status == trialing      →  canceled_in_trial
event_type ∈ {RENEWAL, PRODUCT_CHANGE} && !is_trial_period
  && previous status == trialing                              →  converted
event_type == EXPIRATION                                      →  expired
event_type == BILLING_ISSUE                                   →  billing_issue
event_type == SUBSCRIPTION_PAUSED                             →  paused
event_type == UNCANCELLATION && previous.canceled_at          →  (revert to trialing or active based on expiration_at)
event_type == RENEWAL && !is_trial_period                     →  active
```

Edge cases to handle (write a comment, not clever code):
- **Backdated events** — RC can replay. The upsert should only overwrite `trial_states` when the incoming event's `purchased_at` is >= `last_event_at` on the existing row. Otherwise, insert into `subscription_events` and skip the upsert.
- **Multiple products per user** — rare but possible (user switches tier). `trial_states` is keyed by `app_user_id` so last-write-wins; relies on RC emitting PRODUCT_CHANGE correctly.
- **SUBSCRIBER_ALIAS** — RC emits when two `app_user_id`s merge. Needs a one-time UPDATE of all rows for the old alias → new alias, then delete the old `trial_states` row.

### Route

File: [backend/src/routes/webhooks.js](../backend/src/routes/webhooks.js) (new — or extend if one exists for other inbound webhooks)

```js
// POST /api/webhooks/revenuecat
// Auth: Bearer token comparison against REVENUECAT_WEBHOOK_SECRET.
// Rate: RC retries with exponential backoff on non-2xx. Always return 2xx
// after persisting the raw event; status derivation can throw without
// causing retries (would double-insert).
router.post('/revenuecat', express.json({ limit: '512kb' }), async (req, res) => {
  // 1. Verify Authorization header matches REVENUECAT_WEBHOOK_SECRET (constant-time compare)
  // 2. Insert into subscription_events with event_id dedupe (ON CONFLICT DO NOTHING)
  // 3. If insert actually happened (not a dupe), call deriveTrialState() to upsert trial_states
  // 4. Return 200 within 5s (RC webhook timeout). Derive step can be fire-and-forget.
});
```

Register the route in [backend/src/index.js](../backend/src/index.js) **before** any body-parser middleware that might consume the raw body — RC webhooks don't require raw-body signature verification (unlike Stripe), so plain `express.json()` on just this route is fine.

---

## Task 3 — Backend: analytics endpoint

File: [backend/src/services/analyticsService.js](../backend/src/services/analyticsService.js) (extend) or new `backend/src/services/subscriptionStateService.js` if it keeps growing

```js
// Returns:
// {
//   active: {
//     total: 12,
//     byPlan: [
//       { planId: 'pro', billingPeriod: 'monthly', users: 4, nextEndAt: '2026-10-10T…' },
//       …
//     ],
//     endingSoon: [
//       { appUserId: '…', planId: 'pro', billingPeriod: 'monthly', endsAt: '…', daysLeft: 1 },
//       …
//     ]
//   },
//   postTrial: {
//     windowDays: 30,
//     totalEnded: 26,
//     converted:          { total: 18, byPlan: [...] },
//     canceled_in_trial:  { total: 7,  byPlan: [...] },
//     expired:            { total: 1,  byPlan: [...] }
//   }
// }
async function getSubscriptionState(userId, days = 30) {
  // Query trial_states where status = 'trialing' → active section
  // Query trial_states where status IN (converted, canceled_in_trial, expired)
  //   AND last_event_at >= now() - days → postTrial section
}
```

Route: `GET /api/analytics/subscription-state?days=30` in [backend/src/routes/analytics.js](../backend/src/routes/analytics.js).

**Scoping:** currently there's no multi-tenancy on subscription data — all RC events belong to one ProofPix app. So the endpoint is just gated on an authenticated session (`req.user.userId`), not filtered by user. Revisit if Post-to ever serves multiple RC-tracked apps.

---

## Task 4 — Frontend wiring

File: [frontend/src/services/analyticsService.js](../frontend/src/services/analyticsService.js) — add:

```js
const getSubscriptionState = async (days) => {
  const res = await axios.get('/api/analytics/subscription-state', { params: { days } });
  return res.data;
};
```

File: [frontend/src/components/Analytics.js](../frontend/src/components/Analytics.js)

Replace the `InTrialEstimate` component at [L1075-L1133](../frontend/src/components/Analytics.js#L1075-L1133) with a `SubscriptionState` component rendering the two sections above. Keep the arithmetic estimate as a **fallback** only when the API returns `{ unavailable: true }` (RC webhook not yet receiving events — initial deploy window). Show a small `Live via RevenueCat` or `Estimated from GA4 events` label so the user knows which source is active.

---

## Task 5 — Observability

- Log every webhook POST via `loghub-client`: `service: 'post-to', level: 'info', message: 'revenuecat_webhook', attrs: { event_type, app_user_id, product_id, is_trial_period, environment }`
- Log dedupe hits at `debug` level
- Log status transitions at `info` level: `trial_state_transition`, `{ app_user_id, from, to, event_type }`
- Add a Grafana query for `{service_name="post-to"} |= "revenuecat_webhook"` to the dashboards worth bookmarking

---

## Verification

1. **Local tunnel test** — Point RC webhook at an `ngrok` tunnel to localhost:3001, trigger a sandbox purchase in the ProofPix TestFlight build, confirm `subscription_events` row inserted + `trial_states` upserted with status=`trialing`.
2. **Idempotency** — Replay the same webhook twice (RC dashboard has a "resend" button). Confirm second POST is a dedupe (no second `subscription_events` insert, no change to `trial_states.updated_at`).
3. **Status transitions** — In sandbox, cancel the subscription from Settings → Apple ID. Confirm CANCELLATION event arrives + `trial_states.status` flips to `canceled_in_trial`.
4. **UI** — Load Analytics page, confirm Active trials section populates. Trigger an EXPIRATION in sandbox (sandbox trials expire fast — ~3 min), confirm post-trial section updates after a page refresh.
5. **No regression** — With RC webhook disabled, confirm the Analytics page still renders (either falls back to the arithmetic estimate or shows the "unavailable" state).

---

## Reference locations

- Current `InTrialEstimate` placeholder: [frontend/src/components/Analytics.js:1075-1133](../frontend/src/components/Analytics.js#L1075-L1133)
- Analytics backend service: [backend/src/services/analyticsService.js](../backend/src/services/analyticsService.js)
- Analytics route (new endpoint lands here): [backend/src/routes/analytics.js](../backend/src/routes/analytics.js)
- Existing webhook example (user-facing publishing target — not a model for RC): [backend/src/routes/connections.js:221-227](../backend/src/routes/connections.js#L221-L227)
- Analytics frontend service (where `getSubscriptionState` goes): [frontend/src/services/analyticsService.js](../frontend/src/services/analyticsService.js)
- Centralized logger: `require('../utils/logger')` — already mirrors to Loki under `service_name=post-to`
- Railway service: `self-post-production` (svc `22c9c38b`) — webhook URL base is `https://self-post-production.up.railway.app`
- Secret storage: AWS Secrets Manager `geos-dashboard-tokens` (us-east-1) — add `REVENUECAT_WEBHOOK_SECRET`

---

## Scope: ~1 day for an agent familiar with the codebase

Breakdown:
- RC dashboard config + token generation: 20 min
- Schema + migration: 30 min
- Webhook route + ingestion + dedupe: 2h
- Status derivation + edge cases: 2h
- Analytics endpoint + aggregation query: 1h
- Frontend `SubscriptionState` component: 2h
- Verification (sandbox purchases, replay, UI check): 1h

**Non-goals (don't do these):**
- Don't backfill historical RC data via the REST API in v1. Start fresh on webhook deploy; GA4 estimate stays as fallback for the pre-deploy window.
- Don't try to tie RC subscribers back to GA4 `user_id` for cross-join queries yet. The two systems stay independent until there's a concrete use case that needs the join.
- Don't delete / migrate the existing GA4-based `purchase` event ingestion. It's additive — the `purchase` event stays as the GA4 funnel's "Paid" step; RC data powers the trial sections only.
- Don't build a per-subscriber detail page. Aggregates only in v1.
