// --- Main Application Entry Point, Map Lifecycle, Sidebar Views & Initialization ---

import {
    CARTO_API_KEY,
    GRADE_INFO,
    GRADE_KEYS,
    filterStoresForCurrentGrade,
    formatPriceDisplay,
    extractGradePrices,
    getValidPrice,
    getRelativeTimeLabel,
    formatLastUpdatedLabel,
    getDistanceMiles,
    gradeVal,
    gradeStr,
    formatAddress,
    hasGradeData,
    shouldFilterStoresByGrade,
    gasStatusHtml,
    gasHoursDetailsHtml,
    escapeHtml,
    debounce,
    directionsUrl,
    DIRECTIONS_APP_LABELS,
    showToast,
    prefersReducedMotion,
    requestBrowserLocation,
    storeMatchesQuery,
    getLocationIfGranted,
    trapFocus,
    PHONE_MAX_WIDTH
} from './js/utils.js';
import {
    state,
    isFavoriteStore,
    toggleFavoriteStore,
    findStore,
    hasExplicitThemePref,
    getThemePref,
    setThemePref,
    setSetting,
    TAB_NAMES,
    DIRECTIONS_APPS,
    NEARBY_RADII,
    setGasPref as saveGasPref,
    setDarkMode as saveDarkMode,
    setNearbyRadius as saveNearbyRadius,
    setNearbySort as saveNearbySort
} from './js/state.js';
import {
    createStoreCard,
    appendPagedCards,
    skeletonCardsHtml,
    errorStateHtml,
    emptyStateHtml,
    priceTilesHtml,
    phoneLinkHtml,
    favoriteButtonHtml,
    shareButtonHtml,
    DIRECTIONS_ICON,
    renderSavedRoutesHtml,
    renderMobileStoreCardContent
} from './js/components.js';
import { icon } from './js/icons.js';
import {
    initNav,
    readUrlParams,
    syncUrl,
    currentOverlay,
    pushOverlay,
    replaceOverlay,
    popOverlay
} from './js/nav.js';
import {
    openHistoryModal,
    closeHistoryModal,
    setHistoryRange,
    refreshChartTheme,
    isChartModalOpen,
    trapModalFocus
} from './js/charts.js';
import {
    initSearch,
    setupInputAutocomplete,
    closeAutocompleteDropdown,
    selectAutocompleteItem
} from './js/search.js';
import {
    initRoutes,
    renderRoutePanel,
    saveCurrentRouteAsFavorite,
    removeFavoriteRouteHandler,
    loadFavoriteRoute,
    startEditRoute,
    cancelEditRoute,
    useMyLocationForRoute,
    findGasAlongRoute,
    clearRouteVisuals
} from './js/routes.js';

let map;
let mapTileLayer;
let markersLayer;
let routeLayer;
let userLocationMarker = null;
let searchLocationMarker = null;
let storeMarkers = [];      // markers currently in markersLayer
let popupStore = null;      // station whose desktop popup is open (for the URL)
let loadStatus = 'loading'; // 'loading' | 'ready' | 'error'
const initialUrl = readUrlParams();
let sharedStoreKey = new URLSearchParams(window.location.search).get('store'); // ?store=CA_City link

// Pins cluster below this zoom; from here on every station shows its own pin and price.
const PIN_ZOOM = 9;

// Layout tiers (keep in sync with the media queries in styles.css):
//   phone   <= 599px   map + draggable bottom sheet for the list
//   tablet  600-1099px sidebar + map, store details in a sheet over the map
//   desktop >= 1100px  sidebar + map, store details in the Leaflet popup
const SHEET_MAX_WIDTH = 1099;

function isPhoneViewport() {
    return window.innerWidth <= PHONE_MAX_WIDTH;
}

// Phones and tablets show store details in the bottom sheet instead of a map popup.
function isMobileViewport() {
    return window.innerWidth <= SHEET_MAX_WIDTH;
}

// --- Phone list sheet: peek (tabs only) / half / full ---
const SHEET_STATES = ['peek', 'half', 'full'];
const SHEET_HALF_FRACTION = 0.5; // how much of the sheet is pushed down at "half"
const DETAIL_MAX_FRACTION = 0.88; // a station card never covers more of the sheet than this
let sheetStateBeforeDetail = null; // list position to return to when the station card closes

// Resting translateY (px) of the "half" state. For the list it's half the sheet; a station
// card instead sizes the sheet to its content, so it is never cut off and covers no more
// map than it needs.
function sheetHalfY() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return 0;
    const h = sidebar.offsetHeight;
    const detail = document.getElementById('sheetDetail');
    const content = document.getElementById('sheetDetailContent');
    if (!sidebar.classList.contains('has-detail') || !detail || detail.hidden || !content) {
        return Math.round(h * SHEET_HALF_FRACTION);
    }
    const cs = getComputedStyle(detail);
    const needed = (document.getElementById('sheetGrabber')?.offsetHeight || 0)
        + content.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return Math.round(Math.max(h * (1 - DETAIL_MAX_FRACTION), h - needed));
}

function setSheetState(next, { keepDetail = false } = {}) {
    if (!SHEET_STATES.includes(next)) next = 'peek';
    state.mobileViewMode = next;
    const container = document.getElementById('appContainer');
    const sidebar = document.getElementById('sidebar');
    if (container) {
        SHEET_STATES.forEach(s => container.classList.toggle(`sheet-${s}`, s === next));
        container.classList.toggle('mobile-view-list', next !== 'peek');
    }
    if (sidebar) sidebar.style.transform = ''; // drop any drag offset
    syncSheetA11y();
    // Dragging down to peek dismisses the details; opening further keeps them.
    if (!keepDetail && state.activeMobileStore && next === 'peek') closeMobileStoreCard({ restoreSheet: false });
    if (map) setTimeout(() => map.invalidateSize(), 60);
}

// At "peek" only the tab strip is visible, so the list behind it must not be focusable.
function syncSheetA11y() {
    const content = document.getElementById('sidebarContent');
    const grabber = document.getElementById('sheetGrabber');
    const collapsed = isPhoneViewport() && state.mobileViewMode === 'peek';
    if (content) content.toggleAttribute('inert', collapsed);
    if (grabber) grabber.setAttribute('aria-expanded', String(!collapsed));
    // At "half" the lower part of the sheet is off-screen; the list must stop above it.
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        const halfY = `${sheetHalfY()}px`;
        sidebar.style.setProperty('--half-y', halfY);
        sidebar.style.setProperty('--sheet-hidden', halfY);
    }
}

// Back-compat wrapper: 'list' opens the sheet, 'map' tucks it away to show the map.
function setMobileView(mode) {
    setSheetState(mode === 'list' ? (state.mobileViewMode === 'full' ? 'full' : 'half') : 'peek');
}

