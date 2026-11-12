// Lint for the browser code (no build step, so this is what catches a missing or misspelled
// import between modules before the page does) and the test files.
import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['node_modules/', 'test-results/', 'playwright-report/'] },
    js.configs.recommended,
    {
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['public/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            // Leaflet and Chart.js are loaded from the CDN as globals (see index.html).
            globals: { ...globals.browser, L: 'readonly', Chart: 'readonly' },
        },
    },
    {
        files: ['public/sw.js'],
        languageOptions: { sourceType: 'script', globals: globals.serviceworker },
    },
    {
        // Cloudflare Pages middleware and Worker (Workers runtime: fetch, Response, Headers...)
        files: ['functions/**/*.js', 'worker.js', 'r2_snapshots.js'],
        languageOptions: { sourceType: 'module', globals: globals.worker },
    },
    {
        files: ['tests/**/*.mjs', '*.config.mjs'],
        languageOptions: { globals: globals.node },
    },
    {
        // Unit tests stand in a fake `window` for the modules they import; browser-test
        // callbacks passed to page.evaluate() run inside the page.
        files: ['tests/frontend/**/*.mjs', 'tests/e2e/**/*.mjs'],
        languageOptions: { globals: { window: 'writable' } },
    },
];
