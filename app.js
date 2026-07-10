    let map;
    let mapTileLayer;
    let markersLayer;
    let globalStoreData = [];
    let globalHistory = {};
    let priceChartInstance = null;

    // History is now a separate (and much larger, ever-growing) file from the
    // latest snapshot. We only fetch it the first time someone actually opens
    // a price history chart, and cache the result after that.
    let historyLoaded = false;
    let historyLoadPromise = null;

    let currentStateContext = 'CA';
    let userLocation = null;
    let searchLocationMarker = null;

    // Route feature state
    let routeLayer = null;       // L.layerGroup holding the polyline + start/end markers
    let lastRouteState = null;   // cached result so returning to the tab doesn't re-fetch

    // Autocomplete state
    let autocompleteItems = [];
    let activeAutocompleteIndex = -1;
    let geocodeAbortController = null;

    // User Preferences State
    let isDarkMode = localStorage.getItem('theme') === 'dark';
    let gasPref = localStorage.getItem('gasPref') || 'regular';
    let nearbyRadiusMiles = parseFloat(localStorage.getItem('nearbyRadius')) || 50;
    let nearbySortMode = localStorage.getItem('nearbySort') || 'price'; // 'price' | 'distance'

    // Safely parse data (Handles BOTH new Array format [4.84, 5.20] and old {"Regular": "$4.84"} format)
    const getValidPrice = (val) => {
        if (val === null || val === undefined || val === "N/A") return Infinity;
        if (typeof val === 'string') return parseFloat(val.replace('$', '').trim());
        return parseFloat(val);
    };

    const formatPriceDisplay = (val) => {
        if (val === null || val === undefined || val === Infinity) return "N/A";
        return `$${val.toFixed(2)}`;
    };

    function getDistanceMiles(lat1, lon1, lat2, lon2) {
        const R = 3958.8;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
        return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
    }
    let min = Infinity;
    for (let i = 0; i < routeCoords.length - 1; i++) {
        const [lat1, lng1] = routeCoords[i];
        const [lat2, lng2] = routeCoords[i + 1];
        const d = distanceToSegmentMiles(lat, lng, lat1, lng1, lat2, lng2);
        if (d < min) min = d;
    }
    return min;
}

function getRouteBoundsPadded(routeCoords, bufferMiles) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [lat, lng] of routeCoords) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
    }
    const midLat = (minLat + maxLat) / 2;
    const padLat = bufferMiles / 69;
    const padLng = bufferMiles / (69 * Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
    return { minLat: minLat - padLat, maxLat: maxLat + padLat, minLng: minLng - padLng, maxLng: maxLng + padLng };
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function getRelativeTimeLabel(timestampStr) {
    if (!timestampStr) return 'the last update';
    // Wrap timestampStr in String() to prevent a TypeError if it's parsed as a number
    const d = new Date(String(timestampStr).replace(/-/g, '/'));
    if (isNaN(d.getTime())) return 'the last update';

    const hours = Math.round((Date.now() - d.getTime()) / 3600000);
    if (hours < 1) return 'the last hour';
    if (hours < 36) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

// Small ▲/▼ indicator comparing a price to what it was last scrape.
function getTrendArrow(current, previous) {
    if (current === undefined || current === Infinity || isNaN(current)) return '';
    if (previous === undefined || previous === null || previous === Infinity || isNaN(previous)) return '';

    const diff = current - previous;
    if (isNaN(diff)) return '';

    if (Math.abs(diff) < 0.005) {
        return `<span class="trend-flat" title="No change since ${trendBaselineLabel}">–</span>`;
    }
    if (diff > 0) {
        return `<span class="trend-up" title="Up $${diff.toFixed(2)} since ${trendBaselineLabel}">▲</span>`;
    }
    return `<span class="trend-down" title="Down $${Math.abs(diff).toFixed(2)} since ${trendBaselineLabel}">▼</span>`;
}

// --- Shareable store links ---
function getShareUrl(state, city) {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('store', `${state}_${city}`);
    return url.toString();
}

function showToast(message) {
    const existing = document.querySelector('.app-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'app-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, 2200);
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

// --- Preferences Initializers ---
function initPreferences() {
    if (isDarkMode) {
        document.body.classList.add('dark-mode');
        document.getElementById('themeToggle').innerText = '☀️';
    }
    document.getElementById('btn-regular').classList.remove('active');
    document.getElementById('btn-premium').classList.remove('active');
    document.getElementById(`btn-${gasPref}`).classList.add('active');
}

function toggleTheme() {
    isDarkMode = document.body.classList.toggle('dark-mode');
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    document.getElementById('themeToggle').innerText = isDarkMode ? '☀️' : '🌙';
    setMapTiles();

    if(document.getElementById('chartModal').classList.contains('active')){
        const currentTitle = document.getElementById('chartTitle').innerText;
        const [, locationStr] = currentTitle.split(': ');
        const [city, state] = locationStr.split(', ');
        openHistoryModal(state, city);
    }
}

function setGasPref(pref) {
    gasPref = pref;
    localStorage.setItem('gasPref', pref);

    document.getElementById('btn-regular').classList.remove('active');
    document.getElementById('btn-premium').classList.remove('active');
    document.getElementById(`btn-${pref}`).classList.add('active');

    if (globalStoreData.length > 0) {
        renderMap(globalStoreData);
    }

    const activeTab = document.querySelector('.tab.active');
    if(activeTab) {
        const activeTabId = activeTab.id.replace('tab-', '');
        switchTab(activeTabId);
    }
}

// --- Map Logic ---
function setMapTiles() {
    if (mapTileLayer) map.removeLayer(mapTileLayer);
    const url = isDarkMode ?
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' :
        'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
    mapTileLayer = L.tileLayer(url, { attribution: '&copy; CARTO', maxZoom: 19 }).addTo(map);
}

function checkZoomLevel() {
    if (map.getZoom() >= 9) {
        document.getElementById('map').classList.add('map-show-prices');
    } else {
        document.getElementById('map').classList.remove('map-show-prices');
    }
}

function initMap() {
    map = L.map('map', {zoomControl: false}).setView([39.8283, -98.5795], 4);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    setMapTiles();
    markersLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);

    map.on('zoomend', checkZoomLevel);

    // Setup autocomplete for main search bar
    setupInputAutocomplete('searchInput', 'autocompleteDropdown', 'search');

    // Handle clicking outside to close any open autocomplete dropdown
    document.addEventListener('click', (e) => {
        const searchWrapper = document.getElementById('searchWrapper');
        const routePanel = document.querySelector('.route-panel');
        if (
            (!searchWrapper || !searchWrapper.contains(e.target)) &&
            (!routePanel || !routePanel.contains(e.target))
        ) {
            closeAutocompleteDropdown();
        }
    });
}

// --- Autocomplete / Geocoding Logic ---
function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function getStoreMatches(query) {
    return globalStoreData.filter(s =>
        s.city.toLowerCase().includes(query) ||
        s.address.toLowerCase().includes(query) ||
        s.state.toLowerCase().includes(query)
    ).slice(0, 5);
}

async function getGeoMatches(query) {
    try {
        if (geocodeAbortController) geocodeAbortController.abort();
        geocodeAbortController = new AbortController();
        const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
            signal: geocodeAbortController.signal,
            headers: { 'Accept-Language': 'en-US' }
        });
        if (!res.ok) return [];
        return await res.json();
    } catch (e) {
        if (e.name === 'AbortError') return [];
        console.warn('Geocode lookup failed:', e);
        return [];
    }
}

