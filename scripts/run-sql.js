// Small one-off runner: applies one or more .sql files against
// SUPABASE_DATABASE_URL. Uses the `pg` client from the repo's root
// node_modules. Usage:
//   node scripts/run-sql.js supabase/blog-articles-connection-id.sql
// Multiple files run in sequence; failure of one aborts the rest.
// Reads env from backend/.env so SUPABASE_DATABASE_URL is picked up.

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { Client } = require('pg');

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) {
  console.error('SUPABASE_DATABASE_URL not set (checked backend/.env)');
  process.exit(1);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/run-sql.js <file1.sql> [file2.sql ...]');
  process.exit(1);
}

(async () => {
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('connected to postgres');

  for (const rel of files) {
    const abs = path.resolve(rel);
    const sql = fs.readFileSync(abs, 'utf8');
    console.log(`\n--- applying ${rel} (${sql.length} chars) ---`);
    try {
      const result = await client.query(sql);
      const rc = Array.isArray(result) ? result : [result];
      rc.forEach((r, i) => {
        console.log(`  [${i}] command=${r.command || '?'} rowCount=${r.rowCount ?? '-'}`);
      });
      console.log(`OK ${rel}`);
    } catch (e) {
      console.error(`FAILED ${rel}: ${e.message}`);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log('\nall migrations applied.');
})();
