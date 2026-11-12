// --- Favorite and share buttons, and opening a shared ?store= link ---

import { renderMobileStoreCardContent } from './components.js';
import { showToast } from './dom.js';
import { map } from './map.js';
import { refreshMapAndList } from './markers.js';
import { initialUrl } from './nav.js';
import { findStore, state, toggleFavoriteStore } from './state.js';

// A ?store=CA_City link, opened once the data has loaded (and kept in the URL until then).
export let sharedStoreKey = initialUrl.store;

export function toggleFavoriteStoreAndRefresh(stateCode, city) {
    const isNowFav = toggleFavoriteStore(stateCode, city);
    showToast(isNowFav ? '★ Added to favorites' : 'Removed from favorites');

    refreshMapAndList();

    if (state.activeMobileStore && state.activeMobileStore.state === stateCode && state.activeMobileStore.city === city) {
        renderMobileStoreCardContent(state.activeMobileStore);
    }
}

function getShareUrl(stateCode, city) {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('store', `${stateCode}_${city}`);
    return url.toString();
}

export async function shareStore(stateCode, city, label) {
    const url = getShareUrl(stateCode, city);

    if (navigator.share) {
        try {
            await navigator.share({ title: `Costco Gas — ${label}`, url });
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
        }
    }

    try {
        await navigator.clipboard.writeText(url);
        showToast('Link copied to clipboard!');
    } catch (e) {
        if (copyTextFallback(url)) {
            showToast('Link copied to clipboard!');
        } else {
            showToast(`Couldn't copy automatically. Link: ${url}`, 9000);
        }
    }
}

// For browsers/contexts without the async Clipboard API (e.g. non-secure origins).
function copyTextFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok;
    try {
        ok = document.execCommand('copy');
    } catch (e) {
        ok = false;
    }
    ta.remove();
    return ok;
}

export function openSharedStoreIfPresent() {
    const storeKey = sharedStoreKey;
    sharedStoreKey = null; // only once, not again after a retry
    if (!storeKey) return false;

    const sepIndex = storeKey.indexOf('_');
    if (sepIndex === -1) return false;
    const stateCode = storeKey.slice(0, sepIndex);
    const city = storeKey.slice(sepIndex + 1);

    const store = findStore(stateCode, city);
    if (!store || !store.lat || !store.lng) {
        console.warn(`Shared store "${storeKey}" not found.`);
        return false;
    }

    map.setView([store.lat, store.lng], 14);
    if (store.leafletMarker) {
        setTimeout(() => store.leafletMarker.openPopup(), 300);
    }
    return true;
}
