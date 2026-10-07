-- Subscription state — powers the Analytics page's trial sections.
--
-- Source today: Apple App Store Server Notifications V2, forwarded by
-- proof-pix-proxy to POST /api/webhooks/subscription-event after it verifies
-- the signedPayload. Planned future source: Google Play RTDN, forwarded the
-- same way. Nothing in this schema is Apple-specific.
--
-- Two tables:
--   subscription_events — append-only raw event log (every webhook POST).
--     Source of truth; keeps full payload for forensic queries + replay.
--   trial_states       — derived per-subscriber current state. Last-write-wins
--     upsert driven by subscription_events ingestion. Reads come from here.
--
-- Status transitions (see backend/src/services/subscriptionStateService.js):
--   trialing            → in free trial right now
--   active              → paid period (converted from trial, or direct purchase)
--   canceled_in_trial   → canceled while still trialing (user won't be charged)
--   converted           → trial → first paid renewal observed
--   expired             → trial or subscription ended without conversion
--   billing_issue       → payment failed, in grace period
--   paused              → store-level pause (Play Store only)
--
-- Dedupe: subscription_events.event_id has a UNIQUE index (= Apple's
-- notificationUUID). The webhook route uses ON CONFLICT (event_id) DO NOTHING
-- so retries are a no-op.
--
-- Safe to re-run.

-- ---------- subscription_events ----------
CREATE TABLE IF NOT EXISTS subscription_events (
  id              BIGSERIAL PRIMARY KEY,
  event_id        TEXT UNIQUE NOT NULL,       -- RC event.id — dedupe key
  event_type      TEXT NOT NULL,              -- INITIAL_PURCHASE / RENEWAL / CANCELLATION / …
  app_user_id     TEXT NOT NULL,              -- RC subscriber identifier
  product_id      TEXT,                       -- com.post_to.pro.monthly, etc.
  period_type     TEXT,                       -- TRIAL / NORMAL / INTRO / PROMOTIONAL
  purchased_at    TIMESTAMPTZ,                -- when the period started (RC: purchased_at_ms)
  expiration_at   TIMESTAMPTZ,                -- when the period ends    (RC: expiration_at_ms)
  is_trial_period BOOLEAN,
  cancel_reason   TEXT,                       -- CUSTOMER_SUPPORT / UNSUBSCRIBE / BILLING_ERROR / …
  environment     TEXT,                       -- SANDBOX / PRODUCTION
  store           TEXT,                       -- APP_STORE / PLAY_STORE / STRIPE / PROMOTIONAL
  raw             JSONB NOT NULL,             -- full RC webhook body for audit / replay
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_events_user_time
  ON subscription_events (app_user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_events_type_time
  ON subscription_events (event_type, received_at DESC);

ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations on subscription_events" ON subscription_events;
CREATE POLICY "Allow all operations on subscription_events"
  ON subscription_events FOR ALL USING (true);

-- ---------- trial_states ----------
CREATE TABLE IF NOT EXISTS trial_states (
  app_user_id      TEXT PRIMARY KEY,
  plan_id          TEXT,                      -- starter / pro / business — mapped from product_id
  billing_period   TEXT,                      -- monthly / annual
  product_id       TEXT,                      -- raw store product id (preserved so unknown products are still visible)
  status           TEXT NOT NULL,             -- trialing / active / canceled_in_trial / converted / expired / billing_issue / paused
  trial_start_at   TIMESTAMPTZ,
  trial_end_at     TIMESTAMPTZ,               -- when trial ends (or ended); NULL when there was never a trial
  canceled_at      TIMESTAMPTZ,               -- when CANCELLATION fired (not when sub actually ends — that's expiration_at)
  converted_at     TIMESTAMPTZ,               -- when a trial → paid transition was observed
  last_event_type  TEXT,                      -- last webhook event we processed for this subscriber
  last_event_at    TIMESTAMPTZ NOT NULL,      -- MAX(purchased_at) across events — used for backdated-event guard
  environment      TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary read pattern: "all currently trialing, ending soonest first" (the Active trials section).
CREATE INDEX IF NOT EXISTS idx_trial_states_status_end
  ON trial_states (status, trial_end_at);

-- Secondary: "all users whose status moved to a post-trial bucket in the last N days".
CREATE INDEX IF NOT EXISTS idx_trial_states_last_event
  ON trial_states (last_event_at DESC);

ALTER TABLE trial_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations on trial_states" ON trial_states;
CREATE POLICY "Allow all operations on trial_states"
  ON trial_states FOR ALL USING (true);