const debouncedAutocomplete = debounce(async (query) => {
    const storeMatches = getStoreMatches(query);

    // Show store matches immediately
    renderAutocompleteDropdown(storeMatches, [], query, true);

    const geoMatches = query.length >= 2 ? await getGeoMatches(query) : [];

    // Guard against stale responses using the actively focused input
    const activeInput = document.getElementById(activeInputId);
    if (activeInput && activeInput.value.toLowerCase().trim() === query) {
        renderAutocompleteDropdown(storeMatches, geoMatches, query, false);
    }
}, 400);

function getGeoMeta(result) {
    const type = result.addresstype || result.type || 'place';
    const metaMap = {
        postcode: { icon: '📮', label: 'Zip Code' },
        city: { icon: '🏙️', label: 'City' },
        town: { icon: '🏙️', label: 'Town' },
        village: { icon: '🏙️', label: 'Village' },
        hamlet: { icon: '🏙️', label: 'Town' },
        county: { icon: '📍', label: 'County' },
        state: { icon: '📍', label: 'State' },
        suburb: { icon: '📍', label: 'Neighborhood' },
        neighbourhood: { icon: '📍', label: 'Neighborhood' },
        administrative: { icon: '📍', label: 'Area' }
    };
    return metaMap[type] || { icon: '📍', label: 'Location' };
}

function shortGeoName(result) {
    const addr = result.address || {};
    const main = addr.city || addr.town || addr.village || addr.hamlet || addr.county || result.display_name.split(',')[0];
    let state = '';
    if (addr['ISO3166-2-lvl4']) state = addr['ISO3166-2-lvl4'].split('-')[1];
    else if (addr.state) state = addr.state;

    if (addr.postcode && (result.addresstype === 'postcode')) {
        return state ? `${addr.postcode} \u2014 ${main}, ${state}` : `${addr.postcode} \u2014 ${main}`;
    }
    return state ? `${main}, ${state}` : main;
}

// --- Route feature: geocoding + routing ---

async function geocodeAddress(query) {
    const coordMatch = query.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
        return { lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[2]), label: 'Your location' };
    }
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en-US' } });
        if (!res.ok) return null;
        const matches = await res.json();
        if (!matches || matches.length === 0) return null;
        const best = matches[0];
        return { lat: parseFloat(best.lat), lng: parseFloat(best.lon), label: shortGeoName(best) };
    } catch (e) {
        console.warn('Geocoding failed:', e);
        return null;
    }
}

async function fetchDrivingRoute(origin, destination) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`Routing service returned ${res.status}`);
        const data = await res.json();
        if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
            throw new Error('No driving route found between those two points.');
        }
        const route = data.routes[0];
        const coords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        return { coords, distanceMiles: route.distance / 1609.34, isApproximate: false };
    } catch (err) {
        clearTimeout(timeoutId);
        console.warn('Live routing unavailable, falling back to a straight-line corridor:', err);
        const coords = [[origin.lat, origin.lng], [destination.lat, destination.lng]];
        return {
            coords,
            distanceMiles: getDistanceMiles(origin.lat, origin.lng, destination.lat, destination.lng),
            isApproximate: true
        };
    }
}

