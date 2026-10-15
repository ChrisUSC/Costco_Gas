// --- Route Feature: OSRM Driving Route, Corridor Filtering & Saved Routes ---

import {
    getDistanceMiles,
    minDistanceToRouteMiles,
    getRouteBoundsPadded,
    escapeHtml,
    showToast,
    requestBrowserLocation,
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
import { createStoreCard, renderSavedRoutesHtml } from './components.js';
import { geocodeAddress, setupInputAutocomplete } from './search.js';

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

    const originVal = state.lastRouteState ? escapeHtml(state.lastRouteState.originText) : '';
    const destVal = state.lastRouteState ? escapeHtml(state.lastRouteState.destText) : '';
    const buffer = state.lastRouteState ? state.lastRouteState.bufferMiles : 2;

    let saveButtonHtml = '';
    if (state.editingRouteId !== null) {
        const updateBtn = state.lastRouteState
            ? `<button type="button" class="btn-action save-route-btn" data-action="route-save">💾 Update Route</button>`
            : '';
        saveButtonHtml = `
            ${updateBtn}
            <button type="button" class="btn-action cancel-edit-btn" data-action="route-cancel-edit">✕ Cancel Editing</button>
        `;
    } else if (state.lastRouteState) {
        saveButtonHtml = `<button type="button" class="btn-action save-route-btn" data-action="route-save">☆ Save This Route</button>`;
    }

    const savedRoutesHtml = state.favoriteRoutes.length > 0
        ? `<div style="margin-top:16px;">${renderSavedRoutesHtml({ fromFavorites: false })}</div>`
        : '';

    container.innerHTML = `
        <div class="route-panel">
            <label>From</label>
            <div class="route-input-row">
                <input type="text" id="routeOrigin" class="route-input" placeholder="Address or city" autocomplete="off" value="${originVal}">
                <button type="button" class="route-locate-btn" data-action="route-locate" title="Use my location">📍</button>
                <div id="routeOriginDropdown" class="autocomplete-dropdown"></div>
            </div>

            <label>To</label>
            <div class="route-input-row">
                <input type="text" id="routeDestination" class="route-input" placeholder="Address or city" autocomplete="off" value="${destVal}">
                <div id="routeDestDropdown" class="autocomplete-dropdown"></div>
            </div>

            <label>Search within (miles of the route)</label>
            <input type="number" id="routeBuffer" class="route-input" style="width:100%; margin-bottom:12px;"
                   min="1" max="25" step="1" value="${buffer}">
            <button type="button" class="btn-action" style="width:100%; justify-content:center;" data-action="route-find">🛣️ Find Cheapest Along Route</button>
            ${saveButtonHtml}
        </div>
        ${savedRoutesHtml}
        <div id="routeResultsContainer"></div>
    `;

    setupInputAutocomplete('routeOrigin', 'routeOriginDropdown', 'routeOrigin');
    setupInputAutocomplete('routeDestination', 'routeDestDropdown', 'routeDest');

    if (state.lastRouteState && state.lastRouteState.along) {
        renderRouteResults(state.lastRouteState);
        renderRouteOnMap(state.lastRouteState.route.coords, state.lastRouteState.origin, state.lastRouteState.destination);
        routesContext.renderMap(state.lastRouteState.along.length > 0 ? state.lastRouteState.along : state.stores);
    }
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

export async function loadFavoriteRoute(id) {
    const route = state.favoriteRoutes.find(r => r.id === id);
    if (!route) return;

    state.editingRouteId = null;
    state.editSnapshot = null;
    populateRouteInputsFromSaved(route);

    await findGasAlongRoute();
    renderRoutePanel();
}

export async function startEditRoute(id) {
    const route = state.favoriteRoutes.find(r => r.id === id);
    if (!route) return;

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
    renderRoutePanel();
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
        html += `<p class="route-warning">⚠️ Live routing was unavailable, so this is an approximate straight-line path, not a real driving route.</p>`;
    }
    html += `
        <div class="route-summary">${Math.round(route.distanceMiles)} mi route &middot; ${sorted.length} station${sorted.length === 1 ? '' : 's'} found</div>
        <button type="button" class="btn-action btn-outline-blue view-route-map-btn" data-action="view-route-map">
            🗺️ View Route on Map
        </button>
    `;
    el.innerHTML = html;

    if (sorted.length === 0) {
        el.innerHTML += `<p class="empty-msg" style="margin-top:20px;">No Costco gas stations found within ${bufferMiles} miles of this route.</p>`;
        return;
    }

    el.innerHTML += `<div class="leaderboard-header">Cheapest ${gradeLabel} Along the Way</div>`;
    sorted.forEach((store, index) => el.appendChild(createStoreCard(store, {
        highlight: state.gasPref,
        index,
        showDistance: true,
        distanceSuffix: ' off route'
    })));
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
        const originInput = document.getElementById('routeOrigin');
        if (originInput) {
            originInput.value = 'Your location';
            state.routeOriginLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                label: 'Your location'
            };
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

    resultsEl.innerHTML = `<p class="empty-msg" style="margin-top:20px;">Calculating route…</p>`;

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
        renderRoutePanel();
    } catch (err) {
        console.error('Route search failed:', err);
        resultsEl.innerHTML = `<p class="route-error">${escapeHtml(err.message || "Couldn't calculate that route. Please try again.")}</p>`;
    }
}