function setupSheetDrag() {
    const sidebar = document.getElementById('sidebar');
    const grabber = document.getElementById('sheetGrabber');
    const container = document.getElementById('appContainer');
    if (!sidebar || !grabber || !container) return;

    const peekHeight = () => grabber.offsetHeight + document.getElementById('sidebarTabs').offsetHeight;
    // Resting translateY (px) of each state, measured against the sheet's own height.
    const restingY = () => {
        const h = sidebar.offsetHeight;
        return { full: 0, half: sheetHalfY(), peek: Math.max(0, h - peekHeight()) };
    };
    const nearest = (y) => {
        const r = restingY();
        return SHEET_STATES.reduce((best, st) => Math.abs(r[st] - y) < Math.abs(r[best] - y) ? st : best, 'peek');
    };

    let drag = null;
    grabber.addEventListener('pointerdown', (e) => {
        if (!isPhoneViewport() || (e.pointerType === 'mouse' && e.button !== 0)) return;
        const r = restingY();
        drag = { startY: e.clientY, startPos: r[state.mobileViewMode], lastY: e.clientY, lastT: e.timeStamp, velocity: 0, moved: false };
        grabber.setPointerCapture(e.pointerId);
    });
    grabber.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dy = e.clientY - drag.startY;
        if (!drag.moved && Math.abs(dy) < 6) return;
        if (!drag.moved) { drag.moved = true; sidebar.classList.add('dragging'); }
        const dt = e.timeStamp - drag.lastT;
        if (dt > 0) drag.velocity = (e.clientY - drag.lastY) / dt; // px/ms, + is downward
        drag.lastY = e.clientY; drag.lastT = e.timeStamp;
        const r = restingY();
        const y = Math.min(r.peek, Math.max(0, drag.startPos + dy));
        sidebar.style.transform = `translateY(${y}px)`;
    });
    const endDrag = (e) => {
        if (!drag) return;
        const d = drag; drag = null;
        sidebar.classList.remove('dragging');
        if (!d.moved) return; // a plain tap is handled by the click listener
        d.suppressClick = true;
        grabber.dataset.justDragged = '1';
        setTimeout(() => delete grabber.dataset.justDragged, 0);
        const y = d.startPos + (e.clientY - d.startY);
        let target = nearest(y);
        if (Math.abs(d.velocity) > 0.5) { // a flick moves one step in its direction
            const i = SHEET_STATES.indexOf(state.mobileViewMode);
            const step = d.velocity < 0 ? 1 : -1; // up = more open
            target = SHEET_STATES[Math.min(2, Math.max(0, i + step))];
        }
        setSheetState(target);
    };
    grabber.addEventListener('pointerup', endDrag);
    grabber.addEventListener('pointercancel', endDrag);

    // Tap / Enter / Space cycles peek -> half -> full -> peek; arrows move one step.
    grabber.addEventListener('click', () => {
        if (grabber.dataset.justDragged) return;
        const i = SHEET_STATES.indexOf(state.mobileViewMode);
        setSheetState(SHEET_STATES[(i + 1) % SHEET_STATES.length]);
    });
    grabber.addEventListener('keydown', (e) => {
        const i = SHEET_STATES.indexOf(state.mobileViewMode);
        if (e.key === 'ArrowUp') setSheetState(SHEET_STATES[Math.min(2, i + 1)]);
        else if (e.key === 'ArrowDown') setSheetState(SHEET_STATES[Math.max(0, i - 1)]);
        else return;
        e.preventDefault();
    });
}

// --- Tablet: collapsible station list (portrait) ---
function isTabletPortrait() {
    return window.innerWidth > PHONE_MAX_WIDTH && window.innerWidth <= SHEET_MAX_WIDTH
        && window.matchMedia?.('(orientation: portrait)').matches;
}

function setSidebarCollapsed(collapsed) {
    const container = document.getElementById('appContainer');
    const toggle = document.getElementById('sidebarToggle');
    if (!container) return;
    container.classList.toggle('sidebar-collapsed', collapsed);
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.toggleAttribute('inert', collapsed && isTabletPortrait());
    if (toggle) {
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.querySelector('span').textContent = collapsed ? 'List' : 'Hide';
    }
    if (map) setTimeout(() => map.invalidateSize(), 260);
}

// The collapsed state only applies in tablet portrait; elsewhere the sidebar is always usable.
function syncSidebarToggle() {
    const container = document.getElementById('appContainer');
    const sidebar = document.getElementById('sidebar');
    if (!container || !sidebar) return;
    const collapsed = container.classList.contains('sidebar-collapsed');
    sidebar.toggleAttribute('inert', collapsed && isTabletPortrait());
}

// --- Desktop / tablet: "Search this area" + list <-> map hover link ---
// Only a drag or a zoom the user performed reveals the button; our own flyTo/fitBounds
// calls also fire zoomend, so zoom counts only right after a wheel, pinch, key or +/- tap.
let lastUserZoomInput = 0;

function setSearchAreaVisible(visible) {
    const btn = document.getElementById('searchAreaBtn');
    if (btn) btn.hidden = !visible || isPhoneViewport();
}

function searchThisArea() {
    if (!map) return;
    const c = map.getCenter();
    state.userLocation = { lat: c.lat, lng: c.lng };
    if (searchLocationMarker) map.removeLayer(searchLocationMarker);
    searchLocationMarker = L.circleMarker([c.lat, c.lng], {
        radius: 8, fillColor: "#f59e0b", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
    }).addTo(map).bindPopup('<b>Search centre</b>');
    updateClosestStoreState(state.userLocation);
    setSearchAreaVisible(false);
    switchTab('nearby');
    showToast('Showing stations near the centre of the map');
}

function setupMapAreaSearch() {
    // Only a drag or a user zoom reveals the button, not our own flyTo/fitBounds calls.
    const mapEl = map.getContainer();
    const noteZoomInput = () => { lastUserZoomInput = Date.now(); };
    ['wheel', 'dblclick'].forEach(t => mapEl.addEventListener(t, noteZoomInput, { passive: true }));
    mapEl.addEventListener('touchstart', (e) => { if (e.touches.length > 1) noteZoomInput(); }, { passive: true });
    mapEl.addEventListener('keydown', (e) => { if (/^[-+=]$/.test(e.key)) noteZoomInput(); });
    mapEl.addEventListener('click', (e) => { if (e.target.closest('.leaflet-control-zoom')) noteZoomInput(); });
    map.on('dragend', () => setSearchAreaVisible(true));
    map.on('zoomend', () => { if (Date.now() - lastUserZoomInput < 1500) setSearchAreaVisible(true); });

    // Hovering a card highlights its pin (mouse only; touch has no hover).
    const content = document.getElementById('sidebarContent');
    if (!content || !window.matchMedia?.('(hover: hover)').matches) return;
    const setPinLinked = (card, on) => {
        const store = card && card.dataset.state && findStore(card.dataset.state, card.dataset.city);
        const marker = store && store.leafletMarker;
        if (!marker) return;
        marker.setZIndexOffset(on ? 2000 : 0);
        marker.getElement()?.classList.toggle('pin-linked', on);
    };
    content.addEventListener('mouseover', (e) => {
        const card = e.target.closest('.store-card[data-city]');
        if (card && !card.contains(e.relatedTarget)) setPinLinked(card, true);
    });
    content.addEventListener('mouseout', (e) => {
        const card = e.target.closest('.store-card[data-city]');
        if (card && !card.contains(e.relatedTarget)) setPinLinked(card, false);
    });
}

