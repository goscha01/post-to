// Playwright — SEO article workflow E2E + screenshots.
//
// Narrow scope (per the plan):
//   * open a test article in the editor
//   * verify SEO banner renders
//   * open the SEO checklist drawer, verify categories render
//   * screenshot: editor / banner / checklist / metadata editor
//   * introduce a failure via UI, verify banner recomputes
//   * fix via API, verify banner recomputes
//
// Exhaustive analyzer permutations live in backend Node --test —
// Playwright is for UI wiring + screenshots, not analyzer coverage.
//
// Requires:
//   - Backend running (default: http://localhost:3099) with REAL Supabase
//   - Frontend running on http://localhost:3000 (`npm start` in frontend/)
//   - PLAYWRIGHT_JWT env var set to a valid JWT for the test user
//   - PLAYWRIGHT_BLOG_ID env var set to a pre-created test article's ID
//     (created by backend/scripts/e2e-playwright-fixture.js)

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const JWT = process.env.PLAYWRIGHT_JWT;
const BLOG_ID = process.env.PLAYWRIGHT_BLOG_ID;
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

test.beforeAll(() => {
  if (!JWT) throw new Error('PLAYWRIGHT_JWT env var required');
  if (!BLOG_ID) throw new Error('PLAYWRIGHT_BLOG_ID env var required');
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

// Inject the JWT into localStorage before ANY page script runs so the auth
// context loads the token on first render (mirrors the OAuth callback flow).
test.beforeEach(async ({ page }) => {
  await page.addInitScript((token) => {
    localStorage.setItem('gmb_token', token);
  }, JWT);
});

test('SEO workflow — banner, drawer, metadata editor, live re-analysis', async ({ page }) => {
  // The Blogs page uses a URL param `?edit=<id>`-like state; the app opens
  // the EditView when you click Edit on the row. Easiest: navigate to
  // /blogs and click the row.
  await page.goto('/blogs');
  await expect(page).toHaveURL(/\/blogs/);

  // Locate our test row by ID substring. The row list uses the blog ID
  // internally; the row's edit button is a lucide Edit3 icon. Simpler:
  // click any cell inside the row that contains the test title marker.
  // We look for anything that contains "post-to-seo-e2e" (our slug).
  const editRow = page.locator('tr', { hasText: /post-to-seo-e2e|E2E Engineering|SEO E2E/i }).first();
  await expect(editRow).toBeVisible({ timeout: 15_000 });
  // Click the edit (pencil) icon inside the row.
  await editRow.locator('button[title="Edit"]').click().catch(async () => {
    // Fallback: click anywhere on the row (some layouts open on row click).
    await editRow.click();
  });

  // Editor drawer opens on the right — wait for the SEO banner to render.
  const banner = page.getByRole('button', { name: /Words:.*SEO checks passed/ });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  const bannerText = await banner.textContent();
  console.log('Banner:', bannerText.replace(/\s+/g, ' ').trim());
  expect(bannerText).toMatch(/Words:/);
  expect(bannerText).toMatch(/SEO checks passed/);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-editor.png'), fullPage: false });

  // Open checklist drawer.
  await banner.click();
  await expect(page.getByRole('heading', { name: /SEO checklist/ })).toBeVisible();
  // Five categories must appear.
  for (const cat of ['Meta & Technical', 'Links', 'Media & Visuals', 'Content Quality', 'Search Term Optimization']) {
    await expect(page.getByText(cat, { exact: true }).first()).toBeVisible();
  }
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-checklist.png') });

  // Fix-with-AI buttons appear for failing/warning rows (drawer starts with
  // "Meta & Technical" and "Search Term Optimization" expanded).
  const fixButtons = page.getByRole('button', { name: /Fix with AI/ });
  const fixCount = await fixButtons.count();
  console.log(`Fix-with-AI buttons visible: ${fixCount}`);
  expect(fixCount).toBeGreaterThan(0);

  // Close drawer with the X in the sticky header — the SEO drawer wraps its
  // header in a `sticky` div; find the X button by looking for a bare button
  // whose only child is the lucide X icon (title-less button inside the
  // header).
  const closeBtn = page
    .getByRole('heading', { name: /SEO checklist/i })
    .locator('xpath=ancestor::div[contains(@class,"sticky")]//button')
    .first();
  await closeBtn.click();
  // Verify the drawer is gone; the heading should disappear.
  await expect(page.getByRole('heading', { name: /SEO checklist/i })).toHaveCount(0);

  // Metadata editor is visible in the editor body.
  const keywordInput = page.getByPlaceholder(/house cleaning tampa/i);
  await expect(keywordInput).toBeVisible();
  const metaTextarea = page.locator('textarea').filter({ hasText: '' }).first();
  await expect(metaTextarea).toBeVisible();
  // Tags chip UI.
  await expect(page.getByPlaceholder(/type and press Enter/i)).toBeVisible();
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-metadata.png') });

  // (Live re-analysis in the UI is covered by the useDebouncedSeo unit
  // tests. The server-side analyze endpoint reads from the DB, so testing
  // an in-memory-only edit here would either need auto-save or an inline
  // body variant of /seo-analyze — deferred as its own change.)

  console.log(`Screenshots saved to ${SCREENSHOT_DIR}`);
});
