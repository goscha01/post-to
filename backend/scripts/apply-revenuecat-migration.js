// One-shot runner for supabase/revenuecat-subscription-state.sql.
// Creates the subscription_events + trial_states tables used by the
// RevenueCat webhook ingestion. Idempotent — safe to re-run.
//
// Run:
//   node scripts/apply-revenuecat-migration.js
//
// If SUPABASE_DATABASE_URL isn't in .env, use Railway's env:
//   railway run --service self-post -- node scripts/apply-revenuecat-migration.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SQL_PATH = path.join(__dirname, '..', '..', 'supabase', 'revenuecat-subscription-state.sql');

async function main() {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error('SUPABASE_DATABASE_URL is not set (in backend/.env or ambient env)');

  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    console.log('Applying revenuecat-subscription-state.sql …');
    await client.query(sql);

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
