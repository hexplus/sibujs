import { defineConfig, devices } from "@playwright/test";

// Real-browser validation for the island runtime — the paths jsdom can't
// exercise (IntersectionObserver, requestIdleCallback, matchMedia, real event
// timing, and ES-module lazy `import()`). The strategy specs load examples/*.html
// over file://; the lazy-import spec needs real HTTP, served by `webServer`.
// Run: `npm run test:browser`.
export default defineConfig({
  testDir: "tests-browser",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5099",
    actionTimeout: 5000,
  },
  webServer: {
    command: "node tests-browser/server.mjs",
    url: "http://localhost:5099/examples/islands-lazy.html",
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