// Hovering a pin highlights the matching card when it is in the current list.
function linkPinToCard(marker, store, on) {
    const content = document.getElementById('sidebarContent');
    if (!content) return;
    const card = [...content.querySelectorAll('.store-card[data-city]')]
        .find(c => c.dataset.state === store.state && c.dataset.city === store.city);
    if (!card) return;
    card.classList.toggle('pin-hover', on);
    if (on) card.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

const storeKey = (store) => `${store.state}_${store.city}`;
const sheetOverlay = (store) => ({ type: 'sheet', state: store.state, city: store.city });

// Record the open sheet in history so Back closes it (swapping stations reuses the entry).
function recordSheetOpen(store) {
    if (currentOverlay()?.type === 'sheet') replaceOverlay(sheetOverlay(store));
    else pushOverlay(sheetOverlay(store));
}

function openMobileStoreCard(store, { fromHistory = false } = {}) {
    if (!store) return;
    state.activeMobileStore = store;
    renderMobileStoreCardContent(store);
    const container = document.getElementById('appContainer');

    if (isPhoneViewport()) {
        // One sheet: the list gives way to the station's details, same drag heights.
        const sidebar = document.getElementById('sidebar');
        const detail = document.getElementById('sheetDetail');
        if (sidebar && !sidebar.classList.contains('has-detail')) sheetStateBeforeDetail = state.mobileViewMode;
        if (detail) { detail.hidden = false; detail.scrollTop = 0; }
        if (sidebar) sidebar.classList.add('has-detail');
        setSheetState('half', { keepDetail: true }); // sized to the card (see sheetHalfY)
        detail?.querySelector('.mobile-sheet-close')?.focus({ preventScroll: true });
        if (!fromHistory) recordSheetOpen(store);
        return;
    }

    const sheet = document.getElementById('mobileStoreSheet');
    if (sheet) {
        sheet.classList.add('active');
        sheet.setAttribute('aria-hidden', 'false');
        sheet.removeAttribute('inert');
    }
    if (container) container.classList.add('mobile-sheet-open');
    if (!fromHistory) recordSheetOpen(store);
}

function closeMobileStoreCard({ fromHistory = false, restoreSheet = true } = {}) {
    const hadStore = Boolean(state.activeMobileStore);
    state.activeMobileStore = null;
    const sheet = document.getElementById('mobileStoreSheet');
    const container = document.getElementById('appContainer');
    const sidebar = document.getElementById('sidebar');
    const detail = document.getElementById('sheetDetail');
    if (sheet) {
        sheet.classList.remove('active');
        sheet.setAttribute('aria-hidden', 'true');
        sheet.setAttribute('inert', '');
    }
    if (container) container.classList.remove('mobile-sheet-open');
    if (sidebar) sidebar.classList.remove('has-detail');
    if (detail) detail.hidden = true;
    // Put the list back where it was before the card opened (e.g. tucked away at "peek").
    const before = sheetStateBeforeDetail;
    sheetStateBeforeDetail = null;
    if (hadStore && isPhoneViewport()) {
        if (restoreSheet && before && before !== state.mobileViewMode) setSheetState(before, { keepDetail: true });
        else syncSheetA11y();
    }
    if (hadStore && isPhoneViewport()) document.getElementById('sheetGrabber')?.focus({ preventScroll: true });
    if (hadStore && !fromHistory && !popOverlay('sheet')) syncUrl();
}

// --- Price-history modal + history entry ---
function openHistory(stateCode, city) {
    openHistoryModal(stateCode, city);
    const active = state.activeMobileStore;
    const overlay = { type: 'modal', state: stateCode, city, sheet: active ? sheetOverlay(active) : null };
    if (currentOverlay()?.type === 'modal') replaceOverlay(overlay);
    else pushOverlay(overlay);
}

function closeHistory() {
    if (!isChartModalOpen()) return;
    closeHistoryModal();
    popOverlay('modal');
}

// Browser Back / Forward landed on an entry: make the sheet and modal match it.
function applyOverlayFromHistory(overlay) {
    const wantSettings = overlay?.type === 'settings';
    if (isSettingsOpen() && !wantSettings) closeSettings({ fromHistory: true });
    else if (wantSettings && !isSettingsOpen()) openSettings({ fromHistory: true });

    const wantModal = overlay?.type === 'modal';
    if (isChartModalOpen() && !wantModal) closeHistoryModal();
    else if (wantModal && !isChartModalOpen()) openHistoryModal(overlay.state, overlay.city);

    const want = overlay?.type === 'sheet' ? overlay : overlay?.sheet || null;
    const cur = state.activeMobileStore;
    if (cur && !want) {
        closeMobileStoreCard({ fromHistory: true });
    } else if (want && isMobileViewport() && !(cur && cur.state === want.state && cur.city === want.city)) {
        const store = findStore(want.state, want.city);
        if (store) openMobileStoreCard(store, { fromHistory: true });
    }
}

// On phones the sheet covers the lower half, so aim the map at the visible upper part.
// Call after the card has opened, so its height is known.
function sheetAwareCenter(latlng, zoom) {
    if (!isPhoneViewport() || !map) return latlng;
    const sidebar = document.getElementById('sidebar');
    const covered = sidebar ? sidebar.offsetHeight - sheetHalfY() : map.getSize().y * 0.44;
    return map.unproject(map.project(latlng, zoom).add([0, covered / 2]), zoom);
}

function refreshLastUpdatedLabel() {
    const el = document.getElementById('lastUpdated');
    if (!el || !state.latestTimestamp) return;
    const { text, title } = formatLastUpdatedLabel(state.latestTimestamp);
    el.innerText = text;
    el.title = title;
}

// --- Shareable Store Links & Favorites ---

function getShareUrl(stateCode, city) {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('store', `${stateCode}_${city}`);
    return url.toString();
}

// The stations the map should show: the route's stations on the Route tab, otherwise all.
function currentMapData() {
    return state.currentTab === 'route' && state.lastRouteState?.along?.length > 0
        ? state.lastRouteState.along
        : state.stores;
}

// Rebuilding the markers removes the one whose desktop popup is open, which closes it.
// Re-open it afterwards (if that station is still on the map) so the user keeps their place.
function refreshMapAndList() {
    const openPopupStore = popupStore;
    if (state.stores.length > 0) renderMap(currentMapData());
    refreshCurrentDisplay();
    if (!openPopupStore || isMobileViewport()) return;
    const marker = findStore(openPopupStore.state, openPopupStore.city)?.leafletMarker;
    if (marker && marker._map) marker.openPopup();
}

function toggleFavoriteStoreAndRefresh(stateCode, city) {
    const isNowFav = toggleFavoriteStore(stateCode, city);
    showToast(isNowFav ? '★ Added to favorites' : 'Removed from favorites');

    refreshMapAndList();

    if (state.activeMobileStore && state.activeMobileStore.state === stateCode && state.activeMobileStore.city === city) {
        renderMobileStoreCardContent(state.activeMobileStore);
    }
}

async function shareStore(stateCode, city, label) {
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
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch (e) {
        ok = false;
    }
    ta.remove();
    return ok;
}

function openSharedStoreIfPresent() {
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

// --- Preferences ---

function applyTheme(isDark) {
    state.isDarkMode = isDark;
    document.body.classList.toggle('dark-mode', isDark);
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) themeBtn.setAttribute('aria-pressed', String(isDark)); // sun / moon swap is CSS
    // Browser chrome (address bar, status bar) follows the header surface.
    const surface = getComputedStyle(document.body).getPropertyValue('--surface').trim();
    if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface);
}

// On narrow phones the search box shares its row with the grade toggle, so the
// full placeholder is cut off ("Search city or z…"). Use a short one there.
const SEARCH_PLACEHOLDER_FULL = 'Search city or zip';
const SEARCH_PLACEHOLDER_SHORT = 'City or zip';

function initSearchPlaceholder() {
    const input = document.getElementById('searchInput');
    const narrow = window.matchMedia?.('(max-width: 480px)');
    if (!input || !narrow) return;
    const apply = () => {
        input.placeholder = narrow.matches ? SEARCH_PLACEHOLDER_SHORT : SEARCH_PLACEHOLDER_FULL;
    };
    apply();
    narrow.addEventListener?.('change', apply);
}

function initPreferences() {
    applyTheme(state.isDarkMode);
    // Follow the OS light/dark setting until the user picks a theme explicitly.
    const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    systemTheme?.addEventListener?.('change', (e) => {
        if (hasExplicitThemePref()) return;
        applyTheme(e.matches);
        setMapTiles();
        refreshChartTheme();
    });
    syncGradeButtons();
}

function syncGradeButtons() {
    GRADE_KEYS.forEach(g => {
        const btn = document.getElementById(`btn-${g}`);
        if (!btn) return;
        btn.classList.toggle('active', g === state.gasPref);
        btn.setAttribute('aria-pressed', String(g === state.gasPref));
    });
}

function toggleTheme() {
    const newTheme = !state.isDarkMode;
    saveDarkMode(newTheme);
    applyTheme(newTheme);
    setMapTiles();
    refreshChartTheme();
}

// --- Settings panel ---

let lastFocusedBeforeSettings = null;

function isSettingsOpen() {
    return document.getElementById('settingsModal')?.classList.contains('active') || false;
}

// Fill the form from the current state (the 🌙 button can change the theme meanwhile).
function syncSettingsForm() {
    const form = document.getElementById('settingsForm');
    if (!form) return;
    form.elements.clusterMarkers.checked = state.clusterMarkers;
    form.elements.colorPins.checked = state.colorPins;
    form.elements.autoLocate.checked = state.autoLocate;
    form.elements.defaultTab.value = state.defaultTab;
    form.querySelector(`input[name="directionsApp"][value="${state.directionsApp}"]`).checked = true;
    form.querySelector(`input[name="theme"][value="${getThemePref()}"]`).checked = true;
}

function openSettings({ fromHistory = false } = {}) {
    const modal = document.getElementById('settingsModal');
    if (!modal || isSettingsOpen()) return;
    if (isChartModalOpen()) closeHistory();
    lastFocusedBeforeSettings = document.activeElement;
    syncSettingsForm();
    modal.classList.add('active');
    modal.querySelector('.modal-close')?.focus();
    if (!fromHistory) pushOverlay({ type: 'settings' });
}

