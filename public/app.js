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
    getTrendArrow,
    getVisibleStoreGrades,
    gradeVal,
    gradePrevVal,
    gradeStr,
    hasGradeData,
    shouldFilterStoresByGrade,
    gasStatusHtml,
    gasHoursDetailsHtml,
    escapeHtml,
    debounce,
    showToast,
    prefersReducedMotion,
    requestBrowserLocation
} from './js/utils.js';
import {
    state,
    isFavoriteStore,
    toggleFavoriteStore,
    findStore,
    hasExplicitThemePref,
    setGasPref as saveGasPref,
    setDarkMode as saveDarkMode,
    setNearbyRadius as saveNearbyRadius,
    setNearbySort as saveNearbySort
} from './js/state.js';
import {
    createStoreCard,
    renderSavedRoutesHtml,
    renderMobileStoreCardContent
} from './js/components.js';
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

function isMobileViewport() {
    return window.innerWidth <= 768;
}

function setMobileView(mode) {
    state.mobileViewMode = mode === 'list' ? 'list' : 'map';
    const container = document.getElementById('appContainer');
    if (container) {
        container.classList.toggle('mobile-view-list', state.mobileViewMode === 'list');
    }
    [['btnMobileMap', 'map'], ['btnMobileList', 'list']].forEach(([id, mode]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('active', state.mobileViewMode === mode);
        btn.setAttribute('aria-pressed', String(state.mobileViewMode === mode));
    });

    if (state.mobileViewMode === 'list') {
        closeMobileStoreCard();
    }
    if (map) {
        setTimeout(() => map.invalidateSize(), 60);
    }
}

function openMobileStoreCard(store) {
    if (!store) return;
    state.activeMobileStore = store;
    if (state.mobileViewMode !== 'map') {
        setMobileView('map');
    }
    renderMobileStoreCardContent(store);
    const sheet = document.getElementById('mobileStoreSheet');
    const container = document.getElementById('appContainer');
    if (sheet) {
        sheet.classList.add('active');
        sheet.setAttribute('aria-hidden', 'false');
        sheet.removeAttribute('inert');
    }
    if (container) {
        container.classList.add('mobile-sheet-open');
    }
}

function closeMobileStoreCard() {
    state.activeMobileStore = null;
    const sheet = document.getElementById('mobileStoreSheet');
    const container = document.getElementById('appContainer');
    if (sheet) {
        sheet.classList.remove('active');
        sheet.setAttribute('aria-hidden', 'true');
        sheet.setAttribute('inert', '');
    }
    if (container) {
        container.classList.remove('mobile-sheet-open');
    }
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

function toggleFavoriteStoreAndRefresh(stateCode, city) {
    const isNowFav = toggleFavoriteStore(stateCode, city);
    showToast(isNowFav ? '★ Added to favorites' : 'Removed from favorites');

    if (state.stores.length > 0) {
        renderMap(
            state.currentTab === 'route' && state.lastRouteState?.along?.length > 0
                ? state.lastRouteState.along
                : state.stores
        );
    }
    refreshCurrentDisplay();

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
    const params = new URLSearchParams(window.location.search);
    const storeKey = params.get('store');
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
    if (themeBtn) {
        themeBtn.innerText = isDark ? '☀️' : '🌙';
        themeBtn.setAttribute('aria-pressed', String(isDark));
    }
}

// On narrow phones the search box shares its row with the grade toggle, so the
// full placeholder is cut off ("Search city or z…"). Use a short one there.
const SEARCH_PLACEHOLDER_FULL = 'Search city or zip code...';
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
    GRADE_KEYS.forEach(g => document.getElementById(`btn-${g}`)?.classList.remove('active'));
    document.getElementById(`btn-${state.gasPref}`)?.classList.add('active');
}

function toggleTheme() {
    const newTheme = !state.isDarkMode;
    saveDarkMode(newTheme);
    applyTheme(newTheme);
    setMapTiles();
    refreshChartTheme();
}

