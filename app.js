let map;
let mapTileLayer;
let markersLayer;
let globalStoreData = [];
let globalHistory = {};
let priceChartInstance = null;
let trendBaselineLabel = 'the last update';
let latestTimestampGlobal = null; // raw scraper timestamp string, kept so we can re-render "time ago" on a timer

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
let routeOriginLocation = null; // cached origin coordinates from autocomplete
let routeDestLocation = null;   // cached destination coordinates from autocomplete
let editingRouteId = null;   // id of the favorite route currently being edited, or null
let editSnapshot = null;     // { lastRouteState, routeOriginLocation, routeDestLocation } to restore on cancel

// Autocomplete state
let autocompleteItems = [];
let activeAutocompleteIndex = -1;
let geocodeAbortController = null;
let activeInputId = 'searchInput';
let activeDropdownId = 'autocompleteDropdown';
let currentAutocompleteAction = 'search'; // 'search' | 'routeOrigin' | 'routeDest'

// User Preferences State
let isDarkMode = localStorage.getItem('theme') === 'dark';
let gasPref = localStorage.getItem('gasPref') || 'regular';
let nearbyRadiusMiles = parseFloat(localStorage.getItem('nearbyRadius')) || 50;
let nearbySortMode = localStorage.getItem('nearbySort') || 'price'; // 'price' | 'distance'

// Favorites: stores as a Set of "STATE_City" keys, routes as an array of
// resolved {origin, destination, bufferMiles} objects - both persisted to
// localStorage the same way the other prefs above are.
let favoriteStoreKeys = new Set(loadJsonPref('favoriteStores', []));
let favoriteRoutes = loadJsonPref('favoriteRoutes', []);

