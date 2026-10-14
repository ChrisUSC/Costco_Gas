// --- Route Feature: OSRM Driving Route, Corridor Filtering & Saved Routes ---

let routeLayer = null;
let lastRouteState = null;
let routeOriginLocation = null;
let routeDestLocation = null;
let editingRouteId = null;
let editSnapshot = null;

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

function renderSavedRoutesHtml({ fromFavorites = false } = {}) {
    if (favoriteRoutes.length === 0) return '';

    const loadFn = fromFavorites ? 'loadFavoriteRouteFromFavorites' : 'loadFavoriteRoute';
    const editFn = fromFavorites ? 'editFavoriteRouteFromFavorites' : 'startEditRoute';
    const headerLabel = fromFavorites ? `★ Saved Routes (${favoriteRoutes.length})` : '★ Saved Routes';

    return `
        <div class="leaderboard-header">${headerLabel}</div>
        ${favoriteRoutes.map(r => {
            const isEditing = !fromFavorites && r.id === editingRouteId;
            return `
                <div class="store-card ${isEditing ? 'route-editing' : ''}" onclick="${loadFn}(${r.id})">
                    <h3><span>${escapeHtml(r.origin.label)} → ${escapeHtml(r.destination.label)}</span></h3>
                    <div class="address">Within ${r.bufferMiles} mi of route${isEditing ? ' &middot; <strong>Editing…</strong>' : ''}</div>
                    <div class="card-actions">
                        <button class="btn-action btn-outline-blue" onclick="event.stopPropagation(); ${loadFn}(${r.id})">
                            🛣️ Load
                        </button>
                        <button class="btn-action share-btn" title="Edit saved route" onclick="event.stopPropagation(); ${editFn}(${r.id})">
                            ✎
                        </button>
                        <button class="btn-action share-btn" title="Remove saved route" onclick="event.stopPropagation(); removeFavoriteRoute(${r.id})">
                            🗑
                        </button>
                    </div>
                </div>
            `;
        }).join('')}
    `;
}

