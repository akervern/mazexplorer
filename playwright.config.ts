import { defineConfig } from '@playwright/test';

/**
 * Visual/integration tests: they render actual frames, which is the whole
 * point — `npm test` proves the generator's logic and never draws anything.
 *
 * This machine has a real GPU available to headless Chromium (AMD via
 * ANGLE/Vulkan), so WebGL 2 runs accelerated rather than through SwiftShader.
 * The flags below ask for that path; `gpu.spec.ts` asserts we actually got it,
 * since SwiftShader would happily render every other test and hide the
 * difference.
 */
const PORT = 5199;

export default defineConfig({
  testDir: 'tests',
  // Three.js worlds take a few seconds to build and settle.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    // A fixed viewport keeps the HUD layout — and any screenshot — stable.
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium-gpu',
      use: {
        // Deliberately not spreading `devices['Desktop Chrome']`: it carries
        // its own viewport (1280x720) and would override the one set above,
        // shrinking the dev map enough to push the southern zones out of view.
        //
        // The full Chromium, not the headless shell: the shell ships without
        // the GPU stack, so it silently falls back to SwiftShader.
        channel: 'chromium',
        launchOptions: {
          args: [
            '--use-angle=vulkan',
            '--enable-features=Vulkan',
            '--ignore-gpu-blocklist',
            '--enable-gpu-rasterization',
          ],
        },
      },
    },
  ],

  // The dev tools (F1 map, F3 overlay) are what the tests drive, so the server
  // must run with the flag on — a plain `vite` build has no dev chunk at all.
  webServer: {
    command: `VITE_DEV_TOOLS=1 npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
