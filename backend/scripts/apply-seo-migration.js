// One-shot runner for supabase/blog-articles-seo.sql.
// Reads SUPABASE_DATABASE_URL from backend/.env and applies the SEO columns
// to blog_articles. Idempotent — safe to re-run.
//
// Run: node scripts/apply-seo-migration.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SQL_PATH = path.join(__dirname, '..', '..', 'supabase', 'blog-articles-seo.sql');

async function main() {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error('SUPABASE_DATABASE_URL is not set in backend/.env');

  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    console.log('Applying blog-articles-seo.sql …');
    await client.query(sql);

    const { rows } = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'blog_articles'
        AND column_name IN ('tags', 'hero_alt', 'search_intent', 'suggested_internal_links',
                            'image_suggestions', 'faq', 'seo_metadata')
      ORDER BY column_name;
    `);
    console.log('New / present columns:');
    for (const r of rows) console.log(`  - ${r.column_name}  (${r.data_type})`);
    if (rows.length !== 7) {
      throw new Error(`expected 7 SEO columns present, got ${rows.length}`);
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
