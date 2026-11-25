// --- Centralized Application State & Storage Management ---

import { DEFAULT_FILL_GALLONS, DEFAULT_MPG, GALLON_LIMITS, MPG_LIMITS, readCarSetting, ROUTE_SORTS } from './fillup.js';
import { GRADE_KEYS } from './prices.js';
import { loadJsonPref, storageGet, storageRemove, storageSet } from './storage.js';

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
// Default fuel grade on opening: 'last' remembers the grade picked last time.
export const DEFAULT_GRADES = ['last', ...GRADE_KEYS];

function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

// The grade shown on opening: the default from Settings, or the last one picked.
function initialGasPref() {
    const def = oneOf(storageGet('defaultGrade'), DEFAULT_GRADES, 'last');
    return def === 'last' ? oneOf(storageGet('gasPref'), GRADE_KEYS, 'regular') : def;
}

// Tabs switched off in Settings. All stations starts hidden (the search box still
// lists matching stations); at least one tab always stays shown.
function initialHiddenTabs() {
    // Someone who already chose to open on All stations keeps it.
    const fallback = storageGet('defaultTab') === 'search' ? [] : ['search'];
    const saved = loadJsonPref('hiddenTabs', fallback);
    const hidden = Array.isArray(saved) ? TAB_NAMES.filter(t => saved.includes(t)) : fallback;
    return hidden.length < TAB_NAMES.length ? hidden : [];
}

// The tabs shown in the tab strip, in order.
export function visibleTabs() {
    return TAB_NAMES.filter(t => !state.hiddenTabs.includes(t));
}

export function setTabVisible(tab, visible) {
    if (!TAB_NAMES.includes(tab)) return;
    const hidden = new Set(state.hiddenTabs);
    if (visible) hidden.delete(tab); else hidden.add(tab);
    if (hidden.size >= TAB_NAMES.length) return; // keep at least one tab
    state.hiddenTabs = TAB_NAMES.filter(t => hidden.has(t));
    storageSet('hiddenTabs', JSON.stringify(state.hiddenTabs));
    // Don't open the app on a hidden tab.
    if (state.hiddenTabs.includes(state.defaultTab)) setSetting('defaultTab', visibleTabs()[0]);
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
    mobileViewMode: 'peek', // phone sheet: 'peek' | 'half' | 'full'
    activeMobileStore: null,

    // User preferences (synced to localStorage)
    isDarkMode: initialDarkMode(),
    gasPref: initialGasPref(),
    nearbyRadiusMiles: oneOf(parseFloat(storageGet('nearbyRadius')), NEARBY_RADII, 10),
    nearbySortMode: oneOf(storageGet('nearbySort'), ['price', 'distance'], 'price'),
    favoriteStoreKeys: new Set(loadJsonPref('favoriteStores', [])),
    favoriteRoutes: loadJsonPref('favoriteRoutes', []),
    // Settings panel. Clustering starts on (only when zoomed far out), price colours off;
    // a saved choice wins.
    clusterMarkers: loadBoolPref('clusterMarkers', true),
    colorPins: loadBoolPref('colorPins', false),
    directionsApp: oneOf(storageGet('directionsApp'), DIRECTIONS_APPS, 'google'),
    hiddenTabs: initialHiddenTabs(),
    defaultTab: oneOf(storageGet('defaultTab'), TAB_NAMES, 'nearby'),
    defaultGrade: oneOf(storageGet('defaultGrade'), DEFAULT_GRADES, 'last'),
    autoLocate: loadBoolPref('autoLocate', true),
    // Your usual fill-up and car, for fill-up costs and the best value along a route (fillup.js).
    fillGallons: readCarSetting(storageGet('fillGallons'), GALLON_LIMITS, DEFAULT_FILL_GALLONS),
    mpg: readCarSetting(storageGet('mpg'), MPG_LIMITS, DEFAULT_MPG),
    routeSort: oneOf(storageGet('routeSort'), ROUTE_SORTS, 'value'),
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
if (state.hiddenTabs.includes(state.defaultTab)) state.defaultTab = visibleTabs()[0];

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

export function saveGasPref(pref) {
    state.gasPref = pref;
    storageSet('gasPref', pref);
}

export function saveDarkMode(isDark) {
    state.isDarkMode = isDark;
    storageSet('theme', isDark ? 'dark' : 'light');
}

export function saveNearbyRadius(miles) {
    state.nearbyRadiusMiles = parseFloat(miles);
    storageSet('nearbyRadius', state.nearbyRadiusMiles);
}

export function saveNearbySort(mode) {
    state.nearbySortMode = mode;
    storageSet('nearbySort', mode);
}

export function saveHistoryRangeDays(days) {
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
