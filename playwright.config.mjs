// Browser tests for the site in public/ (npm run test:e2e). Price snapshots, CDN libraries
// and outside services are all stubbed in tests/e2e/fixtures.mjs, so the tests need no
// network and no R2 access.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
    testDir: 'tests/e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        // The service worker would answer requests before page.route() sees them.
        serviceWorkers: 'block',
        timezoneId: 'America/Los_Angeles',
        trace: 'off',
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
        { name: 'phone', use: { ...devices['Pixel 7'] } },
    ],
    webServer: {
        command: `python3 -m http.server ${PORT} --bind 127.0.0.1 -d public`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: !process.env.CI,
        stderr: 'ignore', // http.server logs every request
    },
});
