// --- Centralized Application State & Storage Management ---

import { loadJsonPref } from './utils.js';

function initialDarkMode() {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function hasExplicitThemePref() {
    const saved = localStorage.getItem('theme');
    return saved === 'dark' || saved === 'light';
}

export const TAB_NAMES = ['nearby', 'lowest', 'route', 'search', 'favorites'];
export const DIRECTIONS_APPS = ['google', 'apple', 'waze'];

function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function loadBoolPref(key, fallback) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
}

// 'light' | 'dark' | 'system' (no saved choice: follow the operating system)
export function getThemePref() {
    const saved = localStorage.getItem('theme');
    return saved === 'dark' || saved === 'light' ? saved : 'system';
}

export function setThemePref(pref) {
    if (pref === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', pref);
    state.isDarkMode = initialDarkMode();
}

// Saves one of the boolean / choice settings above.
export function setSetting(key, value) {
    state[key] = value;
    localStorage.setItem(key, String(value));
}

export const state = {
    // Master data
    stores: [],
    latestTimestamp: null,
    trendBaselineLabel: 'the last update',
    currentStateContext: 'CA',
    userLocation: null,
    currentTab: 'nearby', // 'nearby' | 'lowest' | 'route' | 'search' | 'favorites'

    // Mobile viewport & sheet state
    mobileViewMode: 'map', // 'map' | 'list'
    activeMobileStore: null,

    // User preferences (synced to localStorage)
    isDarkMode: initialDarkMode(),
    gasPref: localStorage.getItem('gasPref') || 'regular',
    nearbyRadiusMiles: parseFloat(localStorage.getItem('nearbyRadius')) || 50,
    nearbySortMode: localStorage.getItem('nearbySort') || 'price', // 'price' | 'distance'
    favoriteStoreKeys: new Set(loadJsonPref('favoriteStores', [])),
    favoriteRoutes: loadJsonPref('favoriteRoutes', []),
    // Settings panel (see SETTINGS_DEFAULTS)
    clusterMarkers: loadBoolPref('clusterMarkers', true),
    colorPins: loadBoolPref('colorPins', true),
    directionsApp: oneOf(localStorage.getItem('directionsApp'), DIRECTIONS_APPS, 'google'),
    defaultTab: oneOf(localStorage.getItem('defaultTab'), TAB_NAMES, 'nearby'),
    autoLocate: loadBoolPref('autoLocate', true),
    historyRangeDays: (() => {
        const val = parseInt(localStorage.getItem('historyRangeDays'), 10);
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
    localStorage.setItem('favoriteStores', JSON.stringify([...state.favoriteStoreKeys]));
    return !wasFav;
}

export function findStore(stateCode, city) {
    return state.stores.find(s => s.state === stateCode && s.city === city);
}

export function setGasPref(pref) {
    state.gasPref = pref;
    localStorage.setItem('gasPref', pref);
}

export function setDarkMode(isDark) {
    state.isDarkMode = isDark;
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

export function setNearbyRadius(miles) {
    state.nearbyRadiusMiles = parseFloat(miles);
    localStorage.setItem('nearbyRadius', state.nearbyRadiusMiles);
}

export function setNearbySort(mode) {
    state.nearbySortMode = mode;
    localStorage.setItem('nearbySort', mode);
}

export function setHistoryRangeDays(days) {
    state.historyRangeDays = days;
    localStorage.setItem('historyRangeDays', days);
}

export function saveFavoriteRoute(route) {
    state.favoriteRoutes.push(route);
    localStorage.setItem('favoriteRoutes', JSON.stringify(state.favoriteRoutes));
}

export function updateFavoriteRoute(id, updatedFields) {
    const target = state.favoriteRoutes.find(r => r.id === id);
    if (target) {
        Object.assign(target, updatedFields);
        localStorage.setItem('favoriteRoutes', JSON.stringify(state.favoriteRoutes));
    }
}

export function removeFavoriteRoute(id) {
    state.favoriteRoutes = state.favoriteRoutes.filter(r => r.id !== id);
    localStorage.setItem('favoriteRoutes', JSON.stringify(state.favoriteRoutes));
}
