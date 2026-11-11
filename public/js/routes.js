// --- Route Feature: OSRM Driving Route, Corridor Filtering & Saved Routes ---

import {
    getDistanceMiles,
    minDistanceToRouteMiles,
    getRouteBoundsPadded,
    escapeHtml,
    showToast,
    requestBrowserLocation,
    getLocationIfGranted,
    GRADE_INFO,
    gradeVal,
    hasGradeData
} from './utils.js';
import {
    state,
    saveFavoriteRoute,
    updateFavoriteRoute,
    removeFavoriteRoute
} from './state.js';
import { createStoreCard, renderSavedRoutesHtml, appendPagedCards, skeletonCardsHtml } from './components.js';
import { geocodeAddress, setupInputAutocomplete } from './search.js';
import { icon } from './icons.js';

let routesContext = {
    getMap: () => null,
    getRouteLayer: () => null,
    renderMap: () => {},
    switchTab: () => {},
    setMobileView: () => {}
};

export function initRoutes(context) {
    routesContext = { ...routesContext, ...context };
}

export async function fetchDrivingRoute(origin, destination) {
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

export function renderRoutePanel() {
    const container = document.getElementById("sidebarContent");
    if (!container) return;

    // Before any route is shown, keep places already chosen (e.g. the prefilled
    // "Your location") when the panel re-renders after a grade or favorite change.
    const originVal = escapeHtml(state.lastRouteState ? state.lastRouteState.originText : state.routeOriginLocation?.label || '');
    const destVal = escapeHtml(state.lastRouteState ? state.lastRouteState.destText : state.routeDestLocation?.label || '');
    const buffer = state.lastRouteState ? state.lastRouteState.bufferMiles : 2;

    let saveButtonHtml = '';
    if (state.editingRouteId !== null) {
        const updateBtn = state.lastRouteState
            ? `<button type="button" class="btn btn-secondary btn-block save-route-btn" data-action="route-save">${icon('save', 16)} Update route</button>`
            : '';
        saveButtonHtml = `
            ${updateBtn}
            <button type="button" class="btn btn-ghost btn-block cancel-edit-btn" data-action="route-cancel-edit">Cancel editing</button>
        `;
    } else if (state.lastRouteState) {
        saveButtonHtml = `<button type="button" class="btn btn-secondary btn-block save-route-btn" data-action="route-save">${icon('star', 16)} Save this route</button>`;
    }

    const savedRoutesHtml = state.favoriteRoutes.length > 0
        ? `<div>${renderSavedRoutesHtml({ fromFavorites: false })}</div>`
        : '';

    container.innerHTML = `
        <div class="route-panel">
            <label for="routeOrigin">From</label>
            <div class="route-input-row">
                <input type="text" id="routeOrigin" class="input route-input" placeholder="Address or city" autocomplete="off" value="${originVal}">
                <button type="button" class="btn btn-icon btn-bordered route-locate-btn" data-action="route-locate" title="Use my location" aria-label="Use my location">${icon('locate', 16)}</button>
                <div id="routeOriginDropdown" class="autocomplete-dropdown"></div>
            </div>

            <label for="routeDestination">To</label>
            <div class="route-input-row">
                <input type="text" id="routeDestination" class="input route-input" placeholder="Address or city" autocomplete="off" value="${destVal}">
                <div id="routeDestDropdown" class="autocomplete-dropdown"></div>
            </div>

            <label for="routeBuffer">Detour limit (miles from the route)</label>
            <div class="route-input-row">
                <input type="number" id="routeBuffer" class="input route-input" inputmode="numeric"
                       min="1" max="25" step="1" value="${buffer}">
            </div>
            <button type="button" class="btn btn-primary btn-block" data-action="route-find">${icon('route', 16)} Find cheapest along route</button>
            ${saveButtonHtml}
        </div>
        ${savedRoutesHtml}
        <div id="routeResultsContainer"></div>
    `;

    setupInputAutocomplete('routeOrigin', 'routeOriginDropdown', 'routeOrigin');
    setupInputAutocomplete('routeDestination', 'routeDestDropdown', 'routeDest');
    prefillOriginFromDevice();

    if (state.lastRouteState && state.lastRouteState.along) {
        renderRouteResults(state.lastRouteState);
        renderRouteOnMap(state.lastRouteState.route.coords, state.lastRouteState.origin, state.lastRouteState.destination);
        routesContext.renderMap(state.lastRouteState.along.length > 0 ? state.lastRouteState.along : state.stores);
    }
}

// --- Start the route from the user's location ---
// If the user has already allowed location access (and "Use my location automatically" is
// on), an empty "From" field starts as "Your location". This never shows the browser's
// permission prompt. The location lookup runs once per page load (a failed fix isn't
// retried on every re-render), and the field is filled at most once, so clearing it sticks.
const YOUR_LOCATION = 'Your location';
let originLookupTried = false;
let originPrefilled = false;

function originIsEmpty() {
    const input = document.getElementById('routeOrigin');
    return Boolean(input) && !input.value.trim() && !state.routeOriginLocation && !state.lastRouteState;
}

function fillOrigin(loc) {
    const input = document.getElementById('routeOrigin');
    if (!loc || !input || state.currentTab !== 'route' || !originIsEmpty()) return;
    originPrefilled = true;
    state.routeOriginLocation = { lat: loc.lat, lng: loc.lng, label: YOUR_LOCATION };
    input.value = YOUR_LOCATION;
}

async function prefillOriginFromDevice() {
    if (originPrefilled || !state.autoLocate || !originIsEmpty()) return;
    // Already looked once: only a position the device has given since (e.g. "Near me")
    // can fill it now, without asking again.
    if (originLookupTried) {
        fillOrigin(state.deviceLocation);
        return;
    }
    originLookupTried = true;

    const input = document.getElementById('routeOrigin');
    const placeholder = input.placeholder;
    input.placeholder = 'Finding your location…';
    // A position from the device earlier this session also proves access was allowed
    // (and covers browsers whose Permissions API doesn't report geolocation).
    const loc = (await getLocationIfGranted({ maxAgeMs: 60 * 1000 })) || state.deviceLocation;
    if (loc) state.deviceLocation = { lat: loc.lat, lng: loc.lng };

    // The panel is re-rendered on many changes, so look the field up again.
    const current = document.getElementById('routeOrigin');
    if (current) current.placeholder = placeholder;
    fillOrigin(loc);
}

export function saveCurrentRouteAsFavorite() {
    if (!state.lastRouteState) return;
    const { origin, destination, bufferMiles } = state.lastRouteState;
    const matchesRoute = r =>
        r.origin.label === origin.label &&
        r.destination.label === destination.label &&
        r.bufferMiles === bufferMiles;

    if (state.editingRouteId !== null) {
        const target = state.favoriteRoutes.find(r => r.id === state.editingRouteId);
        if (!target) {
            state.editingRouteId = null;
        } else {
            if (state.favoriteRoutes.some(r => r.id !== state.editingRouteId && matchesRoute(r))) {
                showToast('Another saved route already matches these values');
                return;
            }
            updateFavoriteRoute(state.editingRouteId, { origin, destination, bufferMiles });
            state.editingRouteId = null;
            showToast('✓ Route updated');
            renderRoutePanel();
            return;
        }
    }

    if (state.favoriteRoutes.some(matchesRoute)) {
        showToast('This route is already saved');
        return;
    }

    saveFavoriteRoute({ id: Date.now(), origin, destination, bufferMiles });
    showToast('★ Route saved');
    renderRoutePanel();
}

export function removeFavoriteRouteHandler(id) {
    removeFavoriteRoute(id);
    if (state.editingRouteId === id) {
        cancelEditRoute();
    } else {
        renderRoutePanel();
    }
}

export function populateRouteInputsFromSaved(route) {
    state.routeOriginLocation = { ...route.origin };
    state.routeDestLocation = { ...route.destination };
    const originEl = document.getElementById('routeOrigin');
    const destEl = document.getElementById('routeDestination');
    const bufferEl = document.getElementById('routeBuffer');

    if (originEl) originEl.value = route.origin.label;
    if (destEl) destEl.value = route.destination.label;
    if (bufferEl) bufferEl.value = route.bufferMiles;
}

// A saved route that starts (or ends) at "Your location" means wherever the user is now,
// not where they were when they saved it. Uses the position only if location access is
// already allowed (no prompt); otherwise keeps the saved coordinates and says so.
async function withCurrentLocation(route) {
    const isHere = loc => loc?.label === YOUR_LOCATION;
    if (!isHere(route.origin) && !isHere(route.destination)) return route;

    // A fresh position: the user may be far from where they last were. If it can't be had in
    // time, the last device position is still a better guess than where the route was saved.
    const here = (await getLocationIfGranted({ maxAgeMs: 0 })) || state.deviceLocation;
    if (!here) {
        showToast(`Couldn't get your current location, so "${YOUR_LOCATION}" is where you saved this route`, 5000);
        return route;
    }
    state.deviceLocation = { lat: here.lat, lng: here.lng };
    const current = loc => (isHere(loc) ? { lat: here.lat, lng: here.lng, label: YOUR_LOCATION } : loc);
    return { ...route, origin: current(route.origin), destination: current(route.destination) };
}

export async function loadFavoriteRoute(id) {
    const saved = state.favoriteRoutes.find(r => r.id === id);
    if (!saved) return;
    const route = await withCurrentLocation(saved);

    state.editingRouteId = null;
    state.editSnapshot = null;
    populateRouteInputsFromSaved(route);

    await findGasAlongRoute();
    if (state.currentTab === 'route') renderRoutePanel();
}

export async function startEditRoute(id) {
    const saved = state.favoriteRoutes.find(r => r.id === id);
    if (!saved) return;
    const route = await withCurrentLocation(saved);

    if (state.editingRouteId === null) {
        state.editSnapshot = {
            lastRouteState: state.lastRouteState,
            routeOriginLocation: state.routeOriginLocation,
            routeDestLocation: state.routeDestLocation
        };
    }

    state.editingRouteId = id;
    populateRouteInputsFromSaved(route);

    await findGasAlongRoute();
    if (state.currentTab === 'route') renderRoutePanel();
}

export function cancelEditRoute() {
    state.editingRouteId = null;

    if (state.editSnapshot) {
        state.lastRouteState = state.editSnapshot.lastRouteState;
        state.routeOriginLocation = state.editSnapshot.routeOriginLocation;
        state.routeDestLocation = state.editSnapshot.routeDestLocation;
        state.editSnapshot = null;
    }

    clearRouteVisuals();
    if (state.lastRouteState && state.lastRouteState.along) {
        renderRouteOnMap(state.lastRouteState.route.coords, state.lastRouteState.origin, state.lastRouteState.destination);
        routesContext.renderMap(state.lastRouteState.along.length > 0 ? state.lastRouteState.along : state.stores);
    } else {
        routesContext.renderMap(state.stores);
    }

    renderRoutePanel();
}

export function clearRouteVisuals() {
    const routeLayer = routesContext.getRouteLayer();
    if (routeLayer) routeLayer.clearLayers();
}

export function renderRouteResults(routeState) {
    const el = document.getElementById('routeResultsContainer');
    if (!el) return;
    const gradeLabel = GRADE_INFO[state.gasPref].label;
    const { along, route, bufferMiles } = routeState;

    const sorted = along
        .filter(s => hasGradeData(s, state.gasPref))
        .sort((a, b) => gradeVal(a, state.gasPref) - gradeVal(b, state.gasPref));

    let html = '';
    if (route.isApproximate) {
        html += `<p class="route-warning">${icon('alert', 16)} <span>Live routing was unavailable, so this is an approximate straight-line path, not a real driving route.</span></p>`;
    }
    html += `
        <div class="route-summary">${Math.round(route.distanceMiles)} mi route &middot; ${sorted.length} station${sorted.length === 1 ? '' : 's'} found</div>
        <button type="button" class="btn btn-secondary btn-block view-route-map-btn" data-action="view-route-map">
            ${icon('map', 16)} View route on map
        </button>
    `;
    el.innerHTML = html;

    if (sorted.length === 0) {
        el.innerHTML += `<p class="empty-msg">No Costco gas stations found within ${bufferMiles} miles of this route.</p>`;
        return;
    }

    el.innerHTML += `<div class="leaderboard-header">Cheapest ${gradeLabel} along the way</div>`;
    appendPagedCards(el, sorted,
        (store, index) => createStoreCard(store, { highlight: state.gasPref, index, showDistance: true, distanceSuffix: ' off route' }),
        { key: `route|${routeState.originText}|${routeState.destText}|${bufferMiles}|${state.gasPref}` });
}

export function renderRouteOnMap(routeCoords, origin, destination) {
    const routeLayer = routesContext.getRouteLayer();
    const map = routesContext.getMap();
    if (!routeLayer || !map) return;

    routeLayer.clearLayers();
    L.polyline(routeCoords, { color: '#005DAA', weight: 5, opacity: 0.7 }).addTo(routeLayer);
    L.circleMarker([origin.lat, origin.lng], { radius: 8, fillColor: '#059669', color: '#fff', weight: 3, opacity: 1, fillOpacity: 1 })
        .addTo(routeLayer).bindPopup(`<b>Start:</b> ${escapeHtml(origin.label)}`);
    L.circleMarker([destination.lat, destination.lng], { radius: 8, fillColor: '#E31837', color: '#fff', weight: 3, opacity: 1, fillOpacity: 1 })
        .addTo(routeLayer).bindPopup(`<b>End:</b> ${escapeHtml(destination.label)}`);

    map.fitBounds(L.latLngBounds(routeCoords), { padding: [40, 40] });
}

export function useMyLocationForRoute() {
    requestBrowserLocation((position) => {
        const { latitude: lat, longitude: lng } = position.coords;
        state.deviceLocation = { lat, lng };
        const originInput = document.getElementById('routeOrigin');
        if (originInput) {
            originInput.value = YOUR_LOCATION;
            state.routeOriginLocation = { lat, lng, label: YOUR_LOCATION };
        }
    });
}

export async function findGasAlongRoute() {
    const originEl = document.getElementById('routeOrigin');
    const destEl = document.getElementById('routeDestination');
    const bufferEl = document.getElementById('routeBuffer');
    const resultsEl = document.getElementById('routeResultsContainer');

    if (!originEl || !destEl || !bufferEl || !resultsEl) return;

    const originText = originEl.value.trim();
    const destText = destEl.value.trim();
    const bufferInput = bufferEl.value;
    const bufferMiles = parseFloat(bufferInput);

    if (!originText || !destText) {
        resultsEl.innerHTML = `<p class="route-error">Enter both a starting point and a destination.</p>`;
        return;
    }

    if (!bufferInput || isNaN(bufferMiles) || bufferMiles <= 0) {
        resultsEl.innerHTML = `<p class="route-error">Enter a valid search distance greater than 0.</p>`;
        return;
    }

    resultsEl.innerHTML = `<p class="route-summary">Calculating route…</p>${skeletonCardsHtml(3)}`;

    try {
        const origin = (state.routeOriginLocation && state.routeOriginLocation.label.toLowerCase() === originText.toLowerCase())
            ? state.routeOriginLocation
            : await geocodeAddress(originText);

        const destination = (state.routeDestLocation && state.routeDestLocation.label.toLowerCase() === destText.toLowerCase())
            ? state.routeDestLocation
            : await geocodeAddress(destText);

        if (!origin) throw new Error(`Couldn't find "${originText}". Try a more specific address or city.`);
        if (!destination) throw new Error(`Couldn't find "${destText}". Try a more specific address or city.`);

        const route = await fetchDrivingRoute(origin, destination);
        const bounds = getRouteBoundsPadded(route.coords, bufferMiles);

        const along = state.stores
            .filter(s => s.lat && s.lng &&
                s.lat >= bounds.minLat && s.lat <= bounds.maxLat &&
                s.lng >= bounds.minLng && s.lng <= bounds.maxLng)
            .map(s => ({ ...s, distance: minDistanceToRouteMiles(s.lat, s.lng, route.coords) }))
            .filter(s => s.distance <= bufferMiles);

        state.lastRouteState = { originText, destText, bufferMiles, origin, destination, route, along };
        // The user may have switched tabs while the route was loading; the result is kept
        // and shown when they come back to the Route tab.
        if (state.currentTab === 'route') renderRoutePanel();
    } catch (err) {
        console.error('Route search failed:', err);
        if (state.currentTab !== 'route' || !resultsEl.isConnected) return;
        resultsEl.innerHTML = `
            <p class="route-error">${escapeHtml(err.message || "Couldn't calculate that route. Please try again.")}</p>
            <button type="button" class="btn btn-secondary btn-block" data-action="route-find">${icon('refresh', 16)} Try again</button>`;
    }
}