function renderAutocompleteDropdown(storeMatches, geoMatches, query, isLoadingGeo) {
    const dropdown = document.getElementById(activeDropdownId);
    if (!dropdown) return;

    autocompleteItems = [];
    activeAutocompleteIndex = -1;

    let html = '';

    if (storeMatches.length > 0) {
        html += `<div class="autocomplete-section-label">Costco Stores</div>`;
        storeMatches.forEach(store => {
            const idx = autocompleteItems.length;
            autocompleteItems.push({ type: 'store', data: store });
            html += `
                <div class="autocomplete-item" data-index="${idx}" onclick="selectAutocompleteItem(${idx})">
                    <span class="ac-icon">🛒</span>
                    <div class="ac-text">
                        <div class="ac-title">${store.city}, ${store.state}</div>
                        <div class="ac-subtitle">${store.address}</div>
                    </div>
                </div>`;
        });
    }

    if (geoMatches.length > 0) {
        html += `<div class="autocomplete-section-label">Locations</div>`;
        geoMatches.forEach(result => {
            const idx = autocompleteItems.length;
            autocompleteItems.push({ type: 'place', data: result });
            const meta = getGeoMeta(result);
            html += `
                <div class="autocomplete-item" data-index="${idx}" onclick="selectAutocompleteItem(${idx})">
                    <span class="ac-icon">${meta.icon}</span>
                    <div class="ac-text">
                        <div class="ac-title">${shortGeoName(result)}</div>
                        <div class="ac-subtitle">${meta.label}</div>
                    </div>
                </div>`;
        });
    } else if (isLoadingGeo && query.length >= 2) {
        html += `<div class="autocomplete-loading">Searching locations…</div>`;
    }

    if (html === '') {
        if (query.length >= 1) {
            html = `<div class="autocomplete-empty">No matches found</div>`;
        } else {
            dropdown.classList.remove('active');
            dropdown.innerHTML = '';
            return;
        }
    }

    dropdown.innerHTML = html;
    dropdown.classList.add('active');
}

function moveAutocompleteSelection(delta) {
    const items = document.querySelectorAll(`#${activeDropdownId} .autocomplete-item`);
    if (items.length === 0) return;
    activeAutocompleteIndex += delta;
    if (activeAutocompleteIndex < 0) activeAutocompleteIndex = items.length - 1;
    if (activeAutocompleteIndex >= items.length) activeAutocompleteIndex = 0;
    items.forEach((el, i) => el.classList.toggle('active', i === activeAutocompleteIndex));
    items[activeAutocompleteIndex].scrollIntoView({ block: 'nearest' });
}

function getAutocompleteLabel(item) {
    if (item.type === 'store') return `${item.data.city}, ${item.data.state}`;
    return shortGeoName(item.data);
}

function selectAutocompleteItem(idx) {
    const item = autocompleteItems[idx];
    if (!item) return;

    if (currentAutocompleteAction === 'search') {
        if (item.type === 'store') {
            flyToStore(item.data);
        } else {
            flyToGeoResult(item.data);
        }
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.blur();
    } else if (currentAutocompleteAction === 'routeOrigin') {
        document.getElementById('routeOrigin').value = getAutocompleteLabel(item);
    } else if (currentAutocompleteAction === 'routeDest') {
        document.getElementById('routeDestination').value = getAutocompleteLabel(item);
    }

    closeAutocompleteDropdown();
}

function closeAutocompleteDropdown() {
    const dropdown = document.getElementById(activeDropdownId);
    if (dropdown) {
        dropdown.classList.remove('active');
        dropdown.innerHTML = '';
    }
    autocompleteItems = [];
    activeAutocompleteIndex = -1;
}

// NEW: Reusable autocomplete listener setup
function setupInputAutocomplete(inputId, dropdownId, actionType) {
    const inputEl = document.getElementById(inputId);
    if (!inputEl) return;

    inputEl.addEventListener('input', (e) => {
        activeInputId = inputId;
        activeDropdownId = dropdownId;
        currentAutocompleteAction = actionType;

        const query = e.target.value.toLowerCase().trim();

        if (actionType === 'search') {
            switchTab('search');
            renderStoresList(query);
        }

        if (query.length === 0) {
            closeAutocompleteDropdown();
            return;
        }
        debouncedAutocomplete(query);
    });

    inputEl.addEventListener('keydown', (e) => {
        const dropdownEl = document.getElementById(dropdownId);
        if (!dropdownEl || !dropdownEl.classList.contains('active')) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveAutocompleteSelection(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveAutocompleteSelection(-1);
        } else if (e.key === 'Enter') {
            if (activeAutocompleteIndex >= 0) {
                e.preventDefault();
                selectAutocompleteItem(activeAutocompleteIndex);
            }
        } else if (e.key === 'Escape') {
            closeAutocompleteDropdown();
        }
    });

    inputEl.addEventListener('focus', () => {
        activeInputId = inputId;
        activeDropdownId = dropdownId;
        currentAutocompleteAction = actionType;

        const query = inputEl.value.toLowerCase().trim();
        if (query.length > 0 && autocompleteItems.length > 0) {
            const dropdownEl = document.getElementById(dropdownId);
            if (dropdownEl) dropdownEl.classList.add('active');
        }
    });
}

