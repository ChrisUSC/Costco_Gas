// --- Loading prices and the store list, quiet refreshes, and the "Updated … ago" label ---

import { resetHistoryCache } from './charts.js';
import { errorStateHtml, renderMobileStoreCardContent, skeletonCardsHtml } from './components.js';
import { detectUserState, getLocationIfGranted, updateClosestStoreState } from './location.js';
import { checkZoomLevel, map, placeUserLocationMarker } from './map.js';
import { refreshMapAndList, renderMap } from './markers.js';
import { initialUrl } from './nav.js';
import { setOfflineMode } from './offline.js';
import { closeMobileStoreCard } from './sheet.js';
import { findStore, state } from './state.js';
import { openSharedStoreIfPresent } from './station-actions.js';
import { storageGet, storageSet } from './storage.js';
import { buildStores } from './stores.js';
import { switchTab } from './tabs.js';
import { formatLastUpdatedLabel, getRelativeTimeLabel } from './time.js';

export let loadStatus = 'loading'; // 'loading' | 'ready' | 'error'
let storeDirectory = {};   // us_stores.json, kept for quiet price refreshes
export let lastNetworkPricesAt = 0;

// sw.js marks responses it answered from the saved copy.
const isSavedCopy = (res) => res.headers.get('X-From-Cache') === '1';

export function renderLoadState() {
    const container = document.getElementById('sidebarContent');
    if (!container) return;
    if (loadStatus === 'loading') {
        container.innerHTML = skeletonCardsHtml(4);
    } else {
        container.innerHTML = errorStateHtml({
            title: "Couldn't load gas prices",
            message: navigator.onLine === false
                ? "You appear to be offline. Check your connection and try again."
                : "Something went wrong fetching the latest prices. Please try again.",
            action: 'retry-load'
        });
    }
}

function applyPriceSnapshot(latestData) {
    state.trendBaselineLabel = getRelativeTimeLabel(latestData.previous_timestamp || null);
    state.latestTimestamp = latestData.timestamp;
    state.stores = buildStores(latestData, storeDirectory);
}

export async function loadData() {
    loadStatus = 'loading';
    renderLoadState();
    const lastUpdatedEl = document.getElementById('lastUpdated');
    if (lastUpdatedEl) lastUpdatedEl.innerText = 'Fetching latest data...';
    try {
        const cb = Date.now();
        const [latestRes, storesRes, , autoLocation] = await Promise.all([
            fetch(`us_latest.json?t=${cb}`),
            fetch(`us_stores.json?t=${cb}`),
            state.autoLocate ? detectUserState() : null,
            state.autoLocate ? getLocationIfGranted() : null
        ]);

        if (!latestRes.ok || !storesRes.ok) throw new Error('Failed to fetch latest snapshot or store list');

        const latestData = await latestRes.json();
        storeDirectory = await storesRes.json();
        const offline = navigator.onLine === false || isSavedCopy(latestRes);
        if (!offline) lastNetworkPricesAt = Date.now();

        applyPriceSnapshot(latestData);
        loadStatus = 'ready';
        // Before the first render, so a Route tab from a link or the settings falls back to Nearby.
        setOfflineMode(offline, { announce: true });

        renderMap(state.stores);

        if (autoLocation) {
            state.deviceLocation = autoLocation;
            state.userLocation = autoLocation;
            updateClosestStoreState(autoLocation);
            placeUserLocationMarker(autoLocation);
        }

        // A shared link can pin the state leaderboard; it wins over the detected state.
        if (initialUrl.state) state.currentStateContext = initialUrl.state;
        initialUrl.state = null; // only on first load, not on a retry
        switchTab(state.currentTab);

        if (!openSharedStoreIfPresent()) {
            if (autoLocation) {
                map.setView([autoLocation.lat, autoLocation.lng], 10);
                checkZoomLevel();
            } else if (state.stores.length > 0) {
                const bounds = L.latLngBounds(state.stores.map(s => [s.lat, s.lng]).filter(c => c[0] && c[1]));
                map.fitBounds(bounds, { padding: [30, 30] });
                checkZoomLevel();
            }
        }
        if (!offline) scheduleHistoryCopy();
    } catch (error) {
        console.error('Error fetching data:', error);
        loadStatus = 'error';
        renderLoadState();
        if (lastUpdatedEl) lastUpdatedEl.innerText = "Couldn't load prices";
    }
}