function closeSettings({ fromHistory = false } = {}) {
    const modal = document.getElementById('settingsModal');
    if (!modal || !isSettingsOpen()) return;
    modal.classList.remove('active');
    if (lastFocusedBeforeSettings && document.contains(lastFocusedBeforeSettings)) {
        lastFocusedBeforeSettings.focus();
    }
    lastFocusedBeforeSettings = null;
    if (!fromHistory) popOverlay('settings');
}

// Keeps Tab / Shift+Tab inside the open settings panel. Returns true if handled.
function trapSettingsFocus(e) {
    return isSettingsOpen() && trapFocus(e, document.getElementById('settingsModal'));
}

// Every setting applies as soon as it changes.
function applySettingChange(name, input) {
    switch (name) {
        case 'clusterMarkers':
            setSetting('clusterMarkers', input.checked);
            rebuildMarkersLayer();
            break;
        case 'colorPins':
            setSetting('colorPins', input.checked);
            updatePinTiers();
            break;
        case 'directionsApp':
            if (!DIRECTIONS_APPS.includes(input.value)) return;
            setSetting('directionsApp', input.value);
            refreshDirectionsLinks();
            break;
        case 'theme':
            setThemePref(input.value);
            applyTheme(state.isDarkMode);
            setMapTiles();
            refreshChartTheme();
            break;
        case 'defaultTab':
            if (TAB_NAMES.includes(input.value)) setSetting('defaultTab', input.value);
            break;
        case 'autoLocate':
            setSetting('autoLocate', input.checked);
            break;
    }
}

// Re-render everything that shows a Directions link so it uses the new app.
function refreshDirectionsLinks() {
    if (loadStatus === 'ready') renderCurrentTab();
    if (state.activeMobileStore) renderMobileStoreCardContent(state.activeMobileStore);
    if (popupStore && popupStore.leafletMarker?.isPopupOpen()) {
        popupStore.leafletMarker.getPopup().setContent(storePopupHtml(popupStore));
    }
}

function setupSettings() {
    const form = document.getElementById('settingsForm');
    form?.addEventListener('change', (e) => {
        if (e.target.name) applySettingChange(e.target.name, e.target);
    });
}

function setGasPref(pref) {
    saveGasPref(pref);

    syncGradeButtons();

    refreshMapAndList();

    if (state.activeMobileStore) {
        if (shouldFilterStoresByGrade(state.gasPref) && !hasGradeData(state.activeMobileStore, state.gasPref)) {
            closeMobileStoreCard();
        } else {
            renderMobileStoreCardContent(state.activeMobileStore);
        }
    }
}

// --- Map Logic ---

function setMapTiles() {
    if (mapTileLayer && map) map.removeLayer(mapTileLayer);
    const style = state.isDarkMode ? 'dark_all' : 'rastertiles/voyager';
    mapTileLayer = L.tileLayer(
        `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`,
        {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        }
    );
    if (map) mapTileLayer.addTo(map);
}

function checkZoomLevel() {
    if (!map) return;
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.classList.toggle('map-show-prices', map.getZoom() >= PIN_ZOOM);
}

function setupMobileSheetGestures() {
    const sheet = document.getElementById('mobileStoreSheet');
    if (!sheet) return;

    let touchStartY = null;
    sheet.addEventListener('touchstart', (e) => {
        if (sheet.scrollTop <= 0) {
            touchStartY = e.touches[0].clientY;
        } else {
            touchStartY = null;
        }
    }, { passive: true });

    sheet.addEventListener('touchend', (e) => {
        if (touchStartY === null) return;
        const deltaY = e.changedTouches[0].clientY - touchStartY;
        if (deltaY > 45) {
            closeMobileStoreCard();
        }
        touchStartY = null;
    }, { passive: true });
}

// --- Offline support ---
// sw.js keeps the app files and the last prices so the installed app opens without a
// connection. Registered after load so it doesn't compete with the first page load.
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Offline support unavailable:', err));
    });
}

// --- Phones: only the map zooms ---
// styles.css stops pinch / double-tap page zoom with touch-action (same media query). iOS
// Safari doesn't always honour that for pinch, so also cancel its page-zoom gestures when
// they start outside the map. The map's own pinch zoom is Leaflet's, from touch events.
const ZOOM_LOCK_QUERY = '(max-width: 599px), (pointer: coarse) and (max-height: 500px)';

function lockPageZoomOnPhones() {
    const phone = window.matchMedia?.(ZOOM_LOCK_QUERY);
    if (!phone) return;
    const cancel = (e) => {
        if (phone.matches && !(e.target instanceof Element && e.target.closest('#map'))) e.preventDefault();
    };
    ['gesturestart', 'gesturechange'].forEach(type => document.addEventListener(type, cancel, { passive: false }));
}

// --- Double-tap / double-click to zoom ---
// Leaflet relies on the browser's dblclick. Browsers that don't send one for touch (iOS
// Safari) fall back to Leaflet's own detection, which only counts two taps within 200ms, so
// a relaxed double-tap does nothing. Touch is detected here instead, with a wider window.
const DOUBLE_TAP_MS = 350;      // max gap between the two taps
const DOUBLE_TAP_SLOP_PX = 40;  // max distance between the two taps
const TAP_MOVE_PX = 12;         // more movement than this is a drag, not a tap
const TAP_HOLD_MS = 350;        // a longer press is not a tap

function setupDoubleTapZoom() {
    const mapEl = map.getContainer();
    const isMapSurface = (e) => !e.target.closest?.('.leaflet-marker-icon, .leaflet-control, .leaflet-popup');
    const zoomAt = (e, delta) => {
        lastUserZoomInput = Date.now(); // counts as a user zoom for "Search this area"
        map.setZoomAround(map.mouseEventToContainerPoint(e), map.getZoom() + delta);
    };

    let lastPointerType = 'mouse';
    let press = null;       // the touch currently down
    let lastTap = null;     // { x, y, t } of the previous tap
    let pointersDown = 0;

    mapEl.addEventListener('pointerdown', (e) => {
        lastPointerType = e.pointerType;
        if (e.pointerType === 'mouse') return;
        pointersDown++;
        if (pointersDown > 1) { press = null; lastTap = null; return; } // pinch, not a tap
        press = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false };
    });
    mapEl.addEventListener('pointermove', (e) => {
        if (!press || e.pointerType === 'mouse') return;
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_MOVE_PX) press.moved = true;
    });
    const endPress = (e) => {
        if (e.pointerType === 'mouse') return;
        pointersDown = Math.max(0, pointersDown - 1);
        const p = press;
        press = null;
        if (!p || e.type === 'pointercancel' || p.moved || e.timeStamp - p.t > TAP_HOLD_MS || !isMapSurface(e)) {
            lastTap = null;
            return;
        }
        if (lastTap && e.timeStamp - lastTap.t <= DOUBLE_TAP_MS
            && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= DOUBLE_TAP_SLOP_PX) {
            lastTap = null;
            zoomAt(e, map.options.zoomDelta);
        } else {
            lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
        }
    };
    mapEl.addEventListener('pointerup', endPress);
    mapEl.addEventListener('pointercancel', endPress);

    // Mouse double-click (Shift zooms out). The dblclick some browsers fire after a touch
    // double-tap is ignored: the handler above has already zoomed.
    mapEl.addEventListener('dblclick', (e) => {
        if (lastPointerType !== 'mouse' || !isMapSurface(e)) return;
        e.preventDefault();
        zoomAt(e, e.shiftKey ? -map.options.zoomDelta : map.options.zoomDelta);
    });
}