function setGasPref(pref) {
    saveGasPref(pref);

    GRADE_KEYS.forEach(g => document.getElementById(`btn-${g}`)?.classList.remove('active'));
    document.getElementById(`btn-${pref}`)?.classList.add('active');

    if (state.stores.length > 0) {
        renderMap(state.stores);
    }
    refreshCurrentDisplay();

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
    if (mapEl) mapEl.classList.toggle('map-show-prices', map.getZoom() >= 9);
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

function initMap() {
    map = L.map('map', { zoomControl: false }).setView([39.8283, -98.5795], 4);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    setMapTiles();
    markersLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);

    map.on('zoomend', checkZoomLevel);
    map.on('click', () => {
        if (state.activeMobileStore) closeMobileStoreCard();
    });

    setupInputAutocomplete('searchInput', 'autocompleteDropdown', 'search');
    setupMobileSheetGestures();

    window.addEventListener('resize', debounce(() => {
        if (!isMobileViewport() && state.activeMobileStore) {
            closeMobileStoreCard();
        } else if (isMobileViewport()) {
            map.closePopup();
        }
        map.invalidateSize();
    }, 150));
}

function renderMap(dataArray) {
    if (!markersLayer) return;
    markersLayer.clearLayers();
    filterStoresForCurrentGrade(dataArray, state.gasPref).forEach(store => {
        if (!store.lat || !store.lng) return;

        const displayPrice = gradeStr(store, state.gasPref);
        const isFav = isFavoriteStore(store.state, store.city);
        const favBadge = isFav ? `<div class="pin-favorite-badge">★</div>` : '';

        const dynamicPin = L.divIcon({
            className: 'costco-custom-icon',
            html: `
                <div style="position:relative;">
                    ${favBadge}
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#E31837" stroke="#ffffff" stroke-width="2"/>
                        <circle cx="12" cy="9" r="3.5" fill="#ffffff"/>
                    </svg>
                    <div class="pin-price-badge grade-${state.gasPref}">
                        ${escapeHtml(displayPrice) || 'N/A'}
                    </div>
                </div>
            `,
            iconSize: [36, 36],
            iconAnchor: [18, 36],
            popupAnchor: [0, -32]
        });

        const marker = L.marker([store.lat, store.lng], { icon: dynamicPin });

        marker.bindPopup(() => {
            const currentIsFav = isFavoriteStore(store.state, store.city);
            const priceBoxesHtml = getVisibleStoreGrades(store).map(g => {
                const cls = state.gasPref === g ? 'highlight' : '';
                const trend = getTrendArrow(gradeVal(store, g), gradePrevVal(store, g), state.trendBaselineLabel);
                return `<div class="popup-price-box ${cls}"><span>${GRADE_INFO[g].label}</span><strong>${escapeHtml(gradeStr(store, g)) || 'N/A'} ${trend}</strong></div>`;
            }).join('');

            return `
                <div class="popup-store-name">${escapeHtml(store.city)}, ${escapeHtml(store.state)}</div>
                <div class="popup-address">${escapeHtml(store.address)}</div>
                ${gasStatusHtml(store)}
                ${gasHoursDetailsHtml(store)}
                ${store.phone ? `<div class="popup-phone"><a href="tel:${escapeHtml(store.phone.replace(/[^0-9+]/g, ''))}">${escapeHtml(store.phone)}</a></div>` : ''}
                <div class="popup-prices-grid">${priceBoxesHtml}</div>
                <button type="button" class="popup-btn" data-action="history" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}">📈 Price History</button>
                <div class="popup-actions-row">
                    <a href="${escapeHtml(store.url)}" target="_blank" rel="noopener noreferrer" class="popup-btn popup-btn-outline" style="flex:1;">Store Page ↗</a>
                    <button type="button" class="popup-btn popup-btn-outline popup-btn-icon ${currentIsFav ? 'active' : ''}" data-action="toggle-favorite" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}" title="${currentIsFav ? 'Remove Favorite' : 'Add to Favorites'}">${currentIsFav ? '★' : '☆'}</button>
                    <button type="button" class="popup-btn popup-btn-outline popup-btn-icon" data-action="share" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}" title="Share This Station">🔗</button>
                </div>
            `;
        });

        const origOpenPopup = marker.openPopup.bind(marker);
        marker.openPopup = function(...args) {
            if (isMobileViewport()) {
                openMobileStoreCard(store);
                map.panTo([store.lat, store.lng], { animate: !prefersReducedMotion() });
                return this;
            }
            return origOpenPopup(...args);
        };

        marker.addTo(markersLayer);
        store.leafletMarker = marker;
    });
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
        setMobileView('map');
        moveMapTo([store.lat, store.lng], 14, 1.2);
        openMobileStoreCard(store);
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

async function tryAutoLocateOnLoad() {
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
            { maximumAge: 10 * 60 * 1000, timeout: 5000 }
        );
    });
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

