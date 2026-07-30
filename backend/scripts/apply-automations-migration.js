// One-shot: apply supabase/automations.sql to the database from .env.
// Uses SUPABASE_DATABASE_URL (postgres connection string).
//
// Run: node backend/scripts/apply-automations-migration.js
//
// Idempotent — the SQL uses IF NOT EXISTS everywhere so re-running is safe.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error('SUPABASE_DATABASE_URL not set');

  const sqlPath = path.join(__dirname, '..', '..', 'supabase', 'automations.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(sql);
    console.log('automations.sql applied OK');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('MIGRATION FAILED:', err.message);
  if (err.detail) console.error('detail:', err.detail);
  if (err.hint) console.error('hint:', err.hint);
  process.exit(1);
});