function initMap() {
    // doubleClickZoom is replaced by setupDoubleTapZoom(), which also handles touch reliably.
    map = L.map('map', { zoomControl: false, doubleClickZoom: false }).setView([39.8283, -98.5795], 4);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    setMapTiles();
    markersLayer = createMarkersLayer().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    addPriceLegend();

    map.on('zoomend', checkZoomLevel);
    map.on('moveend', debounce(updatePinTiers, 80));
    map.on('popupopen', (e) => { popupStore = e.popup._source?.options.store || null; syncUrl(); });
    map.on('popupclose', () => { popupStore = null; syncUrl(); });
    map.on('click', () => {
        if (state.activeMobileStore) closeMobileStoreCard();
    });

    setupInputAutocomplete('searchInput', 'autocompleteDropdown', 'search');
    setupMobileSheetGestures();
    setupSheetDrag();
    setSheetState('peek');
    // Re-fit the sheet when the card's height changes (gas hours expanded, re-render, fonts).
    const detailContent = document.getElementById('sheetDetailContent');
    if (detailContent && typeof ResizeObserver === 'function') {
        new ResizeObserver(() => { if (isPhoneViewport() && state.activeMobileStore) syncSheetA11y(); })
            .observe(detailContent);
    }
    setupMapAreaSearch();
    setupDoubleTapZoom();

    window.addEventListener('resize', debounce(() => {
        if (!isMobileViewport() && state.activeMobileStore) {
            closeMobileStoreCard();
        } else if (isMobileViewport()) {
            map.closePopup();
        }
        if (state.activeMobileStore && isPhoneViewport() !== (document.getElementById('sheetDetail')?.hidden === false)) {
            closeMobileStoreCard(); // details live in a different container on this tier
        }
        syncSheetA11y();
        syncSidebarToggle();
        map.invalidateSize();
    }, 150));
}

// --- Clustering & price-coloured pins ---

// Below PIN_ZOOM nearby stations merge into a bubble showing how many there are and the
// cheapest price among them. Falls back to plain markers if the plugin failed to load.
function createMarkersLayer() {
    if (!state.clusterMarkers || typeof L.markerClusterGroup !== 'function') return L.layerGroup();
    return L.markerClusterGroup({
        disableClusteringAtZoom: PIN_ZOOM,
        maxClusterRadius: 56,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: false,
        animate: !prefersReducedMotion(),
        iconCreateFunction: (cluster) => {
            const children = cluster.getAllChildMarkers();
            const prices = children.map(m => m.options.price).filter(Number.isFinite);
            const from = prices.length ? `<span class="cluster-price">${formatPriceDisplay(Math.min(...prices))}+</span>` : '';
            const size = children.length >= 100 ? 58 : children.length >= 10 ? 52 : 46;
            const label = `${children.length} stations${prices.length ? `, from ${formatPriceDisplay(Math.min(...prices))}` : ''}`;
            return L.divIcon({
                className: 'station-cluster',
                html: `<div class="cluster-bubble" style="--size:${size}px" title="${label}. Click to zoom in."><span class="cluster-count">${children.length}</span>${from}</div>`,
                iconSize: [size, size]
            });
        }
    });
}

// Swap between clustered and plain pins, keeping whatever the map is showing.
function rebuildMarkersLayer() {
    if (!map) return;
    const reopen = popupStore;
    map.closePopup();
    map.removeLayer(markersLayer);
    markersLayer = createMarkersLayer().addTo(map);
    if (state.stores.length > 0) renderMap(currentMapData());
    if (reopen?.leafletMarker && !isMobileViewport()) reopen.leafletMarker.openPopup();
}

const PRICE_TIERS = ['low', 'mid', 'high', 'flat', 'none'];
const MIN_TIER_SPREAD = 0.03; // dollars; below this every station is effectively the same price