async function loadData() {
    try {
        const cb = Date.now();
        const [latestRes, storesRes, _, autoLocation] = await Promise.all([
            fetch(`us_latest.json?t=${cb}`),
            fetch(`us_stores.json?t=${cb}`),
            detectUserState(),
            tryAutoLocateOnLoad()
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

        renderMap(state.stores);

        if (autoLocation) {
            state.userLocation = autoLocation;
            updateClosestStoreState(autoLocation);
            placeUserLocationMarker(autoLocation);
        }

        switchTab('nearby');

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
        const container = document.getElementById("sidebarContent");
        if (container) {
            container.innerHTML = `<p class="empty-msg" style="color:var(--costco-red);">Error Loading Data.</p>`;
        }
    }
}

// --- Sidebar Views & Store Cards ---

function renderStoresList(searchTerm) {
    const container = document.getElementById("sidebarContent");
    if (!container) return;
    container.innerHTML = "";

    let filtered = state.stores.filter(s =>
        s.city.toLowerCase().includes(searchTerm) ||
        s.address.toLowerCase().includes(searchTerm) ||
        s.state.toLowerCase().includes(searchTerm)
    );
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

    filtered.forEach(store => container.appendChild(createStoreCard(store, { highlight: state.gasPref })));
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
        <div class="state-selector-box">
            <label>State Leaderboard:</label>
            <select id="stateLeaderboardSelect" class="state-select">
                ${availableStates.map(s => `<option value="${s}" ${s === state.currentStateContext ? 'selected' : ''}>${s} - ${getStoreCount(s)} stores</option>`).join('')}
            </select>
        </div>
    `;

    const gradeLabel = GRADE_INFO[state.gasPref].label;
    const sortedData = state.stores
        .filter(s => s.state === state.currentStateContext && hasGradeData(s, state.gasPref))
        .sort((a, b) => gradeVal(a, state.gasPref) - gradeVal(b, state.gasPref))
        .slice(0, 10);

    container.innerHTML += `<div class="leaderboard-header">Top 10 Cheapest ${gradeLabel}</div>`;
    if (sortedData.length === 0) {
        container.innerHTML += `<p class="empty-msg" style="font-size:13px;">No pricing data found for this state.</p>`;
        return;
    }
    sortedData.forEach((store, index) => container.appendChild(createStoreCard(store, { highlight: state.gasPref, index })));
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
        container.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--costco-blue)" stroke-width="2" style="margin-bottom:15px;">
                    <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
                </svg>
                <h3 style="margin-bottom: 5px;">Find Local Gas</h3>
                <p style="color:var(--text-muted); font-size:14px; padding: 0 10px;">We need your location to find the cheapest Costco gas near you.</p>
                <button type="button" class="btn-action" data-action="find-me" style="margin:15px auto 0;">📍 Detect Location</button>
            </div>
        `;
        return;
    }

    const gradeLabel = GRADE_INFO[state.gasPref].label;
    const controlsHtml = `
        <div class="nearby-controls">
            <div class="nearby-control-group">
                <label>Radius</label>
                <select id="nearbyRadiusSelect">
                    ${[5, 10, 25, 50, 100].map(m => `<option value="${m}" ${m === state.nearbyRadiusMiles ? 'selected' : ''}>${m} mi</option>`).join('')}
                </select>
            </div>
            <div class="nearby-control-group">
                <label>Sort by</label>
                <select id="nearbySortSelect">
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
        })
        .slice(0, 10);

    const headerLabel = state.nearbySortMode === 'distance'
        ? `Closest Stations &middot; ${gradeLabel} (Within ${state.nearbyRadiusMiles} Miles)`
        : `Cheapest ${gradeLabel} (Within ${state.nearbyRadiusMiles} Miles)`;

    container.innerHTML = controlsHtml + `<div class="leaderboard-header">${headerLabel}</div>`;

    if (sortedData.length === 0) {
        container.innerHTML += `<p class="empty-msg" style="margin-top:20px;">No stations within ${state.nearbyRadiusMiles} miles have a ${gradeLabel.toLowerCase()} price right now.</p>`;
        return;
    }

    sortedData.forEach((store, index) => container.appendChild(createStoreCard(store, {
        highlight: state.gasPref,
        index,
        showDistance: true
    })));
}

function renderFavoriteStores() {
    const container = document.getElementById("sidebarContent");
    if (!container) return;
    container.innerHTML = "";

    const favorites = state.stores
        .filter(s => isFavoriteStore(s.state, s.city))
        .sort((a, b) => a.city.localeCompare(b.city));

    if (favorites.length === 0 && state.favoriteRoutes.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div style="font-size:40px; margin-bottom:10px;">☆</div>
                <h3 style="margin-bottom: 5px;">No Favorites Yet</h3>
                <p style="color:var(--text-muted); font-size:14px; padding: 0 10px;">Tap the ☆ on any store card or map popup to save it here, or save a route from the Route tab.</p>
            </div>
        `;
        return;
    }

    if (favorites.length > 0) {
        const header = document.createElement('div');
        header.className = 'leaderboard-header';
        header.textContent = `★ Favorite Stores (${favorites.length})`;
        container.appendChild(header);
        favorites.forEach(store => container.appendChild(createStoreCard(store, { highlight: state.gasPref })));
    }

    if (state.favoriteRoutes.length > 0) {
        const routesWrap = document.createElement('div');
        routesWrap.style.marginTop = favorites.length > 0 ? '16px' : '0';
        routesWrap.innerHTML = renderSavedRoutesHtml({ fromFavorites: true });
        container.appendChild(routesWrap);
    }
}

