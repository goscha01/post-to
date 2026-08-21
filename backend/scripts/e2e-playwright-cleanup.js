// Delete the Playwright fixture article after the run.
// Called from e2e-playwright.sh — requires PLAYWRIGHT_JWT + PLAYWRIGHT_BLOG_ID.

require('dotenv').config();
const axios = require('axios');
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3099';
(async () => {
  const jwt = process.env.PLAYWRIGHT_JWT;
  const id = process.env.PLAYWRIGHT_BLOG_ID;
  if (!jwt || !id) { console.log('nothing to cleanup'); return; }
  try {
    await axios.delete(`${BACKEND_URL}/api/blogs/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    console.log(`✓ deleted playwright fixture ${id}`);
  } catch (e) {
    console.warn('cleanup failed:', e.message);
  }
})();