function renderRoutePanel() {
    const container = document.getElementById("sidebarContent");
    const originVal = lastRouteState ? escapeHtml(lastRouteState.originText) : '';
    const destVal = lastRouteState ? escapeHtml(lastRouteState.destText) : '';
    const buffer = lastRouteState ? lastRouteState.bufferMiles : 2;

    let saveButtonHtml = '';
    if (editingRouteId !== null) {
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

    const savedRoutesHtml = favoriteRoutes.length > 0
        ? `<div style="margin-top:16px;">${renderSavedRoutesHtml({ fromFavorites: false })}</div>`
        : '';

    container.innerHTML = `
        <div class="route-panel">
            <label>From</label>
            <div class="route-input-row">
                <input type="text" id="routeOrigin" class="route-input" placeholder="Address or city" autocomplete="off" value="${originVal}">
                <button class="route-locate-btn" onclick="useMyLocationForRoute()" title="Use my location">📍</button>
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
            <button class="btn-action" style="width:100%; justify-content:center;" onclick="findGasAlongRoute()">🛣️ Find Cheapest Along Route</button>
            ${saveButtonHtml}
        </div>
        ${savedRoutesHtml}
        <div id="routeResultsContainer"></div>
    `;

    setupInputAutocomplete('routeOrigin', 'routeOriginDropdown', 'routeOrigin');
    setupInputAutocomplete('routeDestination', 'routeDestDropdown', 'routeDest');

    if (lastRouteState && lastRouteState.along) {
        renderRouteResults(lastRouteState);
        renderRouteOnMap(lastRouteState.route.coords, lastRouteState.origin, lastRouteState.destination);
        renderMap(lastRouteState.along.length > 0 ? lastRouteState.along : globalStoreData);
    }
}

function saveCurrentRouteAsFavorite() {
    if (!lastRouteState) return;
    const { origin, destination, bufferMiles } = lastRouteState;
    const matchesRoute = r =>
        r.origin.label === origin.label &&
        r.destination.label === destination.label &&
        r.bufferMiles === bufferMiles;

    if (editingRouteId !== null) {
        const target = favoriteRoutes.find(r => r.id === editingRouteId);
        if (!target) {
            editingRouteId = null;
        } else {
            if (favoriteRoutes.some(r => r.id !== editingRouteId && matchesRoute(r))) {
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

    if (favoriteRoutes.some(matchesRoute)) {
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
        cancelEditRoute();
    } else {
        renderCurrentTab();
    }
}

async function loadFavoriteRouteFromFavorites(id) {
    switchTab('route');
    await loadFavoriteRoute(id);
}

async function editFavoriteRouteFromFavorites(id) {
    switchTab('route');
    await startEditRoute(id);
}

function populateRouteInputsFromSaved(route) {
    routeOriginLocation = { ...route.origin };
    routeDestLocation = { ...route.destination };
    document.getElementById('routeOrigin').value = route.origin.label;
    document.getElementById('routeDestination').value = route.destination.label;
    document.getElementById('routeBuffer').value = route.bufferMiles;
}

async function loadFavoriteRoute(id) {
    const route = favoriteRoutes.find(r => r.id === id);
    if (!route) return;

    editingRouteId = null;
    editSnapshot = null;
    populateRouteInputsFromSaved(route);

    await findGasAlongRoute();
    renderRoutePanel();
}

async function startEditRoute(id) {
    const route = favoriteRoutes.find(r => r.id === id);
    if (!route) return;

    if (editingRouteId === null) {
        editSnapshot = { lastRouteState, routeOriginLocation, routeDestLocation };
    }

    editingRouteId = id;
    populateRouteInputsFromSaved(route);

    await findGasAlongRoute();
    renderRoutePanel();
}

function cancelEditRoute() {
    editingRouteId = null;

    if (editSnapshot) {
        lastRouteState = editSnapshot.lastRouteState;
        routeOriginLocation = editSnapshot.routeOriginLocation;
        routeDestLocation = editSnapshot.routeDestLocation;
        editSnapshot = null;
    }

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
    const gradeLabel = GRADE_INFO[gasPref].label;
    const { along, route, bufferMiles } = state;

    const sorted = along
        .filter(s => hasGradeData(s, gasPref))
        .sort((a, b) => gradeVal(a, gasPref) - gradeVal(b, gasPref));

    let html = '';
    if (route.isApproximate) {
        html += `<p class="route-warning">⚠️ Live routing was unavailable, so this is an approximate straight-line path, not a real driving route.</p>`;
    }
    html += `<div class="route-summary">${Math.round(route.distanceMiles)} mi route &middot; ${sorted.length} station${sorted.length === 1 ? '' : 's'} found</div>`;
    el.innerHTML = html;

    if (sorted.length === 0) {
        el.innerHTML += `<p class="empty-msg" style="margin-top:20px;">No Costco gas stations found within ${bufferMiles} miles of this route.</p>`;
        return;
    }

    el.innerHTML += `<div class="leaderboard-header">Cheapest ${gradeLabel} Along the Way</div>`;
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

    map.fitBounds(L.latLngBounds(routeCoords), { padding: [40, 40] });
}

function useMyLocationForRoute() {
    requestBrowserLocation((position) => {
        const originInput = document.getElementById('routeOrigin');
        if (originInput) {
            originInput.value = 'Your location';
            routeOriginLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                label: 'Your location'
            };
        }
    });
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

    resultsEl.innerHTML = `<p class="empty-msg" style="margin-top:20px;">Calculating route…</p>`;

    try {
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
        renderRoutePanel();
    } catch (err) {
        console.error('Route search failed:', err);
        resultsEl.innerHTML = `<p class="route-error">${escapeHtml(err.message || "Couldn't calculate that route. Please try again.")}</p>`;
    }
}
