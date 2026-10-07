// One-shot runner for the RevenueCat subscription-state schema.
// Creates subscription_events + trial_states (plus indexes + RLS). Idempotent.
//
// SQL is embedded inline so this script works inside Railway's container,
// where the /supabase folder isn't shipped (/app only contains backend/).
// The supabase/revenuecat-subscription-state.sql file in the repo is kept as
// the human-readable source of truth — keep it in sync with the SQL below.
//
// Local run (requires IPv6 or pooler reachability to Supabase):
//   node backend/scripts/apply-revenuecat-migration.js
//
// Production run (recommended — runs from inside the Railway container):
//   railway ssh "cd /app && node scripts/apply-revenuecat-migration.js"

require('dotenv').config();
const { Client } = require('pg');

const SQL = `
-- subscription_events — append-only raw RC webhook log.
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

-- trial_states — derived per-subscriber current state (upserted on every event).
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

async function main() {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error('SUPABASE_DATABASE_URL is not set');

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    console.log('Applying revenuecat-subscription-state schema (inline) …');
    await client.query(SQL);

    for (const table of ['subscription_events', 'trial_states']) {
      const { rows } = await client.query(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_name = $1
         ORDER BY ordinal_position;`,
        [table]
      );
      if (rows.length === 0) {
        throw new Error(`${table} not created — migration silently failed`);
      }
      console.log(`${table}:`);
      for (const r of rows) console.log(`  - ${r.column_name}  (${r.data_type})`);
    }
    console.log('✓ Migration applied.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
