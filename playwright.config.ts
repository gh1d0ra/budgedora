// Browser tests (`npm run test:e2e`): starts the local server on a throw-away database and drives Chromium.
import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PORT = 3123;
// A new empty database folder per run (workers re-read this file, so it is created once and passed on).
process.env.BUDGEDORA_E2E_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), 'budgedora-e2e-'));
const DATA_DIR = process.env.BUDGEDORA_E2E_DATA;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node server.ts',
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT), DATA_DIR },
    reuseExistingServer: false,
  },
});
