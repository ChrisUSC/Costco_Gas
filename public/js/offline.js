// --- Offline mode: saved prices, retries, and the service worker ---

import { lastNetworkPricesAt, loadStatus, refreshLastUpdatedLabel, refreshPrices } from './data.js';
import { showToast } from './dom.js';
import { updateOfflineBasemap } from './map.js';
import { applySearchPlaceholder } from './search.js';
import { state } from './state.js';
import { renderCurrentTab, switchTab } from './tabs.js';
import { formatLastUpdatedLabel } from './time.js';

// Offline (no connection, or sw.js answered with its saved copy) the app keeps working
// with the saved prices: the map gets a built-in outline of the US, the label says the
// prices are saved, and the parts that need a connection (Route, place search, saved
// routes) are hidden. It returns to normal only after fresh prices arrive.
const OFFLINE_RETRY_MS = 3 * 60 * 1000;     // retry while offline (Wi-Fi without internet fires no event)
const STALE_ON_RETURN_MS = 10 * 60 * 1000;  // refresh when the app comes back after this long
let offlineRetryTimer = null;

export function setOfflineMode(offline, { announce = false } = {}) {
    const changed = state.offline !== offline;
    state.offline = offline;
    document.body.classList.toggle('is-offline', offline);
    refreshLastUpdatedLabel();
    applySearchPlaceholder();
    updateOfflineBasemap();

    clearInterval(offlineRetryTimer);
    offlineRetryTimer = offline ? setInterval(refreshPrices, OFFLINE_RETRY_MS) : null;

    if (offline && state.currentTab === 'route') switchTab('nearby');
    else if (changed && state.currentTab === 'favorites' && loadStatus === 'ready') renderCurrentTab(); // saved routes
    if (offline && (changed || announce) && state.latestTimestamp) {
        showToast(`You're offline. Showing saved prices (${formatLastUpdatedLabel(state.latestTimestamp).text.toLowerCase()}).`, 5000);
    }
}

export function setupOfflineHandling() {
    window.addEventListener('offline', () => { if (loadStatus === 'ready') setOfflineMode(true); });
    window.addEventListener('online', () => refreshPrices());
    // Phones resume a home-screen app rather than reloading it, so refresh on return.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (state.offline || Date.now() - lastNetworkPricesAt > STALE_ON_RETURN_MS) refreshPrices();
    });
}

// sw.js keeps the app files and the last prices so the installed app opens without a
// connection. Registered after load so it doesn't compete with the first page load.
export function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Offline support unavailable:', err));
    });
}
