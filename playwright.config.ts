import { defineConfig } from '@playwright/test';

// Drives the real built app against MOCK providers: no API calls, no keys needed.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  use: { baseURL: 'http://localhost:8797', viewport: { width: 1440, height: 900 } },
});
