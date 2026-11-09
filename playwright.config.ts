import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PULSE_TEST_PORT || 4175);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid Pulse test port: ${process.env.PULSE_TEST_PORT}`);
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node app/server.js',
    url: `http://127.0.0.1:${port}/health`,
    env: {
      PORT: String(port),
      PULSE_DB_PATH: './test-results/pulse-orders.sqlite',
    },
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
});