function flyToStore(store) {
    map.flyTo([store.lat, store.lng], 14, { duration: 1.5 });
    map.once('moveend', () => store.leafletMarker && store.leafletMarker.openPopup());
    if (window.innerWidth <= 768) {
        document.getElementById('map').scrollIntoView({behavior: 'smooth'});
    }
}

function flyToGeoResult(result) {
    const south = parseFloat(result.boundingbox[0]);
    const north = parseFloat(result.boundingbox[1]);
    const west = parseFloat(result.boundingbox[2]);
    const east = parseFloat(result.boundingbox[3]);

    map.flyToBounds([[south, west], [north, east]], { duration: 1.5, maxZoom: 13, padding: [40, 40] });

    userLocation = { lat: parseFloat(result.lat), lng: parseFloat(result.lon) };

    if (searchLocationMarker) map.removeLayer(searchLocationMarker);
    searchLocationMarker = L.circleMarker([userLocation.lat, userLocation.lng], {
        radius: 8, fillColor: "#f59e0b", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
    }).addTo(map).bindPopup(`<b>${shortGeoName(result)}</b>`);

    map.once('moveend', () => switchTab('nearby'));

    if (window.innerWidth <= 768) {
        document.getElementById('map').scrollIntoView({behavior: 'smooth'});
    }
}

async function detectUserState() {
    try {
        const res = await fetch('https://ipapi.co/region_code/');
        if (res.ok) {
            const code = await res.text();
            if (code && code.length === 2) currentStateContext = code.toUpperCase();
        }
    } catch (e) {}
}

function extractRegPrem(pData) {
    // Null safety guard
    if (!pData) return [undefined, undefined];

    if (Array.isArray(pData)) {
        return [pData[0], pData[1]];
    }
    return [pData.Regular ?? pData.regular, pData.Premium ?? pData.premium];
}

async function loadData() {
    try {
        const cb = new Date().getTime();
        const [latestRes, storesRes, _] = await Promise.all([
            fetch(`us_latest.json?t=${cb}`),
            fetch(`us_stores.json?t=${cb}`),
            detectUserState()
        ]);

        if (!latestRes.ok || !storesRes.ok) throw new Error('Failed to fetch latest snapshot or store list');

        const latestData = await latestRes.json();
        const storeData = await storesRes.json();

        const latestTimestamp = latestData.timestamp;

        // Safety fallback for prices object
        const timestampedPrices = latestData.prices || latestData || {};

        const previousPrices = latestData.previous || {};
        const previousTimestamp = latestData.previous_timestamp || null;
        trendBaselineLabel = getRelativeTimeLabel(previousTimestamp);

        document.getElementById("lastUpdated").innerText = `Last Updated: ${latestTimestamp}`;

        for (const stateCode in storeData) {
            if (!timestampedPrices[stateCode]) continue;
            for (const [cityName, info] of Object.entries(storeData[stateCode])) {

                const pData = timestampedPrices[stateCode][cityName];

                if (pData) {
                    const [rRaw, pRaw] = extractRegPrem(pData);
                    const regVal = getValidPrice(rRaw);
                    const premVal = getValidPrice(pRaw);

                    let prevRegVal, prevPremVal;
                    const prevData = previousPrices[stateCode] && previousPrices[stateCode][cityName];
                    if (prevData) {
                        const [prevRRaw, prevPRaw] = extractRegPrem(prevData);
                        prevRegVal = getValidPrice(prevRRaw);
                        prevPremVal = getValidPrice(prevPRaw);
                    }

                    globalStoreData.push({
                        state: stateCode, city: cityName, address: info.address,
                        lat: info.lat, lng: info.lng, url: info.url,
                        regularStr: formatPriceDisplay(regVal),
                        premiumStr: formatPriceDisplay(premVal),
                        regVal: regVal,
                        premVal: premVal,
                        prevRegVal: prevRegVal,
                        prevPremVal: prevPremVal
                    });
                }
            }
        }

        renderMap(globalStoreData);
        switchTab('nearby');

        const openedSharedStore = openSharedStoreIfPresent();

        if (!openedSharedStore && globalStoreData.length > 0) {
            const bounds = L.latLngBounds(globalStoreData.map(s => [s.lat, s.lng]).filter(coords => coords[0] && coords[1]));
            map.fitBounds(bounds, { padding: [30, 30] });
            checkZoomLevel();
        }
    } catch (error) {
        console.error('Error fetching data:', error);
        document.getElementById("sidebarContent").innerHTML = `<p style="text-align:center; color:var(--costco-red); margin-top:30px;">Error Loading Data.</p>`;
    }
}

function ensureHistoryLoaded() {
    if (historyLoaded) return Promise.resolve();
    if (historyLoadPromise) return historyLoadPromise;

    historyLoadPromise = (async () => {
        const cb = new Date().getTime();
        const res = await fetch(`us_history.json?t=${cb}`);
        if (!res.ok) throw new Error(`Failed to fetch price history (${res.status})`);
        const priceData = await res.json();

        const timestamps = Object.keys(priceData).sort();

        timestamps.forEach(ts => {
            const d = new Date(ts.replace(/-/g, '/'));
            const dayStr = d.toLocaleDateString();

            for (const stateCode in priceData[ts]) {
                for (const cityName in priceData[ts][stateCode]) {
                    const key = `${stateCode}_${cityName}`;
                    if (!globalHistory[key]) globalHistory[key] = [];

                    const [rRaw, pRaw] = extractRegPrem(priceData[ts][stateCode][cityName]);

                    globalHistory[key].push({
                        rawDate: d,
                        dayStr: dayStr,
                        reg: getValidPrice(rRaw),
                        prem: getValidPrice(pRaw)
                    });
                }
            }
        });

        historyLoaded = true;
    })().catch(err => {
        historyLoadPromise = null;
        throw err;
    });

    return historyLoadPromise;
}

