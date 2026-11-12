// Service worker: lets the installed app open without a connection, showing the last
// prices it saw.
//
// Online, the app's own files and the price data always come from the network (so a new
// deploy shows up on the next load); the cached copies are only used when the network
// fails. Map tiles and the search, routing and location services are not cached.
//
// When you add a file under public/ that the app loads, add it to APP_FILES as well
// (tests/test_service_worker.py checks this). Bump CACHE_VERSION to drop old caches.

const CACHE_VERSION = 'v3';
const CACHE = `costco-gas-${CACHE_VERSION}`;

// The app itself. If any of these can't be fetched, installing fails and is retried on
// the next visit, so a half-cached app is never used offline.
// The page is cached as './', not 'index.html': Cloudflare Pages redirects /index.html to /,
// and a redirected response can't be used for a page load.
const APP_FILES = [
    './',
    'styles.css',
    'app.js',
    'js/charts.js',
    'js/components.js',
    'js/icons.js',
    'js/nav.js',
    'js/routes.js',
    'js/search.js',
    'js/state.js',
    'js/utils.js',
    'manifest.webmanifest',
    'us-outline.json',
    'icons/apple-touch-icon.png',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-maskable-512.png'
];

// Data the app fetches with a cache-busting query string (?t= / ?v=). Cached under the
// bare path, so there is one copy each however many times it is loaded. Allowed to be
// missing at install time (e.g. local development without snapshots).
const DATA_FILES = ['us_stores.json', 'us_latest.json', 'us_history.json'];

// Versioned library URLs never change, so the cached copy can be used straight away.
// index.html loads them with an integrity hash and crossorigin, so their responses are
// CORS responses the browser can check (an opaque copy would fail the check).
const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net'];

// How long to wait for fresh price data before falling back to the saved copy.
const DATA_TIMEOUT_MS = 6000;

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await cache.addAll(APP_FILES.map(url => new Request(url, { cache: 'reload' })));
        await Promise.allSettled(DATA_FILES.map(async (url) => {
            const res = await fetch(url, { cache: 'reload' });
            if (res.ok) await cache.put(url, res);
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(n => n.startsWith('costco-gas-') && n !== CACHE).map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(req));
        return;
    }
    if (url.origin !== self.location.origin) return; // tiles, geocoding, routing, ipapi

    if (req.mode === 'navigate') {
        // Shared links such as /?store=CA_Turlock all open the same page.
        event.respondWith(networkFirst(req, './'));
        return;
    }
    const name = url.pathname.split('/').pop();
    if (DATA_FILES.includes(name)) {
        event.respondWith(networkFirst(req, name, DATA_TIMEOUT_MS));
        return;
    }
    event.respondWith(networkFirst(req, url.pathname));
});

// Fresh from the network, saving a good copy under cacheKey; the saved copy only when the
// network fails. HTML and JS wait for the network however long it takes (a timeout could
// mix a new app.js with an old module); data files give up after timeoutMs.
async function networkFirst(req, cacheKey, timeoutMs = 0) {
    const cache = await caches.open(CACHE);
    try {
        const res = await (timeoutMs ? withTimeout(fetch(req), timeoutMs) : fetch(req));
        // Never replace a good copy with an error (the R2 middleware returns JSON 404/500s).
        if (res.ok) await cache.put(cacheKey, res.clone());
        return res;
    } catch (err) {
        const cached = await cache.match(cacheKey, { ignoreSearch: true });
        if (cached) return markedAsSaved(cached);
        throw err;
    }
}

// The app checks this header to know it's showing saved data (a phone can report being
// online on Wi-Fi with no internet, so navigator.onLine alone isn't enough).
function markedAsSaved(res) {
    const headers = new Headers(res.headers);
    headers.set('X-From-Cache', '1');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function cacheFirst(req) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    // Only cache a readable success. An opaque (no-CORS) copy can't pass the page's
    // integrity check, so serving one later would block the script.
    if (res.ok) await cache.put(req, res.clone());
    return res;
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}
