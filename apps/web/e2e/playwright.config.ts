import { defineConfig } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const screenshots = process.env['E2E_SCREENSHOTS'] === '1';

const iPhone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL, trace: 'retain-on-failure' },
  projects: screenshots
    ? [{ name: 'screenshots', testMatch: 'screenshots.spec.ts' }]
    : [
        {
          name: 'desktop',
          testMatch: [
            'integrations.spec.ts',
            'messaging.spec.ts',
            'uploads.spec.ts',
            'servers.spec.ts',
            'polls.spec.ts',
            'roles.spec.ts',
            'customization.spec.ts',
            'profiles.spec.ts',
            'directory.spec.ts',
            'panels.spec.ts',
            'webhook-templates.spec.ts',
            'presence.spec.ts',
          ],
          use: { viewport: { width: 1280, height: 800 } },
        },
        {
          name: 'mobile',
          testMatch: [
            'mobile.spec.ts',
            'integrations.mobile.spec.ts',
            'directory.mobile.spec.ts',
            'webhook-templates.mobile.spec.ts',
          ],
          use: {
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            userAgent: iPhone,
          },
        },
      ],
  // Reuses servers that are already running (always the case inside the Playwright container).
  webServer: process.env['E2E_NO_WEBSERVER']
    ? undefined
    : [
        {
          command: 'pnpm --filter @harmony/server exec tsx src/server.ts',
          url: 'http://127.0.0.1:18080/healthz',
          reuseExistingServer: true,
          env: {
            NODE_ENV: 'development',
            DEV_AUTH_LOGIN: 'dev@example.com',
            PORT: '18080',
            HOST: '127.0.0.1',
            PUBLIC_ORIGIN: baseURL,
            DATABASE_URL:
              process.env['DATABASE_URL'] ?? 'postgres://harmony:dev@127.0.0.1:15432/harmony',
            REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:16379',
            UPLOAD_DIR: process.env['UPLOAD_DIR'] ?? '.e2e-uploads',
            LOG_LEVEL: 'warn',
            // Perks are granted explicitly in the tests that need them.
            PERKS_DEFAULT: 'none',
            MESSAGE_RATE_MAX: '500',
            RATE_LIMIT_MAX: '5000',
            // The bot e2e points an admin-owned bot at a stub on localhost.
            OUTBOUND_PRIVATE_ALLOWLIST: 'localhost,127.0.0.1',
          },
        },
        {
          command:
            'pnpm --filter @harmony/web exec vite --port 15173 --host 127.0.0.1 --strictPort',
          url: 'http://127.0.0.1:15173',
          reuseExistingServer: true,
          env: { VITE_API_TARGET: 'http://127.0.0.1:18080' },
        },
      ],
});
