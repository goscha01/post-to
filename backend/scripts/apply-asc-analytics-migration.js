// One-shot runner for supabase/asc-analytics-cache.sql.
// Reads SUPABASE_DATABASE_URL from backend/.env and creates the ASC
// analytics cache table. Idempotent — safe to re-run.
//
// Run: node scripts/apply-asc-analytics-migration.js
//
// If SUPABASE_DATABASE_URL isn't in .env, you can also grab it from Railway:
//   railway run --service self-post -- node scripts/apply-asc-analytics-migration.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SQL_PATH = path.join(__dirname, '..', '..', 'supabase', 'asc-analytics-cache.sql');

async function main() {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error('SUPABASE_DATABASE_URL is not set (in backend/.env or ambient env)');

  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    console.log('Applying asc-analytics-cache.sql …');
    await client.query(sql);

    const { rows } = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'asc_analytics_cache'
      ORDER BY ordinal_position;
    `);
    if (rows.length === 0) {
      throw new Error('asc_analytics_cache table not created — migration silently failed');
    }
    console.log('Columns present:');
    for (const r of rows) console.log(`  - ${r.column_name}  (${r.data_type})`);
    console.log('✓ Migration applied.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
