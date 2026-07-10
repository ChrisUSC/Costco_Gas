let map;
let mapTileLayer;
let markersLayer;
let globalStoreData = [];
let globalHistory = {};
let priceChartInstance = null;
let trendBaselineLabel = 'the last update';

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
let activeInputId = 'searchInput';
let activeDropdownId = 'autocompleteDropdown';
let currentAutocompleteAction = 'search'; // 'search' | 'routeOrigin' | 'routeDest'

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

function getRelativeTimeLabel(timestampStr) {
    if (!timestampStr) return 'the last update';
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
        await navigator.clipboard.writeText(
