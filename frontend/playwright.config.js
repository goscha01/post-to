// Playwright config — narrow scope: SEO article workflow + screenshots only.
// Full SEO rule permutations live in the backend Node --test suite;
// Playwright covers the UI wiring + captures screenshots for the SEO PR.
//
// Screenshots land in e2e/screenshots/.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 3 * 60 * 1000,
  fullyParallel: false, // sequential; we manage a shared test article
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
