// --- Sidebar station lists: Nearby, State lowest, All stations, Favorites ---

import {
    appendPagedCards,
    createStoreCard,
    emptyStateHtml,
    renderSavedRoutesHtml
} from './components.js';
import { escapeHtml } from './dom.js';
import { getDistanceMiles } from './geo.js';
import { icon } from './icons.js';
import { map } from './map.js';
import { syncUrl } from './nav.js';
import { filterStoresForCurrentGrade, GRADE_INFO, gradeVal, hasGradeData } from './prices.js';
import { isFavoriteStore, NEARBY_RADII, saveNearbyRadius, saveNearbySort, state } from './state.js';
import { storeMatchesQuery } from './stores.js';

export function renderNearbyPrices() {
    const container = document.getElementById("sidebarContent");
    if (!container) return;

    if (!state.userLocation) {
        container.innerHTML = emptyStateHtml({
            iconName: 'locate',
            title: 'Find gas near you',
            message: 'Share your location, or search for a city or zip code, to see the cheapest Costco gas nearby.',
            actionHtml: `<button type="button" class="btn btn-primary" data-action="find-me">${icon('locate', 16)} Use my location</button>`
        });
        return;
    }

    const gradeLabel = GRADE_INFO[state.gasPref].label;
    const controlsHtml = `
        <div class="nearby-controls">
            <div class="field nearby-control-group">
                <label for="nearbyRadiusSelect">Radius</label>
                <select id="nearbyRadiusSelect" class="select">
                    ${NEARBY_RADII.map(m => `<option value="${m}" ${m === state.nearbyRadiusMiles ? 'selected' : ''}>${m} mi</option>`).join('')}
                </select>
            </div>
            <div class="field nearby-control-group">
                <label for="nearbySortSelect">Sort by</label>
                <select id="nearbySortSelect" class="select">
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
        });

    const headerLabel = state.nearbySortMode === 'distance'
        ? `Closest stations &middot; ${gradeLabel}, within ${state.nearbyRadiusMiles} mi`
        : `Cheapest ${gradeLabel} within ${state.nearbyRadiusMiles} mi`;

    container.innerHTML = controlsHtml + `<div class="leaderboard-header">${headerLabel}</div>`;

    if (sortedData.length === 0) {
        container.innerHTML += `<p class="empty-msg">No stations within ${state.nearbyRadiusMiles} miles have a ${gradeLabel.toLowerCase()} price right now.</p>`;
        return;
    }

    const loc = state.userLocation;
    appendPagedCards(container, sortedData,
        (store, index) => createStoreCard(store, { highlight: state.gasPref, index, showDistance: true }),
        { key: `nearby|${loc.lat},${loc.lng}|${state.nearbyRadiusMiles}|${state.nearbySortMode}|${state.gasPref}` });
}

export function setNearbyRadius(val) {
    saveNearbyRadius(val);
    renderNearbyPrices();
}

export function setNearbySort(val) {
    saveNearbySort(val);
    renderNearbyPrices();
}

export function renderLowestPrices(stateOverride = null) {
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
        <div class="field state-selector-box">
            <label for="stateLeaderboardSelect">State</label>
            <select id="stateLeaderboardSelect" class="select state-select">
                ${availableStates.map(s => `<option value="${s}" ${s === state.currentStateContext ? 'selected' : ''}>${s} · ${getStoreCount(s)} station${getStoreCount(s) === 1 ? '' : 's'}</option>`).join('')}
            </select>
        </div>
    `;

    const gradeLabel = GRADE_INFO[state.gasPref].label;
    const sortedData = state.stores
        .filter(s => s.state === state.currentStateContext && hasGradeData(s, state.gasPref))
        .sort((a, b) => gradeVal(a, state.gasPref) - gradeVal(b, state.gasPref));

    container.innerHTML += `<div class="leaderboard-header">Cheapest ${gradeLabel} in ${escapeHtml(state.currentStateContext)}</div>`;
    syncUrl(); // the selected state is part of the URL
    if (sortedData.length === 0) {
        container.innerHTML += `<p class="empty-msg">No pricing data found for this state.</p>`;
        return;
    }
    appendPagedCards(container, sortedData,
        (store, index) => createStoreCard(store, { highlight: state.gasPref, index }),
        { key: `lowest|${state.currentStateContext}|${state.gasPref}` });
}

function getStoreCount(stateCode) {
    return state.stores.filter(s => s.state === stateCode).length;
}

export function renderStoresList(searchTerm) {
    const container = document.getElementById("sidebarContent");
    if (!container) return;
    container.innerHTML = "";

    let filtered = state.stores.filter(s => storeMatchesQuery(s, searchTerm));
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

    const header = document.createElement('div');
    header.className = 'leaderboard-header';
    header.textContent = `${filtered.length} station${filtered.length === 1 ? '' : 's'} · nearest to map centre first`;
    container.appendChild(header);
    appendPagedCards(container, filtered,
        store => createStoreCard(store, { highlight: state.gasPref }),
        { key: `search|${searchTerm}|${state.gasPref}`, pageSize: 20 });
}

export function renderFavoriteStores() {
    const container = document.getElementById("sidebarContent");
    if (!container) return;
    container.innerHTML = "";

    const favorites = state.stores
        .filter(s => isFavoriteStore(s.state, s.city))
        .sort((a, b) => a.city.localeCompare(b.city));

    const showRoutes = state.favoriteRoutes.length > 0 && !state.offline; // routes need a connection
    if (favorites.length === 0 && !showRoutes) {
        container.innerHTML = emptyStateHtml({
            iconName: 'star',
            title: 'No favorites yet',
            message: 'Tap the star on any station to save it here, or save a route from the Route tab.'
        });
        return;
    }

    if (favorites.length > 0) {
        const header = document.createElement('div');
        header.className = 'leaderboard-header';
        header.textContent = `Favorite stations (${favorites.length})`;
        container.appendChild(header);
        // Inside its own wrapper so "Show more" stays above the saved routes.
        const list = document.createElement('div');
        container.appendChild(list);
        appendPagedCards(list, favorites,
            store => createStoreCard(store, { highlight: state.gasPref }),
            { key: 'favorites' });
    }

    if (showRoutes) {
        const routesWrap = document.createElement('div');
        routesWrap.innerHTML = renderSavedRoutesHtml({ fromFavorites: true });
        container.appendChild(routesWrap);
    }
}
