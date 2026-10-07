// RevenueCat subscription state ingestion + read model.
//
// Two concerns:
//   1. ingestEvent({ event }) — called by the /api/webhooks/revenuecat route.
//      Inserts the raw event (dedupe on event_id) and upserts trial_states.
//   2. getSubscriptionState(days) — called by GET /api/analytics/subscription-state.
//      Aggregates trial_states for the Analytics page's Active trials +
//      Post-trial outcome sections.
//
// Status derivation lives in deriveNextState() — a pure function tested in
// isolation. Keeping it pure avoids race conditions between the raw-insert
// and the trial_states upsert.

const { createClient } = require('@supabase/supabase-js');
const { Client: PgClient } = require('pg');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// ---------- Self-applying migration ----------
//
// Mirrors ascAnalyticsScheduler.ensureTable() — probes for the tables via the
// Supabase JS client (REST, always reachable), and if missing, runs the CREATE
// TABLE DDL via a direct pg connection. The pg connection uses the IPv4
// pooler when available (SUPABASE_POOLER_URL) and falls back to the direct
// host (SUPABASE_DATABASE_URL), which Railway's container can resolve.
//
// Called from index.js at boot. Idempotent — safe to run on every restart.
// Logs its decision so the Railway log stream shows exactly what happened.
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS subscription_events (
  id              BIGSERIAL PRIMARY KEY,
  event_id        TEXT UNIQUE NOT NULL,
  event_type      TEXT NOT NULL,
  app_user_id     TEXT NOT NULL,
  product_id      TEXT,
  period_type     TEXT,
  purchased_at    TIMESTAMPTZ,
  expiration_at   TIMESTAMPTZ,
  is_trial_period BOOLEAN,
  cancel_reason   TEXT,
  environment     TEXT,
  store           TEXT,
  raw             JSONB NOT NULL,
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

CREATE TABLE IF NOT EXISTS trial_states (
  app_user_id      TEXT PRIMARY KEY,
  plan_id          TEXT,
  billing_period   TEXT,
  product_id       TEXT,
  status           TEXT NOT NULL,
  trial_start_at   TIMESTAMPTZ,
  trial_end_at     TIMESTAMPTZ,
  canceled_at      TIMESTAMPTZ,
  converted_at     TIMESTAMPTZ,
  last_event_type  TEXT,
  last_event_at    TIMESTAMPTZ NOT NULL,
  environment      TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trial_states_status_end
  ON trial_states (status, trial_end_at);
CREATE INDEX IF NOT EXISTS idx_trial_states_last_event
  ON trial_states (last_event_at DESC);
ALTER TABLE trial_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations on trial_states" ON trial_states;
CREATE POLICY "Allow all operations on trial_states"
  ON trial_states FOR ALL USING (true);
`;

async function ensureTables() {
  logger.info('revenuecat.ensure_tables.start', {});
  const { error: probeErr } = await supabase
    .from('trial_states')
    .select('app_user_id')
    .limit(1);
  if (!probeErr) {
    logger.info('revenuecat.ensure_tables.already_present', {});
    return { ok: true, ran: false };
  }
  const missing = /does not exist|undefined_table|PGRST20[24]|schema cache|not find the table/i.test(probeErr.message || '');
  if (!missing) {
    logger.warn('revenuecat.ensure_tables.probe_failed', { error: probeErr.message });
    return { ok: false, ran: false, error: probeErr.message };
  }

  const dbUrl = process.env.SUPABASE_POOLER_URL || process.env.SUPABASE_DATABASE_URL;
  if (!dbUrl) {
    logger.warn('revenuecat.ensure_tables.skipped', {
      reason: 'Neither SUPABASE_POOLER_URL nor SUPABASE_DATABASE_URL set',
    });
    return { ok: false, ran: false };
  }
  const usingPooler = !!process.env.SUPABASE_POOLER_URL;
  const client = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query(MIGRATION_SQL);
    logger.info('revenuecat.ensure_tables.applied', { via: usingPooler ? 'pooler' : 'direct' });
    return { ok: true, ran: true };
  } catch (err) {
    logger.warn('revenuecat.ensure_tables.apply_failed', {
      error: err.message,
      via: usingPooler ? 'pooler' : 'direct',
      hint: usingPooler ? null : 'Direct DB URL may be IPv6-only. Set SUPABASE_POOLER_URL (Supabase Dashboard → Settings → Database → Connection pooling → Transaction mode).',
    });
    return { ok: false, ran: false, error: err.message };
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------- Product mapping ----------
//
// Mirrors ProofPix's own productIdToPlan / productIdToBillingPeriod in
// proof-pix-native/src/services/iapService.js (search `export const
// productIdToPlan`). Keeping the logic identical means every product the
// mobile app ships maps correctly on both platforms:
//
//   iOS products:   com.goscha01.proofpix.{pro,business,enterprise}.{monthly,annual}
//                   com.goscha01.proofpix.{business,enterprise}.seat
//   Android:        com.goscha01.proofpix.{pro,business,enterprise}         (monthly)
//                   com.goscha01.proofpix.{pro,business,enterprise}.annual
//                   com.goscha01.proofpix.{business,enterprise}.seat
//
// Substring matching (not a hard-coded map) handles both platforms with one
// function and auto-covers any future SKU that follows the same convention.
// Order matters: enterprise/business/pro before falling to starter; seat
// takes precedence over annual/monthly for billing period.
function mapProduct(productId) {
  if (!productId) return { planId: null, billingPeriod: null };
  const s = String(productId);
  let planId;
  if (s.includes('enterprise') && !s.includes('seat')) planId = 'enterprise';
  else if (s.includes('business') && !s.includes('seat')) planId = 'business';
  else if (s.includes('pro')) planId = 'pro';
  else planId = 'starter';
  let billingPeriod;
  if (s.includes('.seat')) billingPeriod = 'seat';
  else if (s.includes('.annual')) billingPeriod = 'annual';
  else billingPeriod = 'monthly';
  return { planId, billingPeriod };
}

// ---------- Normalization ----------
//
// RC's webhook body uses nested `event` object. We flatten what we need into
// a stable shape so the rest of this file doesn't care about RC's envelope.
function normalizeRcEvent(body) {
  const e = body?.event || body || {};
  const toTs = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
  return {
    eventId: String(e.id || e.event_id || ''),
    eventType: String(e.type || '').toUpperCase(),
    appUserId: String(e.app_user_id || e.original_app_user_id || ''),
    productId: e.product_id || null,
    periodType: e.period_type || null,
    purchasedAt: toTs(e.purchased_at_ms),
    expirationAt: toTs(e.expiration_at_ms),
    isTrialPeriod: typeof e.is_trial_period === 'boolean' ? e.is_trial_period : null,
    cancelReason: e.cancel_reason || null,
    environment: e.environment || null,
    store: e.store || null,
    raw: body,
  };
}

// ---------- Status derivation ----------
//
// Pure function: given the current trial_states row (or null) and an incoming
// normalized event, returns the next trial_states row. Caller decides whether
// to UPSERT based on the backdated-event guard.
//
// Order matters — first matching rule wins:
//
//   is_trial_period=true & event ∈ {INITIAL_PURCHASE, RENEWAL}  → trialing
//   CANCELLATION & prior status=trialing                        → canceled_in_trial
//   CANCELLATION                                                → active (still paid until expiration)
//   RENEWAL w/o trial & prior status=trialing                   → converted
//   RENEWAL / NON_RENEWING_PURCHASE / PRODUCT_CHANGE            → active
//   INITIAL_PURCHASE w/o trial                                  → active
//   UNCANCELLATION & prior.canceled_at                          → revert to active/trialing
//   EXPIRATION                                                  → expired
//   BILLING_ISSUE                                               → billing_issue
//   SUBSCRIPTION_PAUSED                                         → paused
//
// SUBSCRIBER_ALIAS and TRANSFER are handled separately (merge rows, not state
// transition). TEST events are ignored by the webhook route before this runs.
function deriveNextState(current, evt) {
  const mapped = mapProduct(evt.productId);
  const base = {
    appUserId: evt.appUserId,
    planId: mapped.planId || current?.plan_id || null,
    billingPeriod: mapped.billingPeriod || current?.billing_period || null,
    productId: evt.productId || current?.product_id || null,
    trialStartAt: current?.trial_start_at || null,
    trialEndAt: current?.trial_end_at || null,
    canceledAt: current?.canceled_at || null,
    convertedAt: current?.converted_at || null,
    lastEventType: evt.eventType,
    lastEventAt: evt.purchasedAt || new Date().toISOString(),
    environment: evt.environment || current?.environment || null,
  };

  const priorStatus = current?.status || null;
  const inTrial = evt.isTrialPeriod === true || evt.periodType === 'TRIAL';

  switch (evt.eventType) {
    case 'INITIAL_PURCHASE':
      if (inTrial) {
        return {
          ...base,
          status: 'trialing',
          trialStartAt: evt.purchasedAt || base.trialStartAt,
          trialEndAt: evt.expirationAt || base.trialEndAt,
        };
      }
      return { ...base, status: 'active' };

    case 'RENEWAL':
      if (inTrial) {
        return {
          ...base,
          status: 'trialing',
          trialStartAt: base.trialStartAt || evt.purchasedAt,
          trialEndAt: evt.expirationAt || base.trialEndAt,
        };
      }
      // Trial → paid transition: mark conversion but don't overwrite trial_end_at
      // (so the UI can still show "converted on day N of trial").
      if (priorStatus === 'trialing') {
        return {
          ...base,
          status: 'converted',
          convertedAt: evt.purchasedAt || new Date().toISOString(),
        };
      }
      return { ...base, status: 'active' };

    case 'PRODUCT_CHANGE':
    case 'NON_RENEWING_PURCHASE':
      return { ...base, status: 'active' };

    case 'CANCELLATION':
      // RC fires CANCELLATION when the user *schedules* a cancellation — the
      // subscription is still active until expiration_at. Only flip to a
      // canceled bucket if we know they were still in trial; otherwise keep
      // them as active and just stamp canceled_at.
      if (priorStatus === 'trialing' || inTrial) {
        return {
          ...base,
          status: 'canceled_in_trial',
          canceledAt: evt.purchasedAt || new Date().toISOString(),
        };
      }
      return {
        ...base,
        status: priorStatus === 'active' ? 'active' : 'active',
        canceledAt: evt.purchasedAt || new Date().toISOString(),
      };

    case 'UNCANCELLATION':
      // Revert: trial? still trialing. Else active.
      return {
        ...base,
        status: inTrial || priorStatus === 'canceled_in_trial' ? 'trialing' : 'active',
        canceledAt: null,
      };

    case 'EXPIRATION':
      return { ...base, status: 'expired' };

    case 'BILLING_ISSUE':
      return { ...base, status: 'billing_issue' };

    case 'SUBSCRIPTION_PAUSED':
      return { ...base, status: 'paused' };

    default:
      // TEMPORARY_ENTITLEMENT_GRANT, TRANSFER, SUBSCRIBER_ALIAS, TEST, etc.
      // Record the event but don't change state.
      return current
        ? { ...base, status: priorStatus || 'active', lastEventType: evt.eventType }
        : null;
  }
}

// ---------- Ingestion ----------

// Returns { stored: bool, duplicate: bool, stateChanged: bool, newState? }
async function ingestEvent(rawBody) {
  const evt = normalizeRcEvent(rawBody);

  if (!evt.eventId) {
    throw Object.assign(new Error('event_id missing'), { status: 400 });
  }
  if (!evt.appUserId) {
    throw Object.assign(new Error('app_user_id missing'), { status: 400 });
  }
  if (!evt.eventType) {
    throw Object.assign(new Error('event type missing'), { status: 400 });
  }

  // 1) Insert raw event. ON CONFLICT (event_id) DO NOTHING for RC retry dedupe.
  const insertRes = await supabase
    .from('subscription_events')
    .insert({
      event_id: evt.eventId,
      event_type: evt.eventType,
      app_user_id: evt.appUserId,
      product_id: evt.productId,
      period_type: evt.periodType,
      purchased_at: evt.purchasedAt,
      expiration_at: evt.expirationAt,
      is_trial_period: evt.isTrialPeriod,
      cancel_reason: evt.cancelReason,
      environment: evt.environment,
      store: evt.store,
      raw: evt.raw,
    })
    .select('id');

  if (insertRes.error) {
    // 23505 = unique_violation on event_id — RC replayed the event. Treat as idempotent success.
    if (insertRes.error.code === '23505') {
      return { stored: false, duplicate: true, stateChanged: false };
    }
    throw insertRes.error;
  }

  // 2) Look up current trial_states row for backdated-event guard + prior status.
  const { data: existing, error: readErr } = await supabase
    .from('trial_states')
    .select('*')
    .eq('app_user_id', evt.appUserId)
    .maybeSingle();
  if (readErr) throw readErr;

  // Backdated event guard — if an older event arrives after a newer one (RC
  // replays or out-of-order delivery), skip the upsert so we don't regress
  // the derived state. The raw event is still persisted above.
  if (existing && existing.last_event_at && evt.purchasedAt) {
    if (new Date(evt.purchasedAt) < new Date(existing.last_event_at)) {
      logger.debug('revenuecat.ingest.backdated_skip', {
        appUserId: evt.appUserId,
        eventType: evt.eventType,
        eventAt: evt.purchasedAt,
        stateAt: existing.last_event_at,
      });
      return { stored: true, duplicate: false, stateChanged: false };
    }
  }

  const next = deriveNextState(existing, evt);
  if (!next) {
    return { stored: true, duplicate: false, stateChanged: false };
  }

  const { error: upsertErr } = await supabase
    .from('trial_states')
    .upsert({
      app_user_id: next.appUserId,
      plan_id: next.planId,
      billing_period: next.billingPeriod,
      product_id: next.productId,
      status: next.status,
      trial_start_at: next.trialStartAt,
      trial_end_at: next.trialEndAt,
      canceled_at: next.canceledAt,
      converted_at: next.convertedAt,
      last_event_type: next.lastEventType,
      last_event_at: next.lastEventAt,
      environment: next.environment,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'app_user_id' });
  if (upsertErr) throw upsertErr;

  if (existing?.status !== next.status) {
    logger.info('revenuecat.trial_state_transition', {
      appUserId: evt.appUserId,
      from: existing?.status || '(new)',
      to: next.status,
      eventType: evt.eventType,
      planId: next.planId,
      billingPeriod: next.billingPeriod,
    });
  }

  return {
    stored: true,
    duplicate: false,
    stateChanged: existing?.status !== next.status,
    newState: next.status,
  };
}

// ---------- Read model ----------

function daysBetween(fromIso, toIso) {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.round(ms / 86_400_000);
}

function groupByPlan(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.plan_id || 'unknown'}|${r.billing_period || 'unknown'}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        planId: r.plan_id || 'unknown',
        billingPeriod: r.billing_period || 'unknown',
        productId: r.product_id || null,
        users: 0,
        rows: [],
      });
    }
    const b = buckets.get(key);
    b.users += 1;
    b.rows.push(r);
  }
  return Array.from(buckets.values()).sort((a, b) => b.users - a.users);
}