// Colour each pin by where its price sits among the stations currently in view:
// lowest third of the price range green, middle amber, top third red.
function updatePinTiers() {
    if (!map || storeMarkers.length === 0) return;
    const bounds = map.getBounds();
    const inView = storeMarkers.filter(m => Number.isFinite(m.options.price) && bounds.contains(m.getLatLng()));
    const prices = inView.map(m => m.options.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const comparable = state.colorPins && inView.length >= 3 && max - min >= MIN_TIER_SPREAD;
    const inViewSet = new Set(inView);

    storeMarkers.forEach(marker => {
        let tier;
        if (!Number.isFinite(marker.options.price)) tier = 'none';
        else if (!inViewSet.has(marker)) return; // off-screen: recoloured when it comes into view
        else if (!comparable) tier = 'flat';
        else {
            const t = (marker.options.price - min) / (max - min);
            tier = t <= 1 / 3 ? 'low' : t >= 2 / 3 ? 'high' : 'mid';
        }
        setPinTier(marker, tier);
    });

    const legend = document.getElementById('priceLegend');
    if (legend) {
        legend.classList.toggle('no-compare', !comparable);
        legend.querySelector('.legend-title').textContent = comparable
            ? `${GRADE_INFO[state.gasPref].label} in view`
            : `${GRADE_INFO[state.gasPref].label} prices`;
        legend.querySelector('.legend-low').textContent = comparable ? formatPriceDisplay(min) : '';
        legend.querySelector('.legend-high').textContent = comparable ? formatPriceDisplay(max) : '';
    }
}

function setPinTier(marker, tier) {
    if (marker.options.tier === tier) return;
    marker.options.tier = tier;
    // Update the icon definition too: clustering re-creates the element from it.
    marker.options.icon.options.className = `costco-custom-icon price-${tier}`;
    const el = marker.getElement();
    if (el) {
        PRICE_TIERS.forEach(t => el.classList.toggle(`price-${t}`, t === tier));
    }
}

function addPriceLegend() {
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => {
        const div = L.DomUtil.create('div', 'price-legend no-compare'); // shown once prices can be compared
        div.id = 'priceLegend';
        div.setAttribute('aria-label', 'Pin colours: green is the cheapest third of the prices in view, red the most expensive');
        div.innerHTML = `
            <span class="legend-title">Prices in view</span>
            <span class="legend-scale">
                <span class="legend-low"></span>
                <i class="legend-dot price-low"></i><i class="legend-dot price-mid"></i><i class="legend-dot price-high"></i>
                <span class="legend-high"></span>
            </span>`;
        L.DomEvent.disableClickPropagation(div);
        return div;
    };
    legend.addTo(map);
}

function storePopupHtml(store) {
    const currentIsFav = isFavoriteStore(store.state, store.city);
    const where = `data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}"`;

    return `
        <div class="popup-store-name">${escapeHtml(store.city)}, ${escapeHtml(store.state)}</div>
        <div class="popup-address">${escapeHtml(formatAddress(store.address))}</div>
        <div class="popup-meta">
            ${gasStatusHtml(store)}
            ${phoneLinkHtml(store, 13)}
        </div>
        ${gasHoursDetailsHtml(store)}
        <div class="popup-prices-grid">${priceTilesHtml(store, state.gasPref)}</div>
        <div class="popup-actions-row">
            <a href="${escapeHtml(directionsUrl(store, state.directionsApp))}" title="Open in ${DIRECTIONS_APP_LABELS[state.directionsApp]}" target="_blank" rel="noopener noreferrer" class="btn btn-primary popup-btn-directions">${DIRECTIONS_ICON} Directions</a>
            <button type="button" class="btn btn-secondary" data-action="history" ${where}>${icon('chart', 16)} History</button>
        </div>
        <div class="popup-actions-row">
            <a href="${escapeHtml(store.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary popup-btn-wide">Store page ${icon('external', 14)}</a>
            ${favoriteButtonHtml(store, currentIsFav)}
            ${shareButtonHtml(store)}
        </div>
    `;
}

function renderMap(dataArray) {
    if (!markersLayer) return;
    markersLayer.clearLayers();
    storeMarkers = [];
    // Forget the old markers, so code that looks a station up by state/city never gets a
    // marker that is no longer on the map.
    state.stores.forEach(s => { s.leafletMarker = null; });
    // The Route tab passes copies of the stores (with a distance added); the card, the popup
    // and the hover link look stations up in state.stores, so give the originals the marker too.
    const isCopies = dataArray !== state.stores;
    filterStoresForCurrentGrade(dataArray, state.gasPref).forEach(store => {
        if (!store.lat || !store.lng) return;

        const displayPrice = gradeStr(store, state.gasPref);
        const price = hasGradeData(store, state.gasPref) ? gradeVal(store, state.gasPref) : NaN;
        const tier = Number.isFinite(price) ? 'flat' : 'none';
        const isFav = isFavoriteStore(store.state, store.city);
        const favBadge = isFav ? `<div class="pin-favorite-badge" aria-hidden="true">★</div>` : '';

        const dynamicPin = L.divIcon({
            className: `costco-custom-icon price-${tier}`,
            html: `
                <div class="pin">
                    ${favBadge}
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path class="pin-body" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                        <circle class="pin-dot" cx="12" cy="9" r="3.5"/>
                    </svg>
                    <div class="pin-price-badge">${isFav ? '<span class="pin-fav" aria-hidden="true">★</span>' : ''}${escapeHtml(displayPrice) || 'N/A'}</div>
                </div>
            `,
            iconSize: [36, 36],
            iconAnchor: [18, 36],
            popupAnchor: [0, -32]
        });

        const marker = L.marker([store.lat, store.lng], {
            icon: dynamicPin,
            title: `${store.city}, ${store.state}${displayPrice ? ` — ${displayPrice}` : ''}`,
            store, price, tier
        });

        marker.bindPopup(() => storePopupHtml(store));

        const origOpenPopup = marker.openPopup.bind(marker);
        marker.openPopup = function(...args) {
            if (isMobileViewport()) {
                openMobileStoreCard(store);
                map.panTo(sheetAwareCenter(L.latLng(store.lat, store.lng), map.getZoom()), { animate: !prefersReducedMotion() });
                return this;
            }
            // Still inside a cluster: zoom in until the pin exists, then open it.
            if (!this._map && typeof markersLayer.zoomToShowLayer === 'function') {
                markersLayer.zoomToShowLayer(this, () => origOpenPopup(...args));
                return this;
            }
            return origOpenPopup(...args);
        };

        if (window.matchMedia?.('(hover: hover)').matches) {
            marker.on('mouseover', () => linkPinToCard(marker, store, true));
            marker.on('mouseout', () => linkPinToCard(marker, store, false));
        }
        storeMarkers.push(marker);
        store.leafletMarker = marker;
        if (isCopies) {
            const original = findStore(store.state, store.city);
            if (original) original.leafletMarker = marker;
        }
    });

    if (typeof markersLayer.addLayers === 'function') markersLayer.addLayers(storeMarkers);
    else storeMarkers.forEach(m => m.addTo(markersLayer));
    updatePinTiers();
}

// Animated fly-to, or an instant jump when the user prefers reduced motion.
function moveMapTo(latlng, zoom, duration) {
    if (prefersReducedMotion()) {
        map.setView(latlng, zoom, { animate: false });
    } else {
        map.flyTo(latlng, zoom, { duration });
    }
}

function flyToStore(store) {
    if (isMobileViewport()) {
        openMobileStoreCard(store); // first, so the map can centre above the card
        moveMapTo(sheetAwareCenter(L.latLng(store.lat, store.lng), 14), 14, 1.2);
        return;
    }
    // Register first: with reduced motion the move (and its moveend) completes synchronously.
    map.once('moveend', () => store.leafletMarker && store.leafletMarker.openPopup());
    moveMapTo([store.lat, store.lng], 14, 1.5);
}

function flyToGeoResult(result) {
    if (isMobileViewport()) {
        closeMobileStoreCard();
        setMobileView('map');
    }

    const [south, north, west, east] = result.boundingbox.map(parseFloat);

    state.userLocation = { lat: parseFloat(result.lat), lng: parseFloat(result.lon) };

    if (searchLocationMarker) map.removeLayer(searchLocationMarker);
    searchLocationMarker = L.circleMarker([state.userLocation.lat, state.userLocation.lng], {
        radius: 8, fillColor: "#f59e0b", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
    }).addTo(map).bindPopup(`<b>${escapeHtml(result.display_name.split(',')[0])}</b>`);

    // Location and marker are set above, so the tab can render as soon as the move ends
    // (which is immediate when animation is off).
    map.once('moveend', () => switchTab('nearby'));
    const bounds = [[south, west], [north, east]];
    setSearchAreaVisible(false);
    if (prefersReducedMotion()) {
        map.fitBounds(bounds, { animate: false, maxZoom: 13, padding: [40, 40] });
    } else {
        map.flyToBounds(bounds, { duration: 1.5, maxZoom: 13, padding: [40, 40] });
    }
}

// --- Geolocation & Data Loading ---

async function detectUserState() {
    try {
        const res = await fetch('https://ipapi.co/region_code/');
        if (res.ok) {
            const code = await res.text();
            if (code && code.trim().length === 2) state.currentStateContext = code.trim().toUpperCase();
        }
    } catch (e) {}
}


function updateClosestStoreState(loc) {
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

function placeUserLocationMarker(loc, { openPopup = false } = {}) {
    if (userLocationMarker && map) map.removeLayer(userLocationMarker);
    userLocationMarker = L.circleMarker([loc.lat, loc.lng], {
        radius: 8, fillColor: "#3b82f6", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
    }).addTo(map).bindPopup("<b>You are here!</b>");
    if (openPopup && !isMobileViewport()) userLocationMarker.openPopup();
    return userLocationMarker;
}

function renderLoadState() {
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

async function loadData() {
    loadStatus = 'loading';
    renderLoadState();
    const lastUpdatedEl = document.getElementById('lastUpdated');
    if (lastUpdatedEl) lastUpdatedEl.innerText = 'Fetching latest data...';
    try {
        const cb = Date.now();
        const [latestRes, storesRes, _, autoLocation] = await Promise.all([
            fetch(`us_latest.json?t=${cb}`),
            fetch(`us_stores.json?t=${cb}`),
            state.autoLocate ? detectUserState() : null,
            state.autoLocate ? getLocationIfGranted() : null
        ]);

        if (!latestRes.ok || !storesRes.ok) throw new Error('Failed to fetch latest snapshot or store list');

        const latestData = await latestRes.json();
        const storeData = await storesRes.json();

        const latestTimestamp = latestData.timestamp;
        const timestampedPrices = latestData.prices || {};
        const previousPrices = latestData.previous || {};
        const previousTimestamp = latestData.previous_timestamp || null;

        state.trendBaselineLabel = getRelativeTimeLabel(previousTimestamp);
        state.latestTimestamp = latestTimestamp;
        refreshLastUpdatedLabel();
        // Offline, sw.js answers with the last prices it saved; say so.
        if (navigator.onLine === false) {
            showToast(`You're offline. Showing saved prices (${formatLastUpdatedLabel(latestTimestamp).text.toLowerCase()}).`, 5000);
        }

        const loadedStores = [];
        for (const stateCode in storeData) {
            if (!timestampedPrices[stateCode]) continue;
            for (const [cityName, info] of Object.entries(storeData[stateCode])) {
                const pData = timestampedPrices[stateCode][cityName];
                if (!pData) continue;

                const [regVal, premVal, dieselVal] = extractGradePrices(pData).map(getValidPrice);
                const prevData = previousPrices[stateCode]?.[cityName];
                const [prevRegVal, prevPremVal, prevDieselVal] = prevData
                    ? extractGradePrices(prevData).map(getValidPrice)
                    : [undefined, undefined, undefined];

                loadedStores.push({
                    state: stateCode, city: cityName, address: info.address,
                    lat: info.lat, lng: info.lng, url: info.url,
                    gasHours: info.gas_hours || null, tz: info.tz || null, phone: info.phone || null,
                    regularStr: formatPriceDisplay(regVal),
                    premiumStr: formatPriceDisplay(premVal),
                    dieselStr: formatPriceDisplay(dieselVal),
                    regVal, premVal, dieselVal,
                    prevRegVal, prevPremVal, prevDieselVal
                });
            }
        }
        state.stores = loadedStores;
        loadStatus = 'ready';

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
    } catch (error) {
        console.error('Error fetching data:', error);
        loadStatus = 'error';
        renderLoadState();
        if (lastUpdatedEl) lastUpdatedEl.innerText = "Couldn't load prices";
    }
}

// --- Sidebar Views & Store Cards ---

function renderStoresList(searchTerm) {
    const container = document.getElementById("sidebarContent");
    if (!container) return;
    container.innerHTML = "";

    let filtered = state.stores.filter(s => storeMatchesQuery(s, searchTerm));
    filtered = filterStoresForCurrentGrade(filtered, state.gasPref);

    if (map && filtered.length > 0) {
        const center = map.getCenter();
        filtered.sort((a, b) =>
            getDistanceMiles(center.lat, center.lng, a.lat, a.lng) -
            getDistanceMiles(center.lat, center.lng, b.lat, b.lng)
        );
    }

    if (filtered.length === 0) {
        container.innerHTML = `<p class="empty-msg">No stores found.</p>`;
        return;
    }

    const header = document.createElement('div');
    header.className = 'leaderboard-header';
    header.textContent = `${filtered.length} station${filtered.length === 1 ? '' : 's'} · nearest to map centre first`;
    container.appendChild(header);
    appendPagedCards(container, filtered,
        store => createStoreCard(store, { highlight: state.gasPref }),
        { key: `search|${searchTerm}|${state.gasPref}`, pageSize: 20 });
}

function getStoreCount(stateCode) {
    return state.stores.filter(s => s.state === stateCode).length;
}

function renderLowestPrices(stateOverride = null) {
    const container = document.getElementById("sidebarContent");
    if (!container) return;
    container.innerHTML = "";

    const availableStates = [...new Set(state.stores.map(s => s.state))].sort();
    if (availableStates.length === 0) return;

    if (stateOverride && availableStates.includes(stateOverride)) {
        state.currentStateContext = stateOverride;
    } else if (!availableStates.includes(state.currentStateContext)) {
        state.currentStateContext = availableStates[0];
    }

    container.innerHTML = `
        <div class="field state-selector-box">
            <label for="stateLeaderboardSelect">State</label>
            <select id="stateLeaderboardSelect" class="select state-select">
                ${availableStates.map(s => `<option value="${s}" ${s === state.currentStateContext ? 'selected' : ''}>${s} · ${getStoreCount(s)} station${getStoreCount(s) === 1 ? '' : 's'}</option>`).join('')}
            </select>
        </div>
    `;

    const gradeLabel = GRADE_INFO[state.gasPref].label;
    const sortedData = state.stores
        .filter(s => s.state === state.currentStateContext && hasGradeData(s, state.gasPref))
        .sort((a, b) => gradeVal(a, state.gasPref) - gradeVal(b, state.gasPref));

    container.innerHTML += `<div class="leaderboard-header">Cheapest ${gradeLabel} in ${escapeHtml(state.currentStateContext)}</div>`;
    syncUrl(); // the selected state is part of the URL
    if (sortedData.length === 0) {
        container.innerHTML += `<p class="empty-msg">No pricing data found for this state.</p>`;
        return;
    }
    appendPagedCards(container, sortedData,
        (store, index) => createStoreCard(store, { highlight: state.gasPref, index }),
        { key: `lowest|${state.currentStateContext}|${state.gasPref}` });
}

function setNearbyRadius(val) {
    saveNearbyRadius(val);
    renderNearbyPrices();
}

function setNearbySort(val) {
    saveNearbySort(val);
    renderNearbyPrices();
}

function renderNearbyPrices() {
    const container = document.getElementById("sidebarContent");
    if (!container) return;

    if (!state.userLocation) {
        container.innerHTML = emptyStateHtml({
            iconName: 'locate',
            title: 'Find gas near you',
            message: 'Share your location, or search for a city or zip code, to see the cheapest Costco gas nearby.',
            actionHtml: `<button type="button" class="btn btn-primary" data-action="find-me">${icon('locate', 16)} Use my location</button>`
        });
        return;
    }

    const gradeLabel = GRADE_INFO[state.gasPref].label;
    const controlsHtml = `
        <div class="nearby-controls">
            <div class="field nearby-control-group">
                <label for="nearbyRadiusSelect">Radius</label>
                <select id="nearbyRadiusSelect" class="select">
                    ${NEARBY_RADII.map(m => `<option value="${m}" ${m === state.nearbyRadiusMiles ? 'selected' : ''}>${m} mi</option>`).join('')}
                </select>
            </div>
            <div class="field nearby-control-group">
                <label for="nearbySortSelect">Sort by</label>
                <select id="nearbySortSelect" class="select">
                    <option value="price" ${state.nearbySortMode === 'price' ? 'selected' : ''}>Price</option>
                    <option value="distance" ${state.nearbySortMode === 'distance' ? 'selected' : ''}>Distance</option>
                </select>
            </div>
        </div>
    `;

    const nearbyStores = state.stores
        .filter(s => s.lat && s.lng)
        .map(s => ({ ...s, distance: getDistanceMiles(state.userLocation.lat, state.userLocation.lng, s.lat, s.lng) }))
        .filter(s => s.distance <= state.nearbyRadiusMiles);

    if (nearbyStores.length === 0) {
        container.innerHTML = controlsHtml + `<p class="empty-msg">No Costco locations found within ${state.nearbyRadiusMiles} miles.</p>`;
        return;
    }

    const sortedData = nearbyStores
        .filter(s => hasGradeData(s, state.gasPref))
        .sort((a, b) => {
            const valA = gradeVal(a, state.gasPref);
            const valB = gradeVal(b, state.gasPref);
            if (state.nearbySortMode === 'distance') {
                return a.distance !== b.distance ? a.distance - b.distance : valA - valB;
            }
            return valA !== valB ? valA - valB : a.distance - b.distance;
        });

    const headerLabel = state.nearbySortMode === 'distance'
        ? `Closest stations &middot; ${gradeLabel}, within ${state.nearbyRadiusMiles} mi`
        : `Cheapest ${gradeLabel} within ${state.nearbyRadiusMiles} mi`;

    container.innerHTML = controlsHtml + `<div class="leaderboard-header">${headerLabel}</div>`;

    if (sortedData.length === 0) {
        container.innerHTML += `<p class="empty-msg">No stations within ${state.nearbyRadiusMiles} miles have a ${gradeLabel.toLowerCase()} price right now.</p>`;
        return;
    }

    const loc = state.userLocation;
    appendPagedCards(container, sortedData,
        (store, index) => createStoreCard(store, { highlight: state.gasPref, index, showDistance: true }),
        { key: `nearby|${loc.lat},${loc.lng}|${state.nearbyRadiusMiles}|${state.nearbySortMode}|${state.gasPref}` });
}

function renderFavoriteStores() {
    const container = document.getElementById("sidebarContent");
    if (!container) return;
    container.innerHTML = "";

    const favorites = state.stores
        .filter(s => isFavoriteStore(s.state, s.city))
        .sort((a, b) => a.city.localeCompare(b.city));

    if (favorites.length === 0 && state.favoriteRoutes.length === 0) {
        container.innerHTML = emptyStateHtml({
            iconName: 'star',
            title: 'No favorites yet',
            message: 'Tap the star on any station to save it here, or save a route from the Route tab.'
        });
        return;
    }

    if (favorites.length > 0) {
        const header = document.createElement('div');
        header.className = 'leaderboard-header';
        header.textContent = `Favorite stations (${favorites.length})`;
        container.appendChild(header);
        // Inside its own wrapper so "Show more" stays above the saved routes.
        const list = document.createElement('div');
        container.appendChild(list);
        appendPagedCards(list, favorites,
            store => createStoreCard(store, { highlight: state.gasPref }),
            { key: 'favorites' });
    }

    if (state.favoriteRoutes.length > 0) {
        const routesWrap = document.createElement('div');
        routesWrap.innerHTML = renderSavedRoutesHtml({ fromFavorites: true });
        container.appendChild(routesWrap);
    }
}

// --- Tab Navigation ---

const TAB_RENDERERS = {
    search: () => renderStoresList(document.getElementById('searchInput')?.value.toLowerCase().trim() || ''),
    lowest: () => renderLowestPrices(),
    nearby: () => renderNearbyPrices(),
    route: () => renderRoutePanel(),
    favorites: () => renderFavoriteStores()
};

function renderCurrentTab() {
    if (loadStatus !== 'ready') {
        renderLoadState();
        return;
    }
    TAB_RENDERERS[state.currentTab]?.();
}

function refreshCurrentDisplay() {
    switchTab(state.currentTab);
}

// The tab strip scrolls horizontally on narrow phones; keep the active tab in view.
// (Adjusts the strip's own scrollLeft: scrollIntoView() would also scroll the
// overflow:hidden app container when the sidebar is parked off-screen.)
function keepActiveTabVisible(tabName) {
    const strip = document.getElementById('sidebarTabs');
    const tab = document.getElementById(`tab-${tabName}`);
    if (!strip || !tab || strip.scrollWidth <= strip.clientWidth) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) {
        strip.scrollLeft = left;
    } else if (right > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = right - strip.clientWidth;
    }
}

function switchTab(tabName) {
    const previousTab = state.currentTab;
    state.currentTab = tabName;

    Object.keys(TAB_RENDERERS).forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        if (!el) return;
        const isActive = t === tabName;
        el.classList.toggle('active', isActive);
        el.setAttribute('aria-selected', String(isActive));
        el.tabIndex = isActive ? 0 : -1; // roving tabindex: arrow keys move between tabs
    });
    keepActiveTabVisible(tabName);

    if (tabName !== 'route') {
        // Only the Route tab changes which stations the map shows, so the markers need
        // rebuilding only when leaving it (not on every tab render or search keystroke).
        if (previousTab === 'route') {
            clearRouteVisuals();
            if (state.stores.length > 0) renderMap(state.stores);
        }
        state.editingRouteId = null;
        state.editSnapshot = null;
    }

    renderCurrentTab();
    syncUrl();
}

