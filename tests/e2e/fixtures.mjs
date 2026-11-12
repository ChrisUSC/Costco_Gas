// Shared setup for the browser tests: serves CDN libraries from node_modules, stubs the
// map tiles and outside services, and builds price snapshots from the real store list.
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stores = JSON.parse(readFileSync(`${root}public/us_stores.json`, 'utf8'));

// A 1x1 transparent PNG for map tiles.
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const TYPES = { js: 'application/javascript', css: 'text/css', png: 'image/png', json: 'application/json' };

// Scraper timestamps are Pacific wall-clock time: "YYYY-MM-DD HH:MM".
export function pacificTimestamp(date) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(({ type, value }) => [type, value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// The cheapest station in each state, so tests know what to expect at the top of lists.
export const CHEAPEST = { CA: 'Turlock', TX: Object.keys(stores.TX).sort()[0] };
export const DIESEL_CITY = 'Tracy'; // the only CA station selling diesel in these snapshots

// Prices for every CA and TX station (other states have none, so they don't appear).
export function buildLatest({ ageMinutes = 10 } = {}) {
    const now = Date.now();
    const prices = {}, previous = {};
    for (const [stateCode, base] of [['CA', 4.5], ['TX', 2.9]]) {
        prices[stateCode] = {}; previous[stateCode] = {};
        Object.keys(stores[stateCode]).sort().forEach((city, i) => {
            const reg = city === CHEAPEST[stateCode] ? base - 0.5 : +(base + (i % 40) * 0.01).toFixed(2);
            const diesel = stateCode === 'CA' && city === DIESEL_CITY ? 4.99 : null;
            prices[stateCode][city] = [reg, +(reg + 0.4).toFixed(2), diesel];
            previous[stateCode][city] = [+(reg + 0.04).toFixed(2), +(reg + 0.44).toFixed(2), diesel];
        });
    }
    return {
        timestamp: pacificTimestamp(new Date(now - ageMinutes * 60000)),
        prices,
        previous,
        previous_timestamp: pacificTimestamp(new Date(now - 72 * 3600000)),
    };
}

// Change-only history: a full snapshot 20 days ago, then a few Turlock changes.
export function buildHistory() {
    const day = 86400000, now = Date.now();
    const first = buildLatest().prices;
    return {
        [pacificTimestamp(new Date(now - 20 * day))]: first,
        [pacificTimestamp(new Date(now - 10 * day))]: { CA: { Turlock: [4.19, 4.59, null] } },
        [pacificTimestamp(new Date(now - 2 * day))]: { CA: { Turlock: [4.0, 4.4, null] } },
    };
}

// The parts of a Nominatim search result the app reads.
function nominatimResult(name, { lat, lng }) {
    const d = 0.05;
    return {
        lat: String(lat), lon: String(lng), display_name: `${name}, California, United States`,
        type: 'city', addresstype: 'city', address: { city: name, state: 'California' },
        boundingbox: [lat - d, lat + d, lng - d, lng + d].map(String),
    };
}

// An OSRM /route response for a line through the given [lat, lng] points.
function osrmResponse(points) {
    return {
        code: 'Ok',
        routes: [{ distance: 40 * 1609.34, geometry: { type: 'LineString', coordinates: points.map(([lat, lng]) => [lng, lat]) } }],
    };
}

// Coordinates of a station in the real store list.
export function storeLatLng(stateCode, city) {
    const s = stores[stateCode][city];
    return [s.lat, s.lng];
}

async function serveFromNodeModules(route) {
    const url = new URL(route.request().url());
    const m = url.pathname.replace(/^\/npm\//, '/').match(/^\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/);
    if (!m) return route.abort();
    try {
        const body = readFileSync(`${root}node_modules/${m[1]}/${m[2]}`);
        // CORS header: index.html loads these with crossorigin + integrity, and the browser
        // checks the hash against these bytes.
        await route.fulfill({
            body,
            contentType: TYPES[m[2].split('.').pop()] || 'application/octet-stream',
            headers: { 'Access-Control-Allow-Origin': '*' },
        });
    } catch {
        await route.fulfill({ status: 404, body: '', headers: { 'Access-Control-Allow-Origin': '*' } });
    }
}

export const test = base.extend({
    // Override per test: test.use({ latest: { ageMinutes: 300 } }) or { status: 500 }.
    latest: [{}, { option: true }],
    // Places the geocoder knows: { 'query text': { lat, lng, name } } (case-insensitive match).
    places: [{}, { option: true }],
    // A driving route for OSRM to return, as { points: [[lat, lng], ...] }; null makes routing
    // fail. (An object, not a bare array: test.use() reads an array as [value, options].)
    drivingRoute: [null, { option: true }],

    page: async ({ page, latest, places, drivingRoute }, use) => {
        page.errors = [];
        page.on('pageerror', (err) => page.errors.push(err.message));
        page.on('console', (msg) => { if (msg.type() === 'error') page.errors.push(msg.text()); });

        await page.route(/^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com)\//, serveFromNodeModules);
        await page.route(/basemaps\.cartocdn\.com/, (r) => r.fulfill({ body: TILE, contentType: 'image/png' }));
        await page.route(/ipapi\.co/, (r) => r.fulfill({ body: 'CA', contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' } }));
        await page.route(/nominatim\.openstreetmap\.org/, (r) => {
            const q = (new URL(r.request().url()).searchParams.get('q') || '').toLowerCase();
            const hits = Object.entries(places)
                .filter(([name]) => name.toLowerCase().startsWith(q) || q.startsWith(name.toLowerCase()))
                .map(([name, p]) => nominatimResult(name, p));
            return r.fulfill({ json: hits, headers: { 'Access-Control-Allow-Origin': '*' } });
        });
        await page.route(/router\.project-osrm\.org/, (r) => drivingRoute
            ? r.fulfill({ json: osrmResponse(drivingRoute.points), headers: { 'Access-Control-Allow-Origin': '*' } })
            : r.abort());

        await page.route(/\/us_latest\.json/, (r) => latest.status
            ? r.fulfill({ status: latest.status, json: { error: 'stubbed failure' } })
            : r.fulfill({ json: buildLatest(latest) }));
        await page.route(/\/us_history\.json/, (r) => r.fulfill({ json: buildHistory() }));

        await use(page);
    },
});

export { expect };

// Phones show the list in a bottom sheet; some checks only apply to the wider layouts.
export const isPhone = (testInfo) => testInfo.project.name === 'phone';