// --- Tab Navigation ---

const TAB_RENDERERS = {
    search: () => renderStoresList(document.getElementById('searchInput')?.value.toLowerCase() || ''),
    lowest: () => renderLowestPrices(),
    nearby: () => renderNearbyPrices(),
    route: () => renderRoutePanel(),
    favorites: () => renderFavoriteStores()
};

function renderCurrentTab() {
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
        clearRouteVisuals();
        if (state.stores.length > 0) renderMap(state.stores);
        state.editingRouteId = null;
        state.editSnapshot = null;
    }

    renderCurrentTab();
}

function triggerFindMe() {
    requestBrowserLocation((position) => {
        state.userLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
        closeMobileStoreCard();
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
        if (trapModalFocus(e)) return;

        if (e.key === 'Escape') {
            if (isChartModalOpen()) {
                e.preventDefault();
                closeHistoryModal();
            } else if (state.activeMobileStore && !e.target.closest?.('input, select')) {
                closeMobileStoreCard();
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
        if (e.target.id === 'chartModal') {
            closeHistoryModal();
            return;
        }

        // Tab switching
        const tabEl = e.target.closest('[data-tab]');
        if (tabEl) {
            const tabName = tabEl.dataset.tab;
            if (tabName) switchTab(tabName);
            return;
        }

        // Gas preference toggle
        const gasEl = e.target.closest('[data-gas-pref]');
        if (gasEl) {
            const grade = gasEl.dataset.gasPref;
            if (grade) setGasPref(grade);
            return;
        }

        // Mobile view toggle (Map vs List)
        const viewEl = e.target.closest('[data-mobile-view]');
        if (viewEl) {
            const mode = viewEl.dataset.mobileView;
            if (mode) setMobileView(mode);
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
            case 'toggle-theme':
                toggleTheme();
                break;
            case 'close-modal':
                closeHistoryModal();
                break;
            case 'close-mobile-sheet':
                closeMobileStoreCard();
                break;
            case 'history':
                if (stateCode && city) openHistoryModal(stateCode, city);
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

initPreferences();
initSearchPlaceholder();
initMap();

initSearch({
    getMap: () => map,
    onSelectStore: (store) => flyToStore(store),
    onSelectGeo: (result) => flyToGeoResult(result),
    onSearchInput: (query) => {
        switchTab('search');
        renderStoresList(query);
    }
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
loadData();
setInterval(refreshLastUpdatedLabel, 60000);
