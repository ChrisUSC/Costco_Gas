// --- Main Application State, Map, Sidebar Views & Initialization ---

let map;
let mapTileLayer;
let markersLayer;
let globalStoreData = [];
let trendBaselineLabel = 'the last update';
let latestTimestampGlobal = null;

let currentStateContext = 'CA';
let userLocation = null;
let userLocationMarker = null;
let searchLocationMarker = null;
let currentTab = 'nearby';

// Mobile View & Bottom Sheet State
let mobileViewMode = 'map'; // 'map' | 'list'
let activeMobileStore = null;

// User Preferences State
let isDarkMode = localStorage.getItem('theme') === 'dark';
let gasPref = localStorage.getItem('gasPref') || 'regular';
let nearbyRadiusMiles = parseFloat(localStorage.getItem('nearbyRadius')) || 50;
let nearbySortMode = localStorage.getItem('nearbySort') || 'price'; // 'price' | 'distance'

let favoriteStoreKeys = new Set(loadJsonPref('favoriteStores', []));
let favoriteRoutes = loadJsonPref('favoriteRoutes', []);

function isMobileViewport() {
    return window.innerWidth <= 768;
}

function setMobileView(mode) {
    mobileViewMode = mode === 'list' ? 'list' : 'map';
    const container = document.getElementById('appContainer');
    if (container) {
        container.classList.toggle('mobile-view-list', mobileViewMode === 'list');
    }
    document.getElementById('btnMobileMap')?.classList.toggle('active', mobileViewMode === 'map');
    document.getElementById('btnMobileList')?.classList.toggle('active', mobileViewMode === 'list');

    if (mobileViewMode === 'list') {
        closeMobileStoreCard();
    }
    if (map) {
        setTimeout(() => map.invalidateSize(), 60);
    }
}

