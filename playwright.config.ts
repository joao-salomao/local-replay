import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // Specs use the `.e2e.ts` suffix (not `.spec.ts`) so Bun's own test runner
  // (`bun test`, e.g. under --coverage) does NOT try to load these Playwright
  // files — its `test()` would throw "did not expect test() to be called here".
  testMatch: "**/*.e2e.ts",
  timeout: 300_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: "https://localhost:8543",
    ignoreHTTPSErrors: true,
    permissions: ["camera", "microphone"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  // Two isolated servers: record-flow.e2e.ts talks to the first (port 8543, .e2e-data).
  // buffer-resilience.e2e.ts overrides baseURL to the second (port 8544, .e2e-data-buffer)
  // via test.use() so its own trigger is a clean "clip #1" — clip numbering is derived from
  // files already on disk (Storage.nextClipNumber), so sharing one server/data dir across
  // both specs would make the second spec's clip land on #2 and race the first spec's
  // hardcoded "Lance #1" assertion depending on file execution order.
  webServer: [
    {
      command:
        "bun run tests/e2e/seed.ts && DATA_DIR=.e2e-data HTTPS_PORT=8543 HTTP_PORT=8580 bun run src/server/index.ts",
      url: "https://localhost:8543",
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "bun run tests/e2e/seed.ts .e2e-data-buffer && DATA_DIR=.e2e-data-buffer HTTPS_PORT=8544 HTTP_PORT=8581 bun run src/server/index.ts",
      url: "https://localhost:8544",
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