function loadJsonPref(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

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

// --- Route helpers (used by the "Find Gas Along Route" tab) ---

function distanceToSegmentMiles(lat, lng, lat1, lng1, lat2, lng2) {
    const toRad = d => d * Math.PI / 180;
    const midLat = toRad((lat1 + lat2) / 2);
    const cosMid = Math.cos(midLat) || 0.000001;
    const x = (lng - lng1) * cosMid;
    const y = (lat - lat1);
    const dx = (lng2 - lng1) * cosMid;
    const dy = (lat2 - lat1);
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((x * dx + y * dy) / lenSq);
    t = Math.max(0, Math.min(1, t));
    const projLat = lat1 + t * dy;
    const projLng = lng1 + (t * dx) / cosMid;
    return getDistanceMiles(lat, lng, projLat, projLng);
}

function minDistanceToRouteMiles(lat, lng, routeCoords) {
    if (routeCoords.length === 1) {
        return getDistanceMiles(lat, lng, routeCoords[0][0], routeCoords[0][1]);
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

// The scraper writes timestamps as a naive "wall clock" string (e.g.
// "2026-07-11 14:30:00") with NO timezone info attached — and that clock is
// Pacific time. Handing that straight to `new Date(...)` (which is what the
// old `.replace(/-/g, '/')` trick did) makes the browser assume the string is
// in the *viewer's own* timezone. That's wrong for anyone not on Pacific
// time: someone in New York would read "14:30" as 2:30pm Eastern, when it
// was really 2:30pm Pacific — a 3 hour error. SCRAPER_TIMEZONE plus
// parseScraperTimestamp() below resolve the string against the correct
// timezone (DST-aware) so "time ago" math comes out right everywhere.
const SCRAPER_TIMEZONE = 'America/Los_Angeles';

// Returns the offset (in minutes) such that UTC = wallClockTimeInZone + offset,
// for whatever instant `utcGuess` represents.
function getTimeZoneOffsetMinutes(timeZone, utcGuess) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = {};
    dtf.formatToParts(utcGuess).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
    const hour = parts.hour === '24' ? '00' : parts.hour;
    const asIfUTC = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
    return (asIfUTC - utcGuess.getTime()) / 60000;
}

// Resolves a scraper timestamp string into the actual point in time it
// represents, regardless of the browser's own timezone.
function parseScraperTimestamp(timestampStr) {
    if (!timestampStr) return null;
    const str = String(timestampStr).trim();

    // Already carries an explicit offset or "Z" — the browser parses this correctly on its own.
    if (/([+-]\d{2}:?\d{2}|Z)$/i.test(str)) {
        const d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) {
        // Unrecognized format — best-effort fallback (matches the old behavior).
        const fallback = new Date(str.replace(/-/g, '/'));
        return isNaN(fallback.getTime()) ? null : fallback;
    }

    const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
    const second = match[6] ? Number(match[6]) : 0;

    // First pass: treat the wall-clock digits as if they were UTC, then measure
    // how far America/Los_Angeles actually sits from UTC at that instant and
    // shift by that amount. One pass is enough for hour-level display accuracy
    // (it could only be off by up to an hour, and only within the couple of
    // hours around a DST changeover).
    const guessUTC = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMinutes = getTimeZoneOffsetMinutes(SCRAPER_TIMEZONE, new Date(guessUTC));
    return new Date(guessUTC - offsetMinutes * 60000);
}

function getRelativeTimeLabel(timestampStr) {
    const d = parseScraperTimestamp(timestampStr);
    if (!d) return 'the last update';

    const hours = Math.round((Date.now() - d.getTime()) / 3600000);
    if (hours < 1) return 'the last hour';
    if (hours < 36) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

// Builds the "Last Updated" banner text plus a precise tooltip, both
// resolved to the viewer's own clock no matter where they are.
function formatLastUpdatedLabel(timestampStr) {
    const d = parseScraperTimestamp(timestampStr);
    if (!d) return { text: 'Last Updated: unknown', title: '' };

    const diffMs = Date.now() - d.getTime();
    const minutes = Math.round(diffMs / 60000);
    const hours = Math.round(diffMs / 3600000);
    const days = Math.round(hours / 24);

    let text;
    if (minutes < 1) text = 'Last Updated: just now';
    else if (minutes < 60) text = `Last Updated: ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    else if (hours < 36) text = `Last Updated: ${hours} hour${hours === 1 ? '' : 's'} ago`;
    else text = `Last Updated: ${days} day${days === 1 ? '' : 's'} ago`;

    // Exact time, shown in the viewer's own local timezone, as a tooltip for precision.
    const title = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

    return { text, title };
}

// Re-renders the "Last Updated" text from the cached timestamp, so it stays
// fresh ("3 minutes ago" -> "4 minutes ago" ...) without needing a page reload.
function refreshLastUpdatedLabel() {
    const el = document.getElementById('lastUpdated');
    if (!el || !latestTimestampGlobal) return;
    const { text, title } = formatLastUpdatedLabel(latestTimestampGlobal);
    el.innerText = text;
    el.title = title;
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

// --- Favorite stores ---
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
    refreshCurrentDisplay();
}

// Re-renders whichever tab is currently open (and the map markers/popups
// along with it), so a favorite toggle is reflected immediately wherever
// it's visible - same pattern setGasPref already uses.
function refreshCurrentDisplay() {
    const activeTab = document.querySelector('.tab.active');
    if (activeTab) {
        switchTab(activeTab.id.replace('tab-', ''));
    }
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

    // Handle clicking outside to close any open autocomplete dropdown globally
    document.addEventListener('click', (e) => {
        const isInput = e.target.closest('.route-input') || e.target.closest('#searchInput');
        const isDropdown = e.target.closest('.autocomplete-dropdown');
        if (!isInput && !isDropdown) {
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
    if (!query) return [];

    let matches = globalStoreData.filter(s =>
        s.city.toLowerCase().includes(query) ||
        s.address.toLowerCase().includes(query) ||
        s.state.toLowerCase().includes(query)
    );

    // SORT: Prioritize stores closest to the current map view
    if (map) {
        const center = map.getCenter();
        matches.sort((a, b) => {
            const distA = getDistanceMiles(center.lat, center.lng, a.lat, a.lng);
            const distB = getDistanceMiles(center.lat, center.lng, b.lat, b.lng);
            return distA - distB;
        });
    }

    return matches.slice(0, 5);
}

async function getGeoMatches(query) {
    try {
        if (geocodeAbortController) geocodeAbortController.abort();
        geocodeAbortController = new AbortController();

        let url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(query)}`;

        // BIAS RELEVANCE: Tell the geocoder to prioritize results near what the user is currently looking at on the map
        if (map) {
            const bounds = map.getBounds();
            // Nominatim viewbox format is left,top,right,bottom (longitude, latitude)
            const viewbox = `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`;
            url += `&viewbox=${viewbox}`;
        }

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
        administrative: { icon: '📍', label: 'Area' },
        // Added classifications for addresses and streets
        house: { icon: '🏠', label: 'Address' },
        building: { icon: '🏢', label: 'Building' },
        amenity: { icon: '🏢', label: 'Place' },
        road: { icon: '🛣️', label: 'Street' },
        yes: { icon: '🏠', label: 'Address' } // Nominatim sometimes uses 'yes' for precise addresses
    };
    return metaMap[type] || { icon: '📍', label: 'Location' };
}

function shortGeoName(result) {
    const addr = result.address || {};

    // 1. Check if the result is a specific street address or building
    let street = "";
    if (addr.house_number && addr.road) {
        street = `${addr.house_number} ${addr.road}`;
    } else if (addr.road) {
        street = addr.road;
    } else if (addr.amenity || addr.shop || addr.building) {
        street = addr.amenity || addr.shop || addr.building;
    }

    const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || "";
    let state = '';
    if (addr['ISO3166-2-lvl4']) state = addr['ISO3166-2-lvl4'].split('-')[1];
    else if (addr.state) state = addr.state;

    // If we have a specific street-level match, construct a full address label
    if (street) {
        const locationParts = [street];
        if (city) locationParts.push(city);
        if (state) locationParts.push(state);
        return locationParts.join(', ');
    }

    // 2. Fallback logic for broader queries (Cities, Zip Codes, States)
    const main = city || result.display_name.split(',')[0];

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
        let url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;

        // Ensure the actual routing engine uses the same map-biased logic as the autocomplete
        if (map) {
            const bounds = map.getBounds();
            const viewbox = `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`;
            url += `&viewbox=${viewbox}`;
        }

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

function extractLocation(item) {
    return {
        lat: item.type === 'store' ? item.data.lat : parseFloat(item.data.lat),
        lng: item.type === 'store' ? item.data.lng : parseFloat(item.data.lon),
        label: getAutocompleteLabel(item)
    };
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
        routeOriginLocation = extractLocation(item);
    } else if (currentAutocompleteAction === 'routeDest') {
        document.getElementById('routeDestination').value = getAutocompleteLabel(item);
        routeDestLocation = extractLocation(item);
    }

    closeAutocompleteDropdown();
}

function closeAutocompleteDropdown() {
    document.querySelectorAll('.autocomplete-dropdown').forEach(dropdown => {
        dropdown.classList.remove('active');
        dropdown.innerHTML = '';
    });
    autocompleteItems = [];
    activeAutocompleteIndex = -1;
}

// "I'm feeling lucky": called when Enter is pressed but there's nothing in the
// dropdown to select yet - most commonly because the user typed fast and hit
// Enter before the 400ms debounce even fired, so autocompleteItems is still
// empty. Rather than doing nothing, resolve the raw text immediately: check
// local Costco stores first (instant, no network), then fall back to a live
// geocode lookup, and act on whichever comes back first with a match. Reuses
// selectAutocompleteItem so search vs. route-field behavior stays identical
// to actually clicking a dropdown result.
async function resolveBestMatchAndAct(query) {
    if (!query) return;

    let best = null;
    const storeMatches = getStoreMatches(query);
    if (storeMatches.length > 0) {
        best = { type: 'store', data: storeMatches[0] };
    } else {
        const geoMatches = await getGeoMatches(query);
        if (geoMatches.length > 0) {
            best = { type: 'place', data: geoMatches[0] };
        }
    }

    if (!best) {
        showToast(`No matches found for "${query}"`);
        const activeInput = document.getElementById(activeInputId);
        if (activeInput) activeInput.blur();
        return;
    }

    autocompleteItems = [best];
    selectAutocompleteItem(0);
}

// NEW: Reusable autocomplete listener setup
function setupInputAutocomplete(inputId, dropdownId, actionType) {
    const inputEl = document.getElementById(inputId);
    if (!inputEl) return;

    inputEl.addEventListener('input', (e) => {
        activeInputId = inputId;
        activeDropdownId = dropdownId;
        currentAutocompleteAction = actionType;

        // Reset locked-in coordinates if the user starts modifying the text manually
        if (actionType === 'routeOrigin') routeOriginLocation = null;
        if (actionType === 'routeDest') routeDestLocation = null;

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
        const dropdownActive = !!dropdownEl && dropdownEl.classList.contains('active');

        if (e.key === 'ArrowDown' && dropdownActive) {
            e.preventDefault();
            moveAutocompleteSelection(1);
        } else if (e.key === 'ArrowUp' && dropdownActive) {
            e.preventDefault();
            moveAutocompleteSelection(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (dropdownActive && activeAutocompleteIndex >= 0) {
                // User used arrow keys to pick something specific
                selectAutocompleteItem(activeAutocompleteIndex);
            } else if (dropdownActive && autocompleteItems.length > 0) {
                // User just mashed Enter: auto-select the very top result!
                selectAutocompleteItem(0);
            } else {
                // Nothing in the dropdown yet (e.g. Enter beat the debounce) -
                // resolve the typed text directly instead of doing nothing.
                const query = e.target.value.toLowerCase().trim();
                if (query) resolveBestMatchAndAct(query);
            }
        } else if (e.key === 'Escape' && dropdownActive) {
            closeAutocompleteDropdown();
        }
    });

    inputEl.addEventListener('focus', () => {
        if (activeInputId !== inputId) {
            closeAutocompleteDropdown(); // Clean up old dropdown before switching inputs
        }

        activeInputId = inputId;
        activeDropdownId = dropdownId;
        currentAutocompleteAction = actionType;

        const query = inputEl.value.toLowerCase().trim();
        if (query.length > 0) {
            debouncedAutocomplete(query);
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

// Silent geolocation lookup for first page load: only fires if the browser
// reports the permission as already 'granted', so a first-time visitor never
// gets a surprise location prompt just for opening the page. Returns null in
// every other case (unsupported, not yet granted, denied, or timed out) and
// the app falls back to its normal default (fit map to all stores).
async function tryAutoLocateOnLoad() {
    if (!navigator.geolocation || !navigator.permissions || !navigator.permissions.query) return null;

    try {
        const status = await navigator.permissions.query({ name: 'geolocation' });
        if (status.state !== 'granted') return null;
    } catch (e) {
        return null; // Permissions API doesn't support querying 'geolocation' in this browser
    }

    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
            () => resolve(null),
            { maximumAge: 10 * 60 * 1000, timeout: 5000 }
        );
    });
}

// Picks the state of whichever known store is geographically closest to `loc`,
// used to default the "Lowest Prices" leaderboard to a sensible state.
function updateClosestStoreState(loc) {
    if (!loc || globalStoreData.length === 0) return;
    let closestStore = globalStoreData.find(s => s.lat && s.lng) || globalStoreData[0];
    let minDistance = Infinity;
    globalStoreData.forEach(s => {
        if (!s.lat || !s.lng) return;
        const distance = Math.pow(s.lat - loc.lat, 2) + Math.pow(s.lng - loc.lng, 2);
        if (distance < minDistance) {
            minDistance = distance;
            closestStore = s;
        }
    });
    currentStateContext = closestStore.state;
}

// Drops the "You are here" pin used both for the manual Detect Location
// button and the silent auto-locate on first load.
function placeUserLocationMarker(loc, { openPopup = false } = {}) {
    const marker = L.circleMarker([loc.lat, loc.lng], {
        radius: 8, fillColor: "#3b82f6", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
    }).addTo(map).bindPopup("<b>You are here!</b>");
    if (openPopup) marker.openPopup();
    return marker;
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

        // Detect if we are looking at the NEW backend format or the OLD backend format
        if (latestData.timestamp && latestData.prices) {
            latestTimestamp = latestData.timestamp;
            timestampedPrices = latestData.prices;
            previousPrices = latestData.previous || {};
            previousTimestamp = latestData.previous_timestamp || null;
        } else {
            // OLD FORMAT FALLBACK: Keeps the app from crashing before your new Python script runs!
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

        // If we're allowed to silently know where the user is, use it: set
        // userLocation *before* switching tabs so the Nearby tab renders real
        // results immediately instead of its "Detect Location" prompt.
        if (autoLocation) {
            userLocation = autoLocation;
            updateClosestStoreState(autoLocation);
            placeUserLocationMarker(autoLocation);
        }

        switchTab('nearby');

        const openedSharedStore = openSharedStoreIfPresent();

        if (!openedSharedStore) {
            if (autoLocation) {
                map.setView([autoLocation.lat, autoLocation.lng], 10);
                checkZoomLevel();
            } else if (globalStoreData.length > 0) {
                const bounds = L.latLngBounds(globalStoreData.map(s => [s.lat, s.lng]).filter(coords => coords[0] && coords[1]));
                map.fitBounds(bounds, { padding: [30, 30] });
                checkZoomLevel();
            }
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
            <button class="popup-btn popup-btn-outline" style="margin-top:8px;" onclick="toggleFavoriteStore('${store.state}', '${safeCity}')">${isFav ? '★ Remove Favorite' : '☆ Add to Favorites'}</button>
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

function renderStoresList(searchTerm) {
    const container = document.getElementById("sidebarContent");
    container.innerHTML = "";

    let filtered = globalStoreData.filter(s =>
        s.city.toLowerCase().includes(searchTerm) ||
        s.address.toLowerCase().includes(searchTerm) ||
        s.state.toLowerCase().includes(searchTerm)
    );

    // SORT: Make the sidebar list also prioritize by distance to the map view
    if (map && filtered.length > 0) {
        const center = map.getCenter();
        filtered.sort((a, b) => {
            const distA = getDistanceMiles(center.lat, center.lng, a.lat, a.lng);
            const distB = getDistanceMiles(center.lat, center.lng, b.lat, b.lng);
            return distA - distB;
        });
    }

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

function renderFavoriteStores() {
    const container = document.getElementById("sidebarContent");
    container.innerHTML = "";

    const favorites = globalStoreData
        .filter(s => isFavoriteStore(s.state, s.city))
        .sort((a, b) => a.city.localeCompare(b.city));

    if (favorites.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; margin-top:50px;">
                <div style="font-size:40px; margin-bottom:10px;">☆</div>
                <h3 style="margin-bottom: 5px;">No Favorites Yet</h3>
                <p style="color:var(--text-muted); font-size:14px; padding: 0 10px;">Tap the ☆ on any store card or map popup to save it here for quick access.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `<div class="leaderboard-header">★ Favorite Stores (${favorites.length})</div>`;
    favorites.forEach(store => container.appendChild(createStoreCard(store, gasPref)));
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
    const isFav = isFavoriteStore(store.state, store.city);

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

// --- Route feature: UI + orchestration ---

function renderRoutePanel() {
    const container = document.getElementById("sidebarContent");
    const originVal = lastRouteState ? escapeHtml(lastRouteState.originText) : '';
    const destVal = lastRouteState ? escapeHtml(lastRouteState.destText) : '';
    const buffer = lastRouteState ? lastRouteState.bufferMiles : 2;

    let saveButtonHtml = '';
    if (editingRouteId !== null) {
        // Cancel must always be reachable while editing, even if the most recent
        // findGasAlongRoute() call failed (bad geocode, OSRM hiccup, etc.) and
        // left lastRouteState stale/null — otherwise there'd be no way out of edit mode.
        const updateBtn = lastRouteState
            ? `<button class="btn-action save-route-btn" onclick="saveCurrentRouteAsFavorite()">💾 Update Route</button>`
            : '';
        saveButtonHtml = `
            ${updateBtn}
            <button class="btn-action cancel-edit-btn" onclick="cancelEditRoute()">✕ Cancel Editing</button>
        `;
    } else if (lastRouteState) {
        saveButtonHtml = `<button class="btn-action save-route-btn" onclick="saveCurrentRouteAsFavorite()">☆ Save This Route</button>`;
    }

    const savedRoutesHtml = favoriteRoutes.length > 0 ? `
        <div style="margin-top:16px;">
            <div class="leaderboard-header">★ Saved Routes</div>
            ${favoriteRoutes.map(r => `
                <div class="store-card ${r.id === editingRouteId ? 'route-editing' : ''}" style="cursor:pointer;" onclick="loadFavoriteRoute(${r.id})">
                    <h3><span>${escapeHtml(r.origin.label)} → ${escapeHtml(r.destination.label)}</span></h3>
                    <div class="address">Within ${r.bufferMiles} mi of route${r.id === editingRouteId ? ' &middot; <strong>Editing…</strong>' : ''}</div>
                    <div class="card-actions">
                        <button class="btn-action" style="flex:1; background: transparent; color: var(--costco-blue); border: 2px solid var(--costco-blue);"
                            onclick="event.stopPropagation(); loadFavoriteRoute(${r.id})">
                            🛣️ Load
                        </button>
                        <button class="btn-action share-btn" title="Edit saved route"
                            onclick="event.stopPropagation(); startEditRoute(${r.id})">
                            ✎
                        </button>
                        <button class="btn-action share-btn" title="Remove saved route"
                            onclick="event.stopPropagation(); removeFavoriteRoute(${r.id})">
                            🗑
                        </button>
                    </div>
                </div>
            `).join('')}
        </div>
    ` : '';

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
                   min="1" max="25" step="1" value="${buffer}">
            <button class="btn-action" style="width:100%; justify-content:center;" onclick="findGasAlongRoute()">🛣️ Find Cheapest Along Route</button>
            ${saveButtonHtml}
        </div>
        ${savedRoutesHtml}
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

// --- Favorite routes ---
function saveCurrentRouteAsFavorite() {
    if (!lastRouteState) return;
    const { origin, destination, bufferMiles } = lastRouteState;

    // If we're editing an existing favorite, update it in place rather than
    // adding a new entry.
    if (editingRouteId !== null) {
        const target = favoriteRoutes.find(r => r.id === editingRouteId);
        if (!target) {
            // The route being edited was removed from elsewhere; fall through
            // and treat this as a normal save instead.
            editingRouteId = null;
        } else {
            const isDuplicateOfOther = favoriteRoutes.some(r =>
                r.id !== editingRouteId &&
                r.origin.label === origin.label && r.destination.label === destination.label && r.bufferMiles === bufferMiles
            );
            if (isDuplicateOfOther) {
                showToast('Another saved route already matches these values');
                return;
            }

            target.origin = origin;
            target.destination = destination;
            target.bufferMiles = bufferMiles;
            localStorage.setItem('favoriteRoutes', JSON.stringify(favoriteRoutes));
            editingRouteId = null;
            showToast('✓ Route updated');
            renderRoutePanel();
            return;
        }
    }

    const isDuplicate = favoriteRoutes.some(r =>
        r.origin.label === origin.label && r.destination.label === destination.label && r.bufferMiles === bufferMiles
    );
    if (isDuplicate) {
        showToast('This route is already saved');
        return;
    }

    favoriteRoutes.push({ id: Date.now(), origin, destination, bufferMiles });
    localStorage.setItem('favoriteRoutes', JSON.stringify(favoriteRoutes));
    showToast('★ Route saved');
    renderRoutePanel();
}

function removeFavoriteRoute(id) {
    favoriteRoutes = favoriteRoutes.filter(r => r.id !== id);
    localStorage.setItem('favoriteRoutes', JSON.stringify(favoriteRoutes));

    if (editingRouteId === id) {
        // The favorite being edited was just deleted out from under the edit -
        // exit edit mode the same way Cancel does, restoring the pre-edit view.
        cancelEditRoute();
    } else {
        renderRoutePanel();
    }
}

async function loadFavoriteRoute(id) {
    const route = favoriteRoutes.find(r => r.id === id);
    if (!route) return;

    editingRouteId = null; // loading a route (rather than editing) exits edit mode
    editSnapshot = null;

    // Setting the inputs to the resolved label (not whatever raw text was
    // originally typed) guarantees it matches routeOriginLocation/routeDestLocation
    // exactly, so findGasAlongRoute() reuses these cached coordinates instead
    // of re-geocoding from scratch.
    document.getElementById('routeOrigin').value = route.origin.label;
    document.getElementById('routeDestination').value = route.destination.label;
    document.getElementById('routeBuffer').value = route.bufferMiles;
    routeOriginLocation = { ...route.origin };
    routeDestLocation = { ...route.destination };

    await findGasAlongRoute();
    renderRoutePanel(); // refresh so the Save button reflects the freshly loaded route
}

async function startEditRoute(id) {
    const route = favoriteRoutes.find(r => r.id === id);
    if (!route) return;

    // Snapshot whatever was on screen before editing began, so Cancel can put
    // it back exactly. Only take the snapshot when entering edit mode fresh -
    // switching the Edit button between two saved routes without saving or
    // cancelling shouldn't overwrite it with mid-edit state.
    if (editingRouteId === null) {
        editSnapshot = { lastRouteState, routeOriginLocation, routeDestLocation };
    }

    editingRouteId = id;
    // Clone the saved origin/destination rather than pointing at them directly -
    // otherwise lastRouteState.origin and favoriteRoutes[i].origin are the same
    // object, and any future in-place mutation of one silently corrupts the other.
    routeOriginLocation = { ...route.origin };
    routeDestLocation = { ...route.destination };

    document.getElementById('routeOrigin').value = route.origin.label;
    document.getElementById('routeDestination').value = route.destination.label;
    document.getElementById('routeBuffer').value = route.bufferMiles;

    await findGasAlongRoute();
    renderRoutePanel(); // switches the Save button into "Update Route" / "Cancel" mode
}

function cancelEditRoute() {
    editingRouteId = null;

    if (editSnapshot) {
        lastRouteState = editSnapshot.lastRouteState;
        routeOriginLocation = editSnapshot.routeOriginLocation;
        routeDestLocation = editSnapshot.routeDestLocation;
        editSnapshot = null;
    }

    // Put the map/results back to whatever they showed before editing began,
    // rather than leaving the in-progress (unsaved) edit on screen.
    if (routeLayer) routeLayer.clearLayers();
    if (lastRouteState && lastRouteState.along) {
        renderRouteOnMap(lastRouteState.route.coords, lastRouteState.origin, lastRouteState.destination);
        renderMap(lastRouteState.along.length > 0 ? lastRouteState.along : globalStoreData);
    } else {
        renderMap(globalStoreData);
    }

    renderRoutePanel();
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
                originInput.value = 'Your location';
                routeOriginLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    label: 'Your location'
                };
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
        // Use exactly what was locked in from the autocomplete dropdown, or fall back to geocoding if manually typed
        const origin = (routeOriginLocation && routeOriginLocation.label.toLowerCase() === originText.toLowerCase())
            ? routeOriginLocation
            : await geocodeAddress(originText);

        const destination = (routeDestLocation && routeDestLocation.label.toLowerCase() === destText.toLowerCase())
            ? routeDestLocation
            : await geocodeAddress(destText);

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
    document.getElementById('tab-favorites')?.classList.remove('active');

    // Leaving the Route tab: clear the route line, restore full map markers,
    // and drop out of any in-progress route edit.
    if (tabName !== 'route' && routeLayer) {
        routeLayer.clearLayers();
        if (globalStoreData.length > 0) renderMap(globalStoreData);
    }
    if (tabName !== 'route') {
        editingRouteId = null;
        editSnapshot = null;
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
    } else if (tabName === 'favorites') {
        document.getElementById('tab-favorites')?.classList.add('active');
        renderFavoriteStores();
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

            placeUserLocationMarker(userLocation, { openPopup: true });
            map.flyTo([userLocation.lat, userLocation.lng], 10, {duration: 2});
            updateClosestStoreState(userLocation);
            switchTab('nearby');
        },
        (error) => alert("Unable to retrieve your location. Check browser permissions.")
    );
}

initPreferences();
initMap();
loadData();
setInterval(refreshLastUpdatedLabel, 60000);