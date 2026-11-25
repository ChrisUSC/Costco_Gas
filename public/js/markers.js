// --- Station pins: clustering, price colours and legend, popups, and redrawing the map ---

import {
    DIRECTIONS_ICON,
    favoriteButtonHtml,
    fillUpHtml,
    phoneLinkHtml,
    priceTilesHtml,
    shareButtonHtml
} from './components.js';
import { debounce, escapeHtml, prefersReducedMotion } from './dom.js';
import { gasHoursDetailsHtml, gasStatusHtml } from './hours.js';
import { icon } from './icons.js';
import { isMobileViewport } from './layout.js';
import { map } from './map.js';
import { syncUrl } from './nav.js';
import {
    filterStoresForCurrentGrade,
    formatPriceDisplay,
    GRADE_INFO,
    gradeStr,
    gradeVal,
    hasGradeData
} from './prices.js';
import { openMobileStoreCard, sheetAwareCenter } from './sheet.js';
import { findStore, isFavoriteStore, state } from './state.js';
import { DIRECTIONS_APP_LABELS, directionsUrl, formatAddress } from './stores.js';
import { refreshCurrentDisplay } from './tabs.js';

let markersLayer;
let storeMarkers = []; // markers currently in markersLayer
export let popupStore = null; // station whose desktop popup is open (for the URL)

// From this zoom every station shows its own pin (below it, with clustering on, nearby
// stations merge into bubbles: country and multi-state views).
const CLUSTER_UNTIL_ZOOM = 8;

// Called once by initMap(): the pin layer, the price legend, and the hooks that keep pin
// colours and the URL's ?store= in step with the map.
export function initMarkers() {
    markersLayer = createMarkersLayer().addTo(map);
    addPriceLegend();
    map.on('moveend', debounce(updatePinTiers, 80));
    map.on('popupopen', (e) => { popupStore = e.popup._source?.options.store || null; syncUrl(); });
    map.on('popupclose', () => { popupStore = null; syncUrl(); });
}

// Below CLUSTER_UNTIL_ZOOM nearby stations merge into a bubble showing how many there are and
// the cheapest price among them. Falls back to plain markers if the plugin failed to load.
function createMarkersLayer() {
    if (!state.clusterMarkers || typeof L.markerClusterGroup !== 'function') return L.layerGroup();
    return L.markerClusterGroup({
        disableClusteringAtZoom: CLUSTER_UNTIL_ZOOM,
        maxClusterRadius: 44, // tighter bubbles break apart sooner as you zoom in
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
export function rebuildMarkersLayer() {
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
export function updatePinTiers() {
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

export function storePopupHtml(store) {
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
        ${fillUpHtml(store)}
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

export function renderMap(dataArray) {
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

// The stations the map should show: the route's stations on the Route tab, otherwise all.
function currentMapData() {
    return state.currentTab === 'route' && state.lastRouteState?.along?.length > 0
        ? state.lastRouteState.along
        : state.stores;
}

// Rebuilding the markers removes the one whose desktop popup is open, which closes it.
// Re-open it afterwards (if that station is still on the map) so the user keeps their place.
export function refreshMapAndList() {
    const openPopupStore = popupStore;
    if (state.stores.length > 0) renderMap(currentMapData());
    refreshCurrentDisplay();
    if (!openPopupStore || isMobileViewport()) return;
    const marker = findStore(openPopupStore.state, openPopupStore.city)?.leafletMarker;
    if (marker && marker._map) marker.openPopup();
}
