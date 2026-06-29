import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright drives the operator console in a real Chromium instance so layout
 * and interaction issues can be screenshotted and inspected.
 *
 * `PLAYWRIGHT_BASE_URL` selects the target origin:
 *   - http://127.0.0.1:5173  the docker-compose controller stack (default)
 *   - http://127.0.0.1:5174  a local `vite dev` server (HMR; see e2e README)
 *
 * Use 127.0.0.1 rather than localhost on Windows: Docker Desktop's IPv6
 * (`::1`) port forwarding can hang, while the IPv4 loopback is reliable.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./e2e",
  // Keep generated artifacts at the repo root, outside the dirs the formatter
  // (oxfmt) and the app's tsconfig scan under apps/.
  outputDir: "../../test-results/web",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
  ],
});
