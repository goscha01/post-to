// One-shot migration runner.
// Reads SUPABASE_DATABASE_URL from backend/.env, applies SQL files in order,
// then creates gmb_reviews (which has no checked-in migration) + the AI tables.
//
// Run: node scripts/apply-migrations.js
// Safe to re-run on partially-applied schemas (all CREATEs use IF NOT EXISTS,
// the only DROPs live in setup-database.sql).
//
// Set CONFIRM_DROP=yes to allow setup-database.sql (which DROPs users + social_media_*).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SUPABASE_DIR = path.join(__dirname, '..', '..', 'supabase');

// Helper function shared by many triggers across the migrations.
const UPDATE_TRIGGER_FN = `
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';
`;

// gmb_reviews schema reverse-engineered from backend/src/routes/reviews.js
// (saveReviewToDatabase columns + getCachedReviews ORDER BY create_time).
const GMB_REVIEWS = `
CREATE TABLE IF NOT EXISTS gmb_reviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  location_id VARCHAR(255),
  review_id VARCHAR(255),
  reviewer_name VARCHAR(255),
  reviewer_photo_url TEXT,
  star_rating INTEGER,
  comment TEXT,
  create_time TIMESTAMP WITH TIME ZONE,
  update_time TIMESTAMP WITH TIME ZONE,
  reply_comment TEXT,
  reply_update_time TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gmb_reviews_user_id ON gmb_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_gmb_reviews_location_id ON gmb_reviews(location_id);
CREATE INDEX IF NOT EXISTS idx_gmb_reviews_review_id ON gmb_reviews(review_id);
ALTER TABLE gmb_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations on gmb_reviews" ON gmb_reviews;
CREATE POLICY "Allow all operations on gmb_reviews" ON gmb_reviews FOR ALL USING (true);
`;

const STEPS = [
  { name: 'setup-database.sql', file: 'setup-database.sql', root: true, destructive: true },
  { name: 'update_updated_at_column() helper fn', sql: UPDATE_TRIGGER_FN },
  { name: 'complete-gmb-setup.sql', file: 'complete-gmb-setup.sql' },
  { name: 'image-cache-table.sql', file: 'image-cache-table.sql' },
  { name: 'gmb_reviews (inline)', sql: GMB_REVIEWS },
  { name: 'ai-pipeline-tables.sql', file: 'ai-pipeline-tables.sql' }
];

async function main() {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) { console.error('SUPABASE_DATABASE_URL not set in backend/.env'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected to Postgres:', new URL(url).host);

  for (const step of STEPS) {
    if (step.destructive && process.env.CONFIRM_DROP !== 'yes') {
      console.log(`SKIP  ${step.name} (set CONFIRM_DROP=yes to run — it DROPs users / social_media_*)`);
      continue;
    }

    let sql;
    if (step.file) {
      const fp = path.join(step.root ? path.join(__dirname, '..', '..') : SUPABASE_DIR, step.file);
      if (!fs.existsSync(fp)) { console.log(`SKIP  ${step.name} (file not found: ${fp})`); continue; }
      sql = fs.readFileSync(fp, 'utf8');
    } else {
      sql = step.sql;
    }

    try {
      await client.query(sql);
      console.log(`OK    ${step.name}`);
    } catch (e) {
      console.error(`FAIL  ${step.name}:`, e.message);
      // Don't abort — keep going so we can see all failures.
    }
  }

  // Verify expected tables exist.
  const expected = ['users', 'social_media_accounts', 'social_media_posts',
    'gmb_accounts', 'gmb_locations', 'gmb_media_cache', 'gmb_reviews',
    'image_cache', 'ai_jobs', 'blog_articles', 'ai_generated_posts'];
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1)
     ORDER BY table_name`, [expected]
  );
  const present = new Set(rows.map(r => r.table_name));
  console.log('\n--- table check ---');
  for (const t of expected) console.log((present.has(t) ? 'OK  ' : 'MISS') + '  ' + t);

  await client.end();
}
main().catch(e => { console.error(e); process.exit(1); });