// Shape returned to the frontend:
// {
//   available: true,
//   active: {
//     total: 12,
//     byPlan: [{ planId, billingPeriod, users, nextEndAt }],
//     endingSoon: [{ appUserId, planId, billingPeriod, endsAt, daysLeft }]
//   },
//   postTrial: {
//     windowDays: 30,
//     totalEnded: 26,
//     converted:         { total, byPlan },
//     canceled_in_trial: { total, byPlan },
//     expired:           { total, byPlan }
//   }
// }
//
// Returns { available: false, reason } when the table is empty (RC webhook
// not yet receiving events) so the UI can show the GA4-estimate fallback.
async function getSubscriptionState(days = 30) {
  const windowDays = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // Active trials: all rows currently in `trialing` status, soonest-ending first.
  const { data: activeRows, error: activeErr } = await supabase
    .from('trial_states')
    .select('app_user_id, plan_id, billing_period, product_id, trial_end_at')
    .eq('status', 'trialing')
    .order('trial_end_at', { ascending: true, nullsFirst: false });
  if (activeErr) {
    // Table doesn't exist yet (deploy ran before migration). Fall back to the
    // GA4 estimate so the dashboard still renders during the deploy window.
    if (/relation .* does not exist|42P01/i.test(activeErr.message || '')) {
      return { available: false, reason: 'migration_pending', windowDays };
    }
    throw activeErr;
  }

  // Post-trial outcomes: terminal states observed in the window.
  const { data: endedRows, error: endedErr } = await supabase
    .from('trial_states')
    .select('app_user_id, plan_id, billing_period, product_id, status, last_event_at')
    .in('status', ['converted', 'canceled_in_trial', 'expired'])
    .gte('last_event_at', windowStart);
  if (endedErr) throw endedErr;

  // If both tables are empty AND we have no events in subscription_events,
  // the webhook isn't wired yet — tell the frontend so it shows the GA4 fallback.
  if ((activeRows?.length || 0) === 0 && (endedRows?.length || 0) === 0) {
    const { count } = await supabase
      .from('subscription_events')
      .select('*', { count: 'exact', head: true });
    if (!count || count === 0) {
      return { available: false, reason: 'no_revenuecat_events_yet', windowDays };
    }
  }

  const now = new Date();
  const activeBuckets = groupByPlan(activeRows || []).map(b => {
    // nextEndAt = earliest trial_end_at in bucket (soonest-churning segment).
    const nextEndAt = b.rows
      .map(r => r.trial_end_at)
      .filter(Boolean)
      .sort()[0] || null;
    return { planId: b.planId, billingPeriod: b.billingPeriod, users: b.users, nextEndAt };
  });

  const endingSoon = (activeRows || [])
    .filter(r => r.trial_end_at)
    .map(r => ({
      appUserId: r.app_user_id,
      planId: r.plan_id || 'unknown',
      billingPeriod: r.billing_period || 'unknown',
      endsAt: r.trial_end_at,
      daysLeft: daysBetween(now.toISOString(), r.trial_end_at),
    }))
    .filter(r => r.daysLeft >= 0 && r.daysLeft <= 7)
    .slice(0, 20);

  const bucketize = (status) => {
    const rows = (endedRows || []).filter(r => r.status === status);
    return { total: rows.length, byPlan: groupByPlan(rows).map(b => ({ planId: b.planId, billingPeriod: b.billingPeriod, users: b.users })) };
  };

  return {
    available: true,
    windowDays,
    active: {
      total: (activeRows || []).length,
      byPlan: activeBuckets,
      endingSoon,
    },
    postTrial: {
      windowDays,
      totalEnded: (endedRows || []).length,
      converted: bucketize('converted'),
      canceled_in_trial: bucketize('canceled_in_trial'),
      expired: bucketize('expired'),
    },
  };
}

module.exports = {
  ingestEvent,
  getSubscriptionState,
  ensureTables,
  // exported for tests
  _internal: { normalizeRcEvent, deriveNextState, mapProduct },
};
