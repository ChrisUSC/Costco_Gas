// --- The user's location: browser geolocation, the IP-based state guess and "Near me" ---

import { showToast } from './dom.js';
import { setSearchAreaVisible } from './map-interactions.js';
import { moveMapTo, placeUserLocationMarker } from './map.js';
import { closeMobileStoreCard } from './sheet.js';
import { state } from './state.js';
import { switchTab } from './tabs.js';

function describeLocationError(err) {
    if (err && err.code === 1) {
        return "Location access is blocked. Allow it in your browser's site settings, or search for a city instead.";
    }
    if (err && err.code === 3) {
        return "Locating you timed out. Try again, or search for a city instead.";
    }
    return "Couldn't get your location. Try again, or search for a city instead.";
}

// The user's position, but only if they have already allowed location access: this never
// shows the browser's permission prompt. Resolves to { lat, lng } or null. maxAgeMs is how
// old a cached position may be (lower it where the user may have moved, e.g. route starts).
export async function getLocationIfGranted({ maxAgeMs = 10 * 60 * 1000 } = {}) {
    if (!navigator.geolocation || !navigator.permissions?.query) return null;
    try {
        const status = await navigator.permissions.query({ name: 'geolocation' });
        if (status.state !== 'granted') return null;
    } catch (e) {
        return null;
    }

    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
            () => resolve(null),
            { maximumAge: maxAgeMs, timeout: 5000 }
        );
    });
}

export function requestBrowserLocation(onSuccess, onError) {
    if (!navigator.geolocation) {
        const err = new Error("Geolocation is not supported by your browser.");
        if (onError) onError(err);
        else showToast("Your browser doesn't support location. Search for a city instead.", 5000);
        return;
    }
    navigator.geolocation.getCurrentPosition(
        onSuccess,
        (err) => {
            if (onError) onError(err);
            else showToast(describeLocationError(err), 5500);
        }
    );
}

export async function detectUserState() {
    try {
        const res = await fetch('https://ipapi.co/region_code/');
        if (res.ok) {
            const code = await res.text();
            if (code && code.trim().length === 2) state.currentStateContext = code.trim().toUpperCase();
        }
    } catch (e) {}
}

export function updateClosestStoreState(loc) {
    if (!loc || state.stores.length === 0) return;
    let closestStore = state.stores.find(s => s.lat && s.lng) || state.stores[0];
    let minDistance = Infinity;
    state.stores.forEach(s => {
        if (!s.lat || !s.lng) return;
        const distance = (s.lat - loc.lat) ** 2 + (s.lng - loc.lng) ** 2;
        if (distance < minDistance) {
            minDistance = distance;
            closestStore = s;
        }
    });
    state.currentStateContext = closestStore.state;
}

export function triggerFindMe() {
    requestBrowserLocation((position) => {
        state.userLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
        state.deviceLocation = { ...state.userLocation };
        closeMobileStoreCard();
        setSearchAreaVisible(false);
        placeUserLocationMarker(state.userLocation, { openPopup: true });
        moveMapTo([state.userLocation.lat, state.userLocation.lng], 10, 2);
        updateClosestStoreState(state.userLocation);
        switchTab('nearby');
    });
}