function renderMobileStoreCardContent(store) {
    const contentEl = document.getElementById('mobileStoreSheetContent');
    if (!contentEl || !store) return;

    const safeCity = store.city.replace(/'/g, "\\'");
    const isFav = isFavoriteStore(store.state, store.city);
    const priceTagsHtml = getVisibleStoreGrades(store).map(g => {
        const cls = gasPref === g ? 'highlight' : '';
        const trend = getTrendArrow(gradeVal(store, g), gradePrevVal(store, g));
        return `
            <div class="price-tag ${cls}">
                <span>${GRADE_INFO[g].label}</span>
                <span class="val">${gradeStr(store, g) || 'N/A'} ${trend}</span>
            </div>`;
    }).join('');

    const phoneHtml = store.phone
        ? `<div class="popup-phone"><a href="tel:${store.phone.replace(/[^0-9+]/g, '')}">📞 ${escapeHtml(store.phone)}</a></div>`
        : '';

    contentEl.innerHTML = `
        <div class="mobile-sheet-header">
            <h3 class="mobile-sheet-title">${escapeHtml(store.city)}, ${escapeHtml(store.state)}</h3>
            <button type="button" class="mobile-sheet-close" onclick="closeMobileStoreCard()" aria-label="Close store details">×</button>
        </div>
        <div class="mobile-sheet-address">${escapeHtml(store.address)}</div>
        <div class="mobile-sheet-meta">
            ${gasStatusHtml(store)}
            ${phoneHtml}
        </div>
        ${gasHoursDetailsHtml(store)}
        <div class="mobile-sheet-prices">${priceTagsHtml}</div>
        <div class="mobile-sheet-actions">
            <button type="button" class="btn-action btn-history" onclick="openHistoryModal('${store.state}', '${safeCity}')">
                📈 History
            </button>
            <a href="${store.url}" target="_blank" rel="noopener noreferrer" class="btn-action btn-outline-blue btn-store-link">
                Store Page ↗
            </a>
            <button type="button" class="btn-action favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
                onclick="toggleFavoriteStore('${store.state}', '${safeCity}')">
                ${isFav ? '★' : '☆'}
            </button>
            <button type="button" class="btn-action share-btn" title="Share this station"
                onclick="shareStore('${store.state}', '${safeCity}', '${safeCity}, ${store.state}')">
                🔗
            </button>
        </div>
    `;
}

function openMobileStoreCard(store) {
    if (!store) return;
    activeMobileStore = store;
    if (mobileViewMode !== 'map') {
        setMobileView('map');
    }
    renderMobileStoreCardContent(store);
    const sheet = document.getElementById('mobileStoreSheet');
    const container = document.getElementById('appContainer');
    if (sheet) {
        sheet.classList.add('active');
        sheet.setAttribute('aria-hidden', 'false');
    }
    if (container) {
        container.classList.add('mobile-sheet-open');
    }
}

function closeMobileStoreCard() {
    activeMobileStore = null;
    const sheet = document.getElementById('mobileStoreSheet');
    const container = document.getElementById('appContainer');
    if (sheet) {
        sheet.classList.remove('active');
        sheet.setAttribute('aria-hidden', 'true');
    }
    if (container) {
        container.classList.remove('mobile-sheet-open');
    }
}

function refreshLastUpdatedLabel() {
    const el = document.getElementById('lastUpdated');
    if (!el || !latestTimestampGlobal) return;
    const { text, title } = formatLastUpdatedLabel(latestTimestampGlobal);
    el.innerText = text;
    el.title = title;
}

// --- Shareable Store Links & Favorites ---

function getShareUrl(state, city) {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('store', `${state}_${city}`);
    return url.toString();
}

function favoriteKey(state, city) {
    return `${state}_${city}`;
}

function isFavoriteStore(state, city) {
    return favoriteStoreKeys.has(favoriteKey(state, city));
}

function toggleFavoriteStore(state, city) {
    const key = favoriteKey(state, city);
    if (favoriteStoreKeys.has(key)) {
        favoriteStoreKeys.delete(key);
        showToast('Removed from favorites');
    } else {
        favoriteStoreKeys.add(key);
        showToast('★ Added to favorites');
    }
    localStorage.setItem('favoriteStores', JSON.stringify([...favoriteStoreKeys]));

    if (globalStoreData.length > 0) {
        renderMap(
            currentTab === 'route' && lastRouteState?.along?.length > 0
                ? lastRouteState.along
                : globalStoreData
        );
    }
    refreshCurrentDisplay();

    if (activeMobileStore && activeMobileStore.state === state && activeMobileStore.city === city) {
        renderMobileStoreCardContent(activeMobileStore);
    }
}

async function shareStore(state, city, label) {
    const url = getShareUrl(state, city);

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
        window.prompt('Copy this link:', url);
    }
}

function openSharedStoreIfPresent() {
    const params = new URLSearchParams(window.location.search);
    const storeKey = params.get('store');
    if (!storeKey) return false;

    const sepIndex = storeKey.indexOf('_');
    if (sepIndex === -1) return false;
    const state = storeKey.slice(0, sepIndex);
    const city = storeKey.slice(sepIndex + 1);

    const store = globalStoreData.find(s => s.state === state && s.city === city);
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

function initPreferences() {
    if (isDarkMode) {
        document.body.classList.add('dark-mode');
        document.getElementById('themeToggle').innerText = '☀️';
    }
    GRADE_KEYS.forEach(g => document.getElementById(`btn-${g}`)?.classList.remove('active'));
    document.getElementById(`btn-${gasPref}`)?.classList.add('active');
}

function toggleTheme() {
    isDarkMode = document.body.classList.toggle('dark-mode');
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    document.getElementById('themeToggle').innerText = isDarkMode ? '☀️' : '🌙';
    setMapTiles();

    if (document.getElementById('chartModal').classList.contains('active') && currentModalState && currentModalCity) {
        renderPriceChart(currentModalState, currentModalCity);
    }
}

function setGasPref(pref) {
    gasPref = pref;
    localStorage.setItem('gasPref', pref);

    GRADE_KEYS.forEach(g => document.getElementById(`btn-${g}`)?.classList.remove('active'));
    document.getElementById(`btn-${pref}`)?.classList.add('active');

    if (globalStoreData.length > 0) {
        renderMap(globalStoreData);
    }
    refreshCurrentDisplay();

    if (activeMobileStore) {
        if (shouldFilterStoresByGrade(gasPref) && !hasGradeData(activeMobileStore, gasPref)) {
            closeMobileStoreCard();
        } else {
            renderMobileStoreCardContent(activeMobileStore);
        }
    }
}

// --- Map Logic ---

function setMapTiles() {
    if (mapTileLayer) map.removeLayer(mapTileLayer);
    const style = isDarkMode ? 'dark_all' : 'rastertiles/voyager';
    mapTileLayer = L.tileLayer(
        `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`,
        {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        }
    ).addTo(map);
}

function checkZoomLevel() {
    document.getElementById('map').classList.toggle('map-show-prices', map.getZoom() >= 9);
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
        if (activeMobileStore) closeMobileStoreCard();
    });

    setupInputAutocomplete('searchInput', 'autocompleteDropdown', 'search');
    setupMobileSheetGestures();

    window.addEventListener('resize', debounce(() => {
        if (!isMobileViewport() && activeMobileStore) {
            closeMobileStoreCard();
        } else if (isMobileViewport()) {
            map.closePopup();
        }
        map.invalidateSize();
    }, 150));

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.route-input') && !e.target.closest('#searchInput') && !e.target.closest('.autocomplete-dropdown')) {
            closeAutocompleteDropdown();
        }
    });
}