function renderMap(dataArray) {
    markersLayer.clearLayers();
    dataArray.forEach(store => {
        if (!store.lat || !store.lng) return;

        const displayPrice = gasPref === 'regular' ? store.regularStr : store.premiumStr;
        const priceColor = gasPref === 'regular' ? '#059669' : '#E31837';

        const dynamicPin = L.divIcon({
            className: 'costco-custom-icon',
            html: `
                <div style="position:relative;">
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

        const marker = L.marker([store.lat, store.lng], {icon: dynamicPin});
        const safeCity = store.city.replace(/'/g, "\\'");
        const regTrend = getTrendArrow(store.regVal, store.prevRegVal);
        const premTrend = getTrendArrow(store.premVal, store.prevPremVal);

        marker.bindPopup(`
            <div class="popup-store-name">${store.city}, ${store.state}</div>
            <div class="popup-address">${store.address}</div>
            <div class="popup-prices-grid">
                <div class="popup-price-box"><span>Regular</span><strong>${store.regularStr || 'N/A'} ${regTrend}</strong></div>
                <div class="popup-price-box"><span>Premium</span><strong>${store.premiumStr || 'N/A'} ${premTrend}</strong></div>
            </div>
            <a href="${store.url}" target="_blank" rel="noopener noreferrer" class="popup-btn popup-btn-outline">View Store</a>
            <button class="popup-btn" style="margin-top:8px;" onclick="openHistoryModal('${store.state}', '${safeCity}')">📈 Price History</button>
            <button class="popup-btn popup-btn-outline" style="margin-top:8px;" onclick="shareStore('${store.state}', '${safeCity}', '${safeCity}, ${store.state}')">🔗 Share This Station</button>
        `);
        marker.addTo(markersLayer);
        store.leafletMarker = marker;
    });
}

// --- History Chart Modal Logic ---
async function openHistoryModal(state, city) {
    const key = `${state}_${city}`;
    const chartContainer = document.querySelector('.chart-container');

    document.getElementById('chartModal').classList.add('active');
    document.getElementById('chartTitle').innerText = `Price History: ${city}, ${state}`;

    const showMessage = (msg, isError = false) => {
        chartContainer.innerHTML = `<p style="text-align:center; color:${isError ? 'var(--costco-red)' : 'var(--text-muted)'}; margin-top:40px;">${msg}</p>`;
    };

    if (!historyLoaded) {
        showMessage('Loading price history…');
        try {
            await ensureHistoryLoaded();
        } catch (e) {
            console.error('Error loading price history:', e);
            showMessage("Couldn't load price history. Please try again.", true);
            return;
        }
    }

    const history = globalHistory[key];
    if (!history || history.length === 0) {
        showMessage(`No price history available for ${city}, ${state}.`);
        return;
    }

    if (!document.getElementById('priceChart')) {
        chartContainer.innerHTML = `<canvas id="priceChart"></canvas>`;
    }

    const dedupedHistory = [];
    const seenDates = new Set();
    for (let i = history.length - 1; i >= 0; i--) {
        if (!seenDates.has(history[i].dayStr)) {
            seenDates.add(history[i].dayStr);
            dedupedHistory.unshift(history[i]);
        }
    }

    const labels = dedupedHistory.map(h => h.rawDate);
    const regData = dedupedHistory.map(h => h.reg === Infinity ? null : h.reg);
    const premData = dedupedHistory.map(h => h.prem === Infinity ? null : h.prem);

    const textColor = isDarkMode ? '#f8fafc' : '#1e293b';
    const gridColor = isDarkMode ? '#334155' : '#e2e8f0';

    const ctx = document.getElementById('priceChart').getContext('2d');
    if (priceChartInstance) priceChartInstance.destroy();

    priceChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Regular',
                    data: regData,
                    borderColor: '#059669',
                    backgroundColor: '#059669',
                    tension: 0.1,
                    pointRadius: 4,
                    spanGaps: true
                },
                {
                    label: 'Premium',
                    data: premData,
                    borderColor: '#E31837',
                    backgroundColor: '#E31837',
                    tension: 0.1,
                    pointRadius: 4,
                    spanGaps: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: textColor } },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': $' + context.raw.toFixed(2);
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        tooltipFormat: 'MMM d, yyyy',
                        displayFormats: { month: 'MMM yyyy' }
                    },
                    ticks: { color: textColor },
                    grid: { color: gridColor }
                },
                y: {
                    ticks: { color: textColor, callback: function(value) { return '$' + value.toFixed(2); } },
                    grid: { color: gridColor }
                }
            }
        }
    });
}

function closeHistoryModal(event) {
    if (event && event.target !== document.getElementById('chartModal')) return;
    document.getElementById('chartModal').classList.remove('active');
}

// --- Sidebar Render Logic ---
function renderStoresList(searchTerm) {
    const container = document.getElementById("sidebarContent");
    container.innerHTML = "";
    const filtered = globalStoreData.filter(s =>
        s.city.toLowerCase().includes(searchTerm) ||
        s.address.toLowerCase().includes(searchTerm) ||
        s.state.toLowerCase().includes(searchTerm)
    );

    if (filtered.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:var(--text-muted); margin-top:40px;">No stores found.</p>`;
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

    let dropdownHTML = `
        <div class="state-selector-box">
            <label>State Leaderboard:</label>
            <select onchange="renderLowestPrices(this.value)">
                ${availableStates.map(s => `<option value="${s}" ${s === currentStateContext ? 'selected' : ''}>${s} - ${getStoreCount(s)} stores</option>`).join('')}
            </select>
        </div>
    `;
    container.innerHTML += dropdownHTML;

    const stateData = globalStoreData.filter(s => s.state === currentStateContext);
    const isReg = gasPref === 'regular';

    const sortedData = [...stateData]
        .filter(s => isReg ? s.regVal !== Infinity : s.premVal !== Infinity)
        .sort((a, b) => isReg ? a.regVal - b.regVal : a.premVal - b.premVal)
        .slice(0, 10);

    container.innerHTML += `<div class="leaderboard-header">Top 10 Cheapest ${isReg ? 'Regular' : 'Premium'}</div>`;
    if (sortedData.length === 0) {
        container.innerHTML += `<p style="text-align:center; color:var(--text-muted); font-size: 13px;">No pricing data found for this state.</p>`;
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
            <div style="text-align:center; margin-top:50px;">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--costco-blue)" stroke-width="2" style="margin-bottom:15px;">
                    <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
                </svg>
                <h3 style="margin-bottom: 5px;">Find Local Gas</h3>
                <p style="color:var(--text-muted); font-size:14px; padding: 0 10px;">We need your location to find the cheapest Costco gas near you.</p>
                <button class="btn-action" onclick="triggerFindMe()" style="margin-top:15px; margin-left:auto; margin-right:auto;">📍 Detect Location</button>
            </div>
        `;
        return;
    }

    const isReg = gasPref === 'regular';
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

    let nearbyStores = globalStoreData.filter(s => s.lat && s.lng).map(s => {
        return { ...s, distance: getDistanceMiles(userLocation.lat, userLocation.lng, s.lat, s.lng) };
    }).filter(s => s.distance <= nearbyRadiusMiles);

    if (nearbyStores.length === 0) {
        container.innerHTML = controlsHtml + `<p style="text-align:center; color:var(--text-muted); margin-top:40px;">No Costco locations found within ${nearbyRadiusMiles} miles.</p>`;
        return;
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
                <div style="text-align:center; margin-top:50px;">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--costco-blue)" stroke-width="2" style="margin-bottom:15px;">
                        <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
                    </svg>
                    <h3 style="margin-bottom: 5px;">Find Local Gas</h3>
                    <p style="color:var(--text-muted); font-size:14px; padding: 0 10px;">We need your location to find the cheapest Costco gas near you.</p>
                    <button class="btn-action" onclick="triggerFindMe()" style="margin-top:15px; margin-left:auto; margin-right:auto;">📍 Detect Location</button>
                </div>
            `;
            return;
        }

        const isReg = gasPref === 'regular';
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

        let nearbyStores = globalStoreData.filter(s => s.lat && s.lng).map(s => {
            return { ...s, distance: getDistanceMiles(userLocation.lat, userLocation.lng, s.lat, s.lng) };
        }).filter(s => s.distance <= nearbyRadiusMiles);

        if (nearbyStores.length === 0) {
            container.innerHTML = controlsHtml + `<p style="text-align:center; color:var(--text-muted); margin-top:40px;">No Costco locations found within ${nearbyRadiusMiles} miles.</p>`;
            return;
        }

        const sortedData = [...nearbyStores]
            .filter(s => isReg ? s.regVal !== Infinity : s.premVal !== Infinity)
            .sort((a, b) => {
                const valA = isReg ? a.regVal : a.premVal;
                const valB = isReg ? b.regVal : b.premVal;
                if (nearbySortMode === 'distance') {
                    return a.distance !== b.distance ? a.distance - b.distance : valA - valB;
                }
                return valA !== valB ? valA - valB : a.distance - b.distance;
            }).slice(0, 10);

        const headerLabel = nearbySortMode === 'distance'
            ? `Closest Stations &middot; ${isReg ? 'Regular' : 'Premium'} (Within ${nearbyRadiusMiles} Miles)`
            : `Cheapest ${isReg ? 'Regular' : 'Premium'} (Within ${nearbyRadiusMiles} Miles)`;

        container.innerHTML = controlsHtml + `<div class="leaderboard-header">${headerLabel}</div>`;

        if (sortedData.length === 0) {
            container.innerHTML += `<p style="text-align:center; color:var(--text-muted); margin-top:20px;">No stations within ${nearbyRadiusMiles} miles have a ${isReg ? 'regular' : 'premium'} price right now.</p>`;
            return;
        }

        sortedData.forEach((store, index) => container.appendChild(createStoreCard(store, gasPref, index, true)));
    }

    if (sortedData.length === 0) {
        container.innerHTML += `<p style="text-align:center; color:var(--text-muted); margin-top:20px;">No stations within ${nearbyRadiusMiles} miles have a ${isReg ? 'regular' : 'premium'} price right now.</p>`;
        return;
    }

    sortedData.forEach((store, index) => container.appendChild(createStoreCard(store, gasPref, index, true)));
}

function getMedal(index) {
    if (index === 0) return '🥇';
    if (index === 1) return '🥈';
    if (index === 2) return '🥉';
    return `<span style="font-size:13px; color:var(--text-muted); margin-right:4px;">#${index + 1}</span>`;
}

function createStoreCard(store, highlight = null, index = null, showDistance = false, distanceSuffix = '') {
    const div = document.createElement('div');
    div.className = 'store-card';

    let regClass = highlight === 'regular' ? 'highlight' : '';
    let premClass = highlight === 'premium' ? 'highlight' : '';

    let badgeHtml = '';
    if (showDistance && store.distance !== undefined) {
        badgeHtml = `<span class="distance-badge">${store.distance.toFixed(1)} mi${distanceSuffix}</span>`;
    } else if (index !== null) {
        badgeHtml = `<span class="medal">${getMedal(index)}</span>`;
    }

    const safeCity = store.city.replace(/'/g, "\\'");
    const regTrend = getTrendArrow(store.regVal, store.prevRegVal);
    const premTrend = getTrendArrow(store.premVal, store.prevPremVal);

    div.innerHTML = `
        <h3><span>${store.city}, ${store.state}</span> ${badgeHtml}</h3>
        <div class="address">${store.address}</div>
        <div class="prices">
            <div class="price-tag ${regClass}">
                <span>Regular</span><span class="val">${store.regularStr || 'N/A'} ${regTrend}</span>
            </div>
            <div class="price-tag ${premClass}">
                <span>Premium</span><span class="val">${store.premiumStr || 'N/A'} ${premTrend}</span>
            </div>
        </div>
        <div class="card-actions">
            <button class="btn-action" style="flex:1; background: transparent; color: var(--costco-blue); border: 2px solid var(--costco-blue);"
                onclick="event.stopPropagation(); openHistoryModal('${store.state}', '${safeCity}')">
                📈 History
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

// --- Route feature: UI + orchestration ---

function renderRoutePanel() {
    const container = document.getElementById("sidebarContent");
    const originVal = lastRouteState ? escapeHtml(lastRouteState.originText) : '';
    const destVal = lastRouteState ? escapeHtml(lastRouteState.destText) : '';
    const buffer = lastRouteState ? lastRouteState.bufferMiles : 2;

    container.innerHTML = `
        <div class="route-panel">
            <label>From</label>
            <div class="route-input-row" style="position:relative;">
                <input type="text" id="routeOrigin" class="route-input" placeholder="Address or city" autocomplete="off" value="${originVal}">
                <button class="route-locate-btn" onclick="useMyLocationForRoute()" title="Use my location">📍</button>
                <div id="routeOriginDropdown" class="autocomplete-dropdown"></div>
            </div>
            
            <label>To</label>
            <div class="route-input-row" style="position:relative;">
                <input type="text" id="routeDestination" class="route-input" placeholder="Address or city" autocomplete="off" value="${destVal}">
                <div id="routeDestDropdown" class="autocomplete-dropdown"></div>
            </div>
            
            <label>Search within (miles of the route)</label>
            <input type="number" id="routeBuffer" class="route-input" style="width:100%; margin-bottom:12px;"
                   min="0.5" max="25" step="0.5" value="${buffer}">
            <button class="btn-action" style="width:100%; justify-content:center;" onclick="findGasAlongRoute()">🛣️ Find Cheapest Along Route</button>
        </div>
        <div id="routeResultsContainer"></div>
    `;

    // Hook up the new autocomplete functionality to the route inputs!
    setupInputAutocomplete('routeOrigin', 'routeOriginDropdown', 'routeOrigin');
    setupInputAutocomplete('routeDestination', 'routeDestDropdown', 'routeDest');

    if (lastRouteState && lastRouteState.along) {
        renderRouteResults(lastRouteState);
        renderRouteOnMap(lastRouteState.route.coords, lastRouteState.origin, lastRouteState.destination);
        renderMap(lastRouteState.along.length > 0 ? lastRouteState.along : globalStoreData);
    }
}

function renderRouteResults(state) {
    const el = document.getElementById('routeResultsContainer');
    if (!el) return;
    const isReg = gasPref === 'regular';
    const { along, route, bufferMiles } = state;

    const sorted = along
        .filter(s => isReg ? s.regVal !== Infinity : s.premVal !== Infinity)
        .sort((a, b) => (isReg ? a.regVal - b.regVal : a.premVal - b.premVal));

    let html = '';
    if (route.isApproximate) {
        html += `<p class="route-warning">⚠️ Live routing was unavailable, so this is an approximate straight-line path, not a real driving route.</p>`;
    }
    html += `<div class="route-summary">${Math.round(route.distanceMiles)} mi route &middot; ${sorted.length} station${sorted.length === 1 ? '' : 's'} found</div>`;
    el.innerHTML = html;

    if (sorted.length === 0) {
        el.innerHTML += `<p style="text-align:center; color:var(--text-muted); margin-top:20px;">No Costco gas stations found within ${bufferMiles} miles of this route.</p>`;
        return;
    }

    el.innerHTML += `<div class="leaderboard-header">Cheapest ${isReg ? 'Regular' : 'Premium'} Along the Way</div>`;
    sorted.forEach((store, index) => el.appendChild(createStoreCard(store, gasPref, index, true, ' off route')));
}

function renderRouteOnMap(routeCoords, origin, destination) {
    if (!routeLayer) return;
    routeLayer.clearLayers();
    L.polyline(routeCoords, { color: '#005DAA', weight: 5, opacity: 0.7 }).addTo(routeLayer);
    L.circleMarker([origin.lat, origin.lng], { radius: 8, fillColor: '#059669', color: '#fff', weight: 3, opacity: 1, fillOpacity: 1 })
        .addTo(routeLayer).bindPopup(`<b>Start:</b> ${escapeHtml(origin.label)}`);
    L.circleMarker([destination.lat, destination.lng], { radius: 8, fillColor: '#E31837', color: '#fff', weight: 3, opacity: 1, fillOpacity: 1 })
        .addTo(routeLayer).bindPopup(`<b>End:</b> ${escapeHtml(destination.label)}`);

    const bounds = L.latLngBounds(routeCoords);
    map.fitBounds(bounds, { padding: [40, 40] });
}

function useMyLocationForRoute() {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const originInput = document.getElementById('routeOrigin');
            if (originInput) {
                originInput.value = `${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`;
            }
        },
        () => alert("Unable to retrieve your location. Check browser permissions.")
    );
}

async function findGasAlongRoute() {
    const originText = document.getElementById('routeOrigin').value.trim();
    const destText = document.getElementById('routeDestination').value.trim();
    const bufferInput = document.getElementById('routeBuffer').value;
    const bufferMiles = parseFloat(bufferInput);
    const resultsEl = document.getElementById('routeResultsContainer');

    if (!originText || !destText) {
        resultsEl.innerHTML = `<p class="route-error">Enter both a starting point and a destination.</p>`;
        return;
    }

    if (!bufferInput || isNaN(bufferMiles) || bufferMiles <= 0) {
        resultsEl.innerHTML = `<p class="route-error">Enter a valid search distance greater than 0.</p>`;
        return;
    }

    resultsEl.innerHTML = `<p style="text-align:center; color:var(--text-muted); margin-top:20px;">Calculating route…</p>`;

    try {
        const [origin, destination] = await Promise.all([
            geocodeAddress(originText),
            geocodeAddress(destText)
        ]);
        if (!origin) throw new Error(`Couldn't find "${originText}". Try a more specific address or city.`);
        if (!destination) throw new Error(`Couldn't find "${destText}". Try a more specific address or city.`);

        const route = await fetchDrivingRoute(origin, destination);

        const bounds = getRouteBoundsPadded(route.coords, bufferMiles);

        const along = globalStoreData
            .filter(s => s.lat && s.lng &&
                s.lat >= bounds.minLat && s.lat <= bounds.maxLat &&
                s.lng >= bounds.minLng && s.lng <= bounds.maxLng)
            .map(s => ({ ...s, distance: minDistanceToRouteMiles(s.lat, s.lng, route.coords) }))
            .filter(s => s.distance <= bufferMiles);

        lastRouteState = { originText, destText, bufferMiles, origin, destination, route, along };

        renderRouteOnMap(route.coords, origin, destination);
        renderMap(along.length > 0 ? along : globalStoreData);
        renderRouteResults(lastRouteState);

    } catch (err) {
        console.error('Route search failed:', err);
        resultsEl.innerHTML = `<p class="route-error">${escapeHtml(err.message || "Couldn't calculate that route. Please try again.")}</p>`;
    }
}

function switchTab(tabName) {
    document.getElementById('tab-search').classList.remove('active');
    document.getElementById('tab-lowest').classList.remove('active');
    document.getElementById('tab-nearby').classList.remove('active');
    document.getElementById('tab-route').classList.remove('active');

    // Leaving the Route tab: clear the route line and restore full map markers
    if (tabName !== 'route' && routeLayer) {
        routeLayer.clearLayers();
        if (globalStoreData.length > 0) renderMap(globalStoreData);
    }

    if (tabName === 'search') {
        document.getElementById('tab-search').classList.add('active');
        renderStoresList(document.getElementById('searchInput').value.toLowerCase());
    } else if (tabName === 'lowest') {
        document.getElementById('tab-lowest').classList.add('active');
        renderLowestPrices();
    } else if (tabName === 'nearby') {
        document.getElementById('tab-nearby').classList.add('active');
        renderNearbyPrices();
    } else if (tabName === 'route') {
        document.getElementById('tab-route').classList.add('active');
        renderRoutePanel();
    }
}

function triggerFindMe() {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (position) => {
            userLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };

            L.circleMarker([userLocation.lat, userLocation.lng], {
                radius: 8, fillColor: "#3b82f6", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
            }).addTo(map).bindPopup("<b>You are here!</b>").openPopup();

            map.flyTo([userLocation.lat, userLocation.lng], 10, {duration: 2});

            if (globalStoreData.length > 0) {
                let closestStore = globalStoreData.find(s => s.lat && s.lng) || globalStoreData[0];
                let minDistance = Infinity;
                globalStoreData.forEach(s => {
                    if(!s.lat || !s.lng) return;
                    let distance = Math.pow(s.lat - userLocation.lat, 2) + Math.pow(s.lng - userLocation.lng, 2);
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestStore = s;
                    }
                });
                currentStateContext = closestStore.state;
            }

            switchTab('nearby');
        },
        (error) => alert("Unable to retrieve your location. Check browser permissions.")
    );
}

initPreferences();
initMap();
loadData();