function triggerFindMe() {
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

// --- Keyboard support ---

function setupKeyboardSupport() {
    // Tabs: arrow keys / Home / End move between tabs (automatic activation)
    document.getElementById('sidebarTabs')?.addEventListener('keydown', (e) => {
        const tabNames = [...document.querySelectorAll('#sidebarTabs [data-tab]')].map(el => el.dataset.tab);
        const current = tabNames.indexOf(state.currentTab);
        let next = null;
        if (e.key === 'ArrowRight') next = (current + 1) % tabNames.length;
        else if (e.key === 'ArrowLeft') next = (current - 1 + tabNames.length) % tabNames.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabNames.length - 1;
        if (next === null) return;
        e.preventDefault();
        switchTab(tabNames[next]);
        document.getElementById(`tab-${tabNames[next]}`)?.focus();
    });

    document.addEventListener('keydown', (e) => {
        if (trapSettingsFocus(e) || trapModalFocus(e)) return;

        if (e.key === 'Escape') {
            if (isSettingsOpen()) {
                e.preventDefault();
                closeSettings();
            } else if (isChartModalOpen()) {
                e.preventDefault();
                closeHistory();
            } else if (state.activeMobileStore && !e.target.closest?.('input, select')) {
                closeMobileStoreCard();
            } else if (isPhoneViewport() && state.mobileViewMode !== 'peek' && !e.target.closest?.('input, select')) {
                setSheetState('peek');
                document.getElementById('sheetGrabber')?.focus();
            }
            return;
        }

        // Cards and the sheet handle behave like buttons for Enter / Space.
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.store-card, .mobile-sheet-handle')) {
            e.preventDefault();
            e.target.click();
        }
    });
}