function renderMap(dataArray) {
    markersLayer.clearLayers();
    filterStoresForCurrentGrade(dataArray).forEach(store => {
        if (!store.lat || !store.lng) return;

        const displayPrice = gradeStr(store, gasPref);
        const priceColor = GRADE_INFO[gasPref].color;
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
                    <div class="pin-price-badge" style="color: ${priceColor}; border-color: ${priceColor};">
                        ${displayPrice || 'N/A'}
                    </div>
                </div>
            `,
            iconSize: [36, 36],
            iconAnchor: [18, 36],
            popupAnchor: [0, -32]
        });

        const marker = L.marker([store.lat, store.lng], { icon: dynamicPin });
        const safeCity = store.city.replace(/'/g, "\\'");

        marker.bindPopup(() => {
            const currentIsFav = isFavoriteStore(store.state, store.city);
            const priceBoxesHtml = getVisibleStoreGrades(store).map(g => {
                const cls = gasPref === g ? 'highlight' : '';
                const trend = getTrendArrow(gradeVal(store, g), gradePrevVal(store, g));
                return `<div class="popup-price-box ${cls}"><span>${GRADE_INFO[g].label}</span><strong>${gradeStr(store, g) || 'N/A'} ${trend}</strong></div>`;
            }).join('');

            return `
                <div class="popup-store-name">${store.city}, ${store.state}</div>
                <div class="popup-address">${store.address}</div>
                ${gasStatusHtml(store)}
                ${gasHoursDetailsHtml(store)}
                ${store.phone ? `<div class="popup-phone"><a href="tel:${store.phone.replace(/[^0-9+]/g, '')}">${escapeHtml(store.phone)}</a></div>` : ''}
                <div class="popup-prices-grid">${priceBoxesHtml}</div>
                <button class="popup-btn" onclick="openHistoryModal('${store.state}', '${safeCity}')">📈 Price History</button>
                <div class="popup-actions-row">
                    <a href="${store.url}" target="_blank" rel="noopener noreferrer" class="popup-btn popup-btn-outline" style="flex:1;">Store Page ↗</a>
                    <button class="popup-btn popup-btn-outline popup-btn-icon ${currentIsFav ? 'active' : ''}" title="${currentIsFav ? 'Remove Favorite' : 'Add to Favorites'}" onclick="toggleFavoriteStore('${store.state}', '${safeCity}')">${currentIsFav ? '★' : '☆'}</button>
                    <button class="popup-btn popup-btn-outline popup-btn-icon" title="Share This Station" onclick="shareStore('${store.state}', '${safeCity}', '${safeCity}, ${store.state}')">🔗</button>
                </div>
            `;
        });

        const origOpenPopup = marker.openPopup.bind(marker);
        marker.openPopup = function(...args) {
            if (isMobileViewport()) {
                openMobileStoreCard(store);
                map.panTo([store.lat, store.lng], { animate: true });
                return this;
            }
            return origOpenPopup(...args);
        };

        marker.addTo(markersLayer);
        store.leafletMarker = marker;
    });
}

// --- Geolocation & Data Loading ---

async function detectUserState() {
    try {
        const res = await fetch('https://ipapi.co/region_code/');
        if (res.ok) {
            const code = await res.text();
            if (code && code.length === 2) currentStateContext = code.toUpperCase();
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
    if (!loc || globalStoreData.length === 0) return;
    let closestStore = globalStoreData.find(s => s.lat && s.lng) || globalStoreData[0];
    let minDistance = Infinity;
    globalStoreData.forEach(s => {
        if (!s.lat || !s.lng) return;
        const distance = (s.lat - loc.lat) ** 2 + (s.lng - loc.lng) ** 2;
        if (distance < minDistance) {
            minDistance = distance;
            closestStore = s;
        }
    });
    currentStateContext = closestStore.state;
}

function placeUserLocationMarker(loc, { openPopup = false } = {}) {
    if (userLocationMarker) map.removeLayer(userLocationMarker);
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

        let latestTimestamp;
        let timestampedPrices;
        let previousPrices = {};
        let previousTimestamp = null;

        if (latestData.timestamp && latestData.prices) {
            latestTimestamp = latestData.timestamp;
            timestampedPrices = latestData.prices;
            previousPrices = latestData.previous || {};
            previousTimestamp = latestData.previous_timestamp || null;
        } else {
            latestTimestamp = Object.keys(latestData)[0];
            timestampedPrices = latestData[latestTimestamp] || {};
        }

        trendBaselineLabel = getRelativeTimeLabel(previousTimestamp);
        latestTimestampGlobal = latestTimestamp;
        refreshLastUpdatedLabel();

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

                globalStoreData.push({
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

        renderMap(globalStoreData);

        if (autoLocation) {
            userLocation = autoLocation;
            updateClosestStoreState(autoLocation);
            placeUserLocationMarker(autoLocation);
        }

        switchTab('nearby');

        if (!openSharedStoreIfPresent()) {
            if (autoLocation) {
                map.setView([autoLocation.lat, autoLocation.lng], 10);
                checkZoomLevel();
            } else if (globalStoreData.length > 0) {
                const bounds = L.latLngBounds(globalStoreData.map(s => [s.lat, s.lng]).filter(c => c[0] && c[1]));
                map.fitBounds(bounds, { padding: [30, 30] });
                checkZoomLevel();
            }
        }
    } catch (error) {
        console.error('Error fetching data:', error);
        document.getElementById("sidebarContent").innerHTML = `<p class="empty-msg" style="color:var(--costco-red);">Error Loading Data.</p>`;
    }
}

// --- Sidebar Views & Store Cards ---

function createStoreCard(store, highlight = null, index = null, showDistance = false, distanceSuffix = '') {
    const div = document.createElement('div');
    div.className = 'store-card';

    let badgeHtml = '';
    if (showDistance && store.distance !== undefined) {
        badgeHtml = `<span class="distance-badge">${store.distance.toFixed(1)} mi${distanceSuffix}</span>`;
    } else if (index !== null) {
        badgeHtml = `<span class="medal">${getMedal(index)}</span>`;
    }

    const safeCity = store.city.replace(/'/g, "\\'");
    const isFav = isFavoriteStore(store.state, store.city);
    const priceTagsHtml = getVisibleStoreGrades(store).map(g => {
        const cls = highlight === g ? 'highlight' : '';
        const trend = getTrendArrow(gradeVal(store, g), gradePrevVal(store, g));
        return `
            <div class="price-tag ${cls}">
                <span>${GRADE_INFO[g].label}</span><span class="val">${gradeStr(store, g) || 'N/A'} ${trend}</span>
            </div>`;
    }).join('');

    div.innerHTML = `
        <h3><span>${store.city}, ${store.state}</span> ${badgeHtml}</h3>
        <div class="address">${store.address}</div>
        ${gasStatusHtml(store)}
        <div class="prices">${priceTagsHtml}</div>
        <div class="card-actions">
            <button class="btn-action btn-outline-blue" onclick="event.stopPropagation(); openHistoryModal('${store.state}', '${safeCity}')">
                📈 History
            </button>
            <button class="btn-action favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
                onclick="event.stopPropagation(); toggleFavoriteStore('${store.state}', '${safeCity}')">
                ${isFav ? '★' : '☆'}
            </button>
            <button class="btn-action share-btn" title="Share this station"
                onclick="event.stopPropagation(); shareStore('${store.state}', '${safeCity}', '${safeCity}, ${store.state}')">
                🔗
            </button>
        </div>
    `;

    div.onclick = () => flyToStore(store);
    return div;
}

function renderStoresList(searchTerm) {
    const container = document.getElementById("sidebarContent");
    container.innerHTML = "";

    let filtered = globalStoreData.filter(s =>
        s.city.toLowerCase().includes(searchTerm) ||
        s.address.toLowerCase().includes(searchTerm) ||
        s.state.toLowerCase().includes(searchTerm)
    );
    filtered = filterStoresForCurrentGrade(filtered);

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

    filtered.forEach(store => container.appendChild(createStoreCard(store, gasPref)));
}

function getStoreCount(stateCode) {
    return globalStoreData.filter(s => s.state === stateCode).length;
}

function renderLowestPrices(stateOverride = null) {
    const container = document.getElementById("sidebarContent");
    container.innerHTML = "";

    const availableStates = [...new Set(globalStoreData.map(s => s.state))].sort();
    if (availableStates.length === 0) return;

    if (stateOverride && availableStates.includes(stateOverride)) {
        currentStateContext = stateOverride;
    } else if (!availableStates.includes(currentStateContext)) {
        currentStateContext = availableStates[0];
    }

    container.innerHTML = `
        <div class="state-selector-box">
            <label>State Leaderboard:</label>
            <select onchange="renderLowestPrices(this.value)">
                ${availableStates.map(s => `<option value="${s}" ${s === currentStateContext ? 'selected' : ''}>${s} - ${getStoreCount(s)} stores</option>`).join('')}
            </select>
        </div>
    `;

    const gradeLabel = GRADE_INFO[gasPref].label;
    const sortedData = globalStoreData
        .filter(s => s.state === currentStateContext && hasGradeData(s, gasPref))
        .sort((a, b) => gradeVal(a, gasPref) - gradeVal(b, gasPref))
        .slice(0, 10);

    container.innerHTML += `<div class="leaderboard-header">Top 10 Cheapest ${gradeLabel}</div>`;
    if (sortedData.length === 0) {
        container.innerHTML += `<p class="empty-msg" style="font-size:13px;">No pricing data found for this state.</p>`;
        return;
    }
    sortedData.forEach((store, index) => container.appendChild(createStoreCard(store, gasPref, index)));
}

function setNearbyRadius(val) {
    nearbyRadiusMiles = parseFloat(val);
    localStorage.setItem('nearbyRadius', nearbyRadiusMiles);
    renderNearbyPrices();
}

function setNearbySort(val) {
    nearbySortMode = val;
    localStorage.setItem('nearbySort', nearbySortMode);
    renderNearbyPrices();
}

function renderNearbyPrices() {
    const container = document.getElementById("sidebarContent");

    if (!userLocation) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--costco-blue)" stroke-width="2" style="margin-bottom:15px;">
                    <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
                </svg>
                <h3 style="margin-bottom: 5px;">Find Local Gas</h3>
                <p style="color:var(--text-muted); font-size:14px; padding: 0 10px;">We need your location to find the cheapest Costco gas near you.</p>
                <button class="btn-action" onclick="triggerFindMe()" style="margin:15px auto 0;">📍 Detect Location</button>
            </div>
        `;
        return;
    }

    const gradeLabel = GRADE_INFO[gasPref].label;
    const controlsHtml = `
        <div class="nearby-controls">
            <div class="nearby-control-group">
                <label>Radius</label>
                <select onchange="setNearbyRadius(this.value)">
                    ${[5, 10, 25, 50, 100].map(m => `<option value="${m}" ${m === nearbyRadiusMiles ? 'selected' : ''}>${m} mi</option>`).join('')}
                </select>
            </div>
            <div class="nearby-control-group">
                <label>Sort by</label>
                <select onchange="setNearbySort(this.value)">
                    <option value="price" ${nearbySortMode === 'price' ? 'selected' : ''}>Price</option>
                    <option value="distance" ${nearbySortMode === 'distance' ? 'selected' : ''}>Distance</option>
                </select>
            </div>
        </div>
    `;

    const nearbyStores = globalStoreData
        .filter(s => s.lat && s.lng)
        .map(s => ({ ...s, distance: getDistanceMiles(userLocation.lat, userLocation.lng, s.lat, s.lng) }))
        .filter(s => s.distance <= nearbyRadiusMiles);

    if (nearbyStores.length === 0) {
        container.innerHTML = controlsHtml + `<p class="empty-msg">No Costco locations found within ${nearbyRadiusMiles} miles.</p>`;
        return;
    }

    const sortedData = nearbyStores
        .filter(s => hasGradeData(s, gasPref))
        .sort((a, b) => {
            const valA = gradeVal(a, gasPref);
            const valB = gradeVal(b, gasPref);
            if (nearbySortMode === 'distance') {
                return a.distance !== b.distance ? a.distance - b.distance : valA - valB;
            }
            return valA !== valB ? valA - valB : a.distance - b.distance;
        })
        .slice(0, 10);

    const headerLabel = nearbySortMode === 'distance'
        ? `Closest Stations &middot; ${gradeLabel} (Within ${nearbyRadiusMiles} Miles)`
        : `Cheapest ${gradeLabel} (Within ${nearbyRadiusMiles} Miles)`;

    container.innerHTML = controlsHtml + `<div class="leaderboard-header">${headerLabel}</div>`;

    if (sortedData.length === 0) {
        container.innerHTML += `<p class="empty-msg" style="margin-top:20px;">No stations within ${nearbyRadiusMiles} miles have a ${gradeLabel.toLowerCase()} price right now.</p>`;
        return;
    }

    sortedData.forEach((store, index) => container.appendChild(createStoreCard(store, gasPref, index, true)));
}

function renderFavoriteStores() {
    const container = document.getElementById("sidebarContent");
    container.innerHTML = "";

    const favorites = globalStoreData
        .filter(s => isFavoriteStore(s.state, s.city))
        .sort((a, b) => a.city.localeCompare(b.city));

    if (favorites.length === 0 && favoriteRoutes.length === 0) {
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
        favorites.forEach(store => container.appendChild(createStoreCard(store, gasPref)));
    }

    if (favoriteRoutes.length > 0) {
        const routesWrap = document.createElement('div');
        routesWrap.style.marginTop = favorites.length > 0 ? '16px' : '0';
        routesWrap.innerHTML = renderSavedRoutesHtml({ fromFavorites: true });
        container.appendChild(routesWrap);
    }
}

// --- Tab Navigation ---

const TAB_RENDERERS = {
    search: () => renderStoresList(document.getElementById('searchInput').value.toLowerCase()),
    lowest: () => renderLowestPrices(),
    nearby: () => renderNearbyPrices(),
    route: () => renderRoutePanel(),
    favorites: () => renderFavoriteStores()
};

function renderCurrentTab() {
    TAB_RENDERERS[currentTab]?.();
}

function refreshCurrentDisplay() {
    switchTab(currentTab);
}

function switchTab(tabName) {
    currentTab = tabName;

    Object.keys(TAB_RENDERERS).forEach(t => {
        document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tabName);
    });

    if (tabName !== 'route') {
        if (routeLayer) {
            routeLayer.clearLayers();
            if (globalStoreData.length > 0) renderMap(globalStoreData);
        }
        editingRouteId = null;
        editSnapshot = null;
    }

    renderCurrentTab();
}

function triggerFindMe() {
    requestBrowserLocation((position) => {
        userLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
        closeMobileStoreCard();
        placeUserLocationMarker(userLocation, { openPopup: true });
        map.flyTo([userLocation.lat, userLocation.lng], 10, { duration: 2 });
        updateClosestStoreState(userLocation);
        switchTab('nearby');
    });
}

initPreferences();
initMap();
loadData();
setInterval(refreshLastUpdatedLabel, 60000);
