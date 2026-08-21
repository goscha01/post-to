// Playwright fixture setup.
// Creates a fresh test article via the SEO pipeline against a local backend
// and prints:
//   PLAYWRIGHT_JWT=...
//   PLAYWRIGHT_BLOG_ID=<uuid>
//
// Consumed by e2e-playwright.sh which exports these into the environment
// before running `npx playwright test`.
//
// Cleanup: e2e-playwright-cleanup.js deletes the article after the run.

require('dotenv').config();
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3099';
const KEYWORD = 'playwright ui screenshot fixture';

(async () => {
  const db = new Client({ connectionString: process.env.SUPABASE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const { rows } = await db.query(`
    SELECT user_id FROM connected_accounts
    WHERE provider = 'blog_domain' AND status='active'
      AND (metadata->>'hostname' ILIKE '%spotless%' OR metadata->>'public_hostname' ILIKE '%spotless%')
    LIMIT 1;
  `);
  if (!rows[0]) throw new Error('no spotless blog_domain');
  const userId = rows[0].user_id;
  const { rows: users } = await db.query('SELECT id, email, name, google_id FROM users WHERE id = $1', [userId]);
  const user = users[0];
  const token = jwt.sign(
    { userId: user.id, email: user.email, googleId: user.google_id, name: user.name, has_business_access: true },
    process.env.JWT_SECRET,
    { expiresIn: '3h' }
  );
  const res = await axios.post(`${BACKEND_URL}/api/ai/articles`, {
    keyword: KEYWORD, businessName: 'Spotless Homes', city: 'Tampa',
  }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 180_000,
  });
  // Rename to a clearly-test slug so it doesn't get confused with real content.
  await axios.patch(`${BACKEND_URL}/api/blogs/${res.data.id}`, {
    title: 'Playwright SEO E2E Fixture — DO NOT PUBLISH',
    slug: 'post-to-seo-e2e-playwright-fixture',
    heroAlt: 'Test hero image alt for playwright screenshot',
  }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  console.log(`PLAYWRIGHT_JWT=${token}`);
  console.log(`PLAYWRIGHT_BLOG_ID=${res.data.id}`);
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
