// --- Centralized Application State & Storage Management ---

import { loadJsonPref, storageGet, storageSet, storageRemove, GRADE_KEYS } from './utils.js';

function initialDarkMode() {
    const saved = storageGet('theme');
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function hasExplicitThemePref() {
    const saved = storageGet('theme');
    return saved === 'dark' || saved === 'light';
}

export const TAB_NAMES = ['nearby', 'lowest', 'route', 'search', 'favorites'];
export const DIRECTIONS_APPS = ['google', 'apple', 'waze'];
export const NEARBY_RADII = [5, 10, 25, 50, 100];

function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function loadBoolPref(key, fallback) {
    const v = storageGet(key);
    return v === null ? fallback : v === 'true';
}

// 'light' | 'dark' | 'system' (no saved choice: follow the operating system)
export function getThemePref() {
    const saved = storageGet('theme');
    return saved === 'dark' || saved === 'light' ? saved : 'system';
}

export function setThemePref(pref) {
    if (pref === 'system') storageRemove('theme');
    else storageSet('theme', pref);
    state.isDarkMode = initialDarkMode();
}

// Saves one of the boolean / choice settings above.
export function setSetting(key, value) {
    state[key] = value;
    storageSet(key, value);
}

export const state = {
    // Master data
    stores: [],
    latestTimestamp: null,
    trendBaselineLabel: 'the last update',
    currentStateContext: 'CA',
    userLocation: null,   // where the Nearby list is centred (device, searched place or map centre)
    deviceLocation: null, // last position from the device itself (proof location access is allowed)
    offline: false,       // showing saved prices: no connection, or the network couldn't be reached
    currentTab: 'nearby', // 'nearby' | 'lowest' | 'route' | 'search' | 'favorites'

    // Mobile viewport & sheet state
    mobileViewMode: 'map', // 'map' | 'list'
    activeMobileStore: null,

    // User preferences (synced to localStorage)
    isDarkMode: initialDarkMode(),
    gasPref: oneOf(storageGet('gasPref'), GRADE_KEYS, 'regular'),
    nearbyRadiusMiles: oneOf(parseFloat(storageGet('nearbyRadius')), NEARBY_RADII, 50),
    nearbySortMode: oneOf(storageGet('nearbySort'), ['price', 'distance'], 'price'),
    favoriteStoreKeys: new Set(loadJsonPref('favoriteStores', [])),
    favoriteRoutes: loadJsonPref('favoriteRoutes', []),
    // Settings panel (see SETTINGS_DEFAULTS)
    clusterMarkers: loadBoolPref('clusterMarkers', true),
    colorPins: loadBoolPref('colorPins', true),
    directionsApp: oneOf(storageGet('directionsApp'), DIRECTIONS_APPS, 'google'),
    defaultTab: oneOf(storageGet('defaultTab'), TAB_NAMES, 'nearby'),
    autoLocate: loadBoolPref('autoLocate', true),
    historyRangeDays: (() => {
        const val = parseInt(storageGet('historyRangeDays'), 10);
        return isNaN(val) ? 30 : val;
    })(),

    // Route calculation & saved routes state
    lastRouteState: null,
    routeOriginLocation: null,
    routeDestLocation: null,
    editingRouteId: null,
    editSnapshot: null
};

export function favoriteKey(stateCode, city) {
    return `${stateCode}_${city}`;
}

export function isFavoriteStore(stateCode, city) {
    return state.favoriteStoreKeys.has(favoriteKey(stateCode, city));
}

export function toggleFavoriteStore(stateCode, city) {
    const key = favoriteKey(stateCode, city);
    const wasFav = state.favoriteStoreKeys.has(key);
    if (wasFav) {
        state.favoriteStoreKeys.delete(key);
    } else {
        state.favoriteStoreKeys.add(key);
    }
    storageSet('favoriteStores', JSON.stringify([...state.favoriteStoreKeys]));
    return !wasFav;
}

export function findStore(stateCode, city) {
    return state.stores.find(s => s.state === stateCode && s.city === city);
}

export function setGasPref(pref) {
    state.gasPref = pref;
    storageSet('gasPref', pref);
}

export function setDarkMode(isDark) {
    state.isDarkMode = isDark;
    storageSet('theme', isDark ? 'dark' : 'light');
}

export function setNearbyRadius(miles) {
    state.nearbyRadiusMiles = parseFloat(miles);
    storageSet('nearbyRadius', state.nearbyRadiusMiles);
}

export function setNearbySort(mode) {
    state.nearbySortMode = mode;
    storageSet('nearbySort', mode);
}

export function setHistoryRangeDays(days) {
    state.historyRangeDays = days;
    storageSet('historyRangeDays', days);
}

export function saveFavoriteRoute(route) {
    state.favoriteRoutes.push(route);
    storageSet('favoriteRoutes', JSON.stringify(state.favoriteRoutes));
}

export function updateFavoriteRoute(id, updatedFields) {
    const target = state.favoriteRoutes.find(r => r.id === id);
    if (target) {
        Object.assign(target, updatedFields);
        storageSet('favoriteRoutes', JSON.stringify(state.favoriteRoutes));
    }
}

export function removeFavoriteRoute(id) {
    state.favoriteRoutes = state.favoriteRoutes.filter(r => r.id !== id);
    storageSet('favoriteRoutes', JSON.stringify(state.favoriteRoutes));
}
