// --- The Leaflet map: creation, tiles, moving the map, location markers and the offline outline ---

import { escapeHtml, prefersReducedMotion } from './dom.js';
import { isMobileViewport } from './layout.js';
import { setSearchAreaVisible } from './map-interactions.js';
import { initMarkers } from './markers.js';
import {
    closeMobileStoreCard,
    openMobileStoreCard,
    setMobileView,
    sheetAwareCenter
} from './sheet.js';
import { state } from './state.js';
import { switchTab } from './tabs.js';

const CARTO_API_KEY = 'cb1_2q9b_1_6d41dfc2a130168400103206';
export let map;
let mapTileLayer;
export let routeLayer;
let userLocationMarker = null;
let searchLocationMarker = null;

// From this zoom each pin also shows its price.
const PIN_ZOOM = 9;

export function initMap() {
    // doubleClickZoom is replaced by setupDoubleTapZoom(), which also handles touch reliably.
    map = L.map('map', { zoomControl: false, doubleClickZoom: false }).setView([39.8283, -98.5795], 4);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    setMapTiles();
    initMarkers();
    routeLayer = L.layerGroup().addTo(map);

    map.on('zoomend', checkZoomLevel);
    map.on('click', () => {
        if (state.activeMobileStore) closeMobileStoreCard();
    });
}

export function setMapTiles() {
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

export function checkZoomLevel() {
    if (!map) return;
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.classList.toggle('map-show-prices', map.getZoom() >= PIN_ZOOM);
}

// Animated fly-to, or an instant jump when the user prefers reduced motion.
export function moveMapTo(latlng, zoom, duration) {
    if (prefersReducedMotion()) {
        map.setView(latlng, zoom, { animate: false });
    } else {
        map.flyTo(latlng, zoom, { duration });
    }
}

export function placeUserLocationMarker(loc, { openPopup = false } = {}) {
    if (userLocationMarker && map) map.removeLayer(userLocationMarker);
    userLocationMarker = L.circleMarker([loc.lat, loc.lng], {
        radius: 8, fillColor: "#3b82f6", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
    }).addTo(map).bindPopup("<b>You are here!</b>");
    if (openPopup && !isMobileViewport()) userLocationMarker.openPopup();
    return userLocationMarker;
}

// Orange marker for a searched place or the "Search this area" centre (one at a time).
export function placeSearchMarker(latlng, popupHtml) {
    if (searchLocationMarker) map.removeLayer(searchLocationMarker);
    searchLocationMarker = L.circleMarker(latlng, {
        radius: 8, fillColor: "#f59e0b", color: "#ffffff", weight: 3, opacity: 1, fillOpacity: 1
    }).addTo(map).bindPopup(popupHtml);
}

export function flyToStore(store) {
    if (isMobileViewport()) {
        openMobileStoreCard(store); // first, so the map can centre above the card
        moveMapTo(sheetAwareCenter(L.latLng(store.lat, store.lng), 14), 14, 1.2);
        return;
    }
    // Register first: with reduced motion the move (and its moveend) completes synchronously.
    map.once('moveend', () => store.leafletMarker && store.leafletMarker.openPopup());
    moveMapTo([store.lat, store.lng], 14, 1.5);
}

export function flyToGeoResult(result) {
    if (isMobileViewport()) {
        closeMobileStoreCard();
        setMobileView('map');
    }

    const [south, north, west, east] = result.boundingbox.map(parseFloat);

    state.userLocation = { lat: parseFloat(result.lat), lng: parseFloat(result.lon) };

    placeSearchMarker([state.userLocation.lat, state.userLocation.lng], `<b>${escapeHtml(result.display_name.split(',')[0])}</b>`);

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

// Built-in outline of the US (us-outline.json, saved for offline use) under the pins, in
// a pane below the map tiles: any tiles the browser still has draw on top of it.
let offlineBaseLayer = null;
let outlineRequest = null;

export async function updateOfflineBasemap() {
    if (!map) return;
    if (!state.offline) {
        if (offlineBaseLayer) map.removeLayer(offlineBaseLayer);
        return;
    }
    if (!offlineBaseLayer) {
        try {
            outlineRequest ||= fetch('us-outline.json').then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
            const outline = await outlineRequest;
            if (!map.getPane('offlineBase')) {
                const pane = map.createPane('offlineBase');
                pane.style.zIndex = 150; // below the tile pane (200)
                pane.style.pointerEvents = 'none';
            }
            offlineBaseLayer = L.geoJSON(outline, { pane: 'offlineBase', interactive: false, style: () => ({ className: 'offline-land' }) });
        } catch (e) {
            outlineRequest = null;
            return;
        }
    }
    if (state.offline && !map.hasLayer(offlineBaseLayer)) offlineBaseLayer.addTo(map);
}
