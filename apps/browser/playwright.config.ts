import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 3,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/report' }]],
  outputDir: 'test-results/artifacts',
  globalSetup: './test/e2e/support/global-setup.ts',
});