// --- Unified Event Delegation ---

function setupEventListeners() {
    document.addEventListener('click', (e) => {
        // Autocomplete close on outside click
        if (!e.target.closest('.route-input') && !e.target.closest('#searchInput') && !e.target.closest('.autocomplete-dropdown')) {
            closeAutocompleteDropdown();
        }

        // Close modal when clicking backdrop
        if (e.target.id === 'settingsModal') {
            closeSettings();
            return;
        }
        if (e.target.id === 'chartModal') {
            closeHistory();
            return;
        }

        // Tab switching
        const tabEl = e.target.closest('[data-tab]');
        if (tabEl) {
            const tabName = tabEl.dataset.tab;
            if (tabName) {
                switchTab(tabName);
                if (isPhoneViewport() && state.mobileViewMode === 'peek') setSheetState('half');
            }
            return;
        }

        // Gas preference toggle
        const gasEl = e.target.closest('[data-gas-pref]');
        if (gasEl) {
            const grade = gasEl.dataset.gasPref;
            if (grade) setGasPref(grade);
            return;
        }

        // Delegated action buttons
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;

        const action = actionEl.dataset.action;
        const stateCode = actionEl.dataset.state;
        const city = actionEl.dataset.city;

        switch (action) {
            case 'find-me':
                triggerFindMe();
                break;
            case 'open-settings':
                openSettings();
                break;
            case 'close-settings':
                closeSettings();
                break;
            case 'toggle-theme':
                toggleTheme();
                break;
            case 'close-modal':
                closeHistory();
                break;
            case 'retry-load':
                loadData();
                break;
            case 'directions':
                break; // a plain link; listed so the click doesn't also select the card
            case 'close-mobile-sheet':
                closeMobileStoreCard();
                break;
            case 'toggle-sidebar':
                setSidebarCollapsed(!document.getElementById('appContainer').classList.contains('sidebar-collapsed'));
                break;
            case 'search-this-area':
                searchThisArea();
                break;
            case 'history':
                if (stateCode && city) openHistory(stateCode, city);
                break;
            case 'toggle-favorite':
                if (stateCode && city) toggleFavoriteStoreAndRefresh(stateCode, city);
                break;
            case 'share':
                if (stateCode && city) shareStore(stateCode, city, `${city}, ${stateCode}`);
                break;
            case 'fly-to-store':
                if (stateCode && city) {
                    const store = findStore(stateCode, city);
                    if (store) flyToStore(store);
                }
                break;
            case 'set-history-range':
                if (actionEl.dataset.days !== undefined) {
                    setHistoryRange(actionEl.dataset.days);
                }
                break;
            case 'select-autocomplete':
                if (actionEl.dataset.index !== undefined) {
                    selectAutocompleteItem(parseInt(actionEl.dataset.index, 10));
                }
                break;
            case 'route-locate':
                useMyLocationForRoute();
                break;
            case 'route-find':
                findGasAlongRoute();
                break;
            case 'route-save':
                saveCurrentRouteAsFavorite();
                break;
            case 'route-cancel-edit':
                cancelEditRoute();
                break;
            case 'load-favorite-route': {
                const routeId = parseInt(actionEl.dataset.routeId, 10);
                if (routeId) {
                    if (state.currentTab !== 'route') switchTab('route');
                    loadFavoriteRoute(routeId);
                }
                break;
            }
            case 'edit-favorite-route': {
                const routeId = parseInt(actionEl.dataset.routeId, 10);
                if (routeId) {
                    if (state.currentTab !== 'route') switchTab('route');
                    startEditRoute(routeId);
                }
                break;
            }
            case 'delete-favorite-route': {
                const routeId = parseInt(actionEl.dataset.routeId, 10);
                if (routeId) {
                    removeFavoriteRouteHandler(routeId);
                    refreshCurrentDisplay();
                }
                break;
            }
            case 'view-route-map':
                setMobileView('map');
                break;
        }
    });

    const sidebar = document.getElementById('sidebarContent');
    if (sidebar) {
        sidebar.addEventListener('change', (e) => {
            if (e.target.id === 'stateLeaderboardSelect') {
                renderLowestPrices(e.target.value);
            } else if (e.target.id === 'nearbyRadiusSelect') {
                setNearbyRadius(e.target.value);
            } else if (e.target.id === 'nearbySortSelect') {
                setNearbySort(e.target.value);
            }
        });
    }
}

// --- Initialization ---

// A shared link's tab and grade win over the defaults (without overwriting the saved grade).
if (initialUrl.grade) state.gasPref = initialUrl.grade;
state.currentTab = initialUrl.tab || state.defaultTab;

initNav({
    getView: () => {
        const openStore = state.activeMobileStore || popupStore;
        return {
            tab: state.currentTab,
            grade: state.gasPref,
            state: state.currentTab === 'lowest' ? state.currentStateContext : null,
            // Keep ?store= from a shared link until the data has loaded and it can be opened.
            store: openStore ? storeKey(openStore) : sharedStoreKey
        };
    },
    applyOverlay: applyOverlayFromHistory
});

initPreferences();
initSearchPlaceholder();
lockPageZoomOnPhones();
registerServiceWorker();
initMap();

initSearch({
    getMap: () => map,
    onSelectStore: (store) => flyToStore(store),
    onSelectGeo: (result) => flyToGeoResult(result),
    onSearchInput: () => switchTab('search')
});

initRoutes({
    getMap: () => map,
    getRouteLayer: () => routeLayer,
    renderMap: (data) => renderMap(data),
    switchTab: (tab) => switchTab(tab),
    setMobileView: (mode) => setMobileView(mode)
});

setupEventListeners();
setupKeyboardSupport();
setupSettings();
switchTab(state.currentTab); // highlight the tab from the URL while the data loads
loadData();
setInterval(refreshLastUpdatedLabel, 60000);