// Fetch fresh prices without disturbing the page: the map stays where it is, the open
// station stays open, and the current tab re-renders with the new prices.
let refreshRequest = null;

export function refreshPrices() {
    if (loadStatus === 'loading') return Promise.resolve();
    if (loadStatus === 'error') return loadData(); // the first load failed: try it again
    if (refreshRequest) return refreshRequest;
    refreshRequest = (async () => {
        try {
            const res = await fetch(`us_latest.json?t=${Date.now()}`);
            if (!res.ok) throw new Error(`Prices returned ${res.status}`);
            const savedCopy = isSavedCopy(res);
            if (!savedCopy) {
                const openStore = state.activeMobileStore;
                applyPriceSnapshot(await res.json());
                lastNetworkPricesAt = Date.now();
                resetHistoryCache();
                // Route results hold copies of stations; give them the new prices.
                if (state.lastRouteState?.along) {
                    state.lastRouteState.along = state.lastRouteState.along
                        .map(s => { const fresh = findStore(s.state, s.city); return fresh ? { ...fresh, distance: s.distance, detourMiles: s.detourMiles } : null; })
                        .filter(Boolean);
                }
                setOfflineMode(navigator.onLine === false);
                refreshMapAndList();
                if (openStore) {
                    state.activeMobileStore = findStore(openStore.state, openStore.city) || null;
                    if (state.activeMobileStore) renderMobileStoreCardContent(state.activeMobileStore);
                    else closeMobileStoreCard();
                }
                scheduleHistoryCopy();
            } else {
                setOfflineMode(true);
            }
        } catch (e) {
            setOfflineMode(true);
        } finally {
            refreshRequest = null;
        }
    })();
    return refreshRequest;
}

// Keep the saved price history fresh for offline charts: at most once a day, a few seconds
// after fresh prices arrive (sw.js saves the response). Skipped when the browser asks to
// save data; phones don't tell web apps whether they're on Wi-Fi.
const HISTORY_COPY_EVERY_MS = 24 * 60 * 60 * 1000;
let historyCopyScheduled = false;

function scheduleHistoryCopy() {
    if (historyCopyScheduled || navigator.connection?.saveData) return;
    const last = parseInt(storageGet('historyCopiedAt'), 10) || 0;
    if (Date.now() - last < HISTORY_COPY_EVERY_MS) return;
    historyCopyScheduled = true;
    setTimeout(async () => {
        try {
            const res = await fetch(`us_history.json?v=${encodeURIComponent(state.latestTimestamp || Date.now())}`);
            await res.arrayBuffer(); // read it fully so sw.js finishes saving it
            if (res.ok && !isSavedCopy(res)) storageSet('historyCopiedAt', Date.now());
        } catch (e) { /* try again on a later load */ }
        historyCopyScheduled = false;
    }, 5000);
}

export function refreshLastUpdatedLabel() {
    const el = document.getElementById('lastUpdated');
    if (!el || !state.latestTimestamp) return;
    const { text, title, stale } = formatLastUpdatedLabel(state.latestTimestamp);
    // Offline the prices are the saved copy: say so (this runs every minute, so the
    // offline wording has to live here or it would revert). Offline wording wins over the
    // out-of-date warning: the fix there is reconnecting, not waiting for the scraper.
    const age = text.replace(/^Updated /, '').replace(/ · may be out of date$/, '');
    el.innerText = state.offline ? `Offline · prices from ${age}` : text;
    el.title = title;
    el.classList.toggle('is-offline', state.offline);
    el.classList.toggle('is-stale', stale && !state.offline);
}
