// --- Reusable HTML Components & View Builders ---

import {
    escapeHtml,
    getMedal,
    gasStatusHtml,
    gasHoursDetailsHtml,
    getVisibleStoreGrades,
    gradeVal,
    gradePrevVal,
    gradeStr,
    getTrendArrow,
    GRADE_INFO
} from './utils.js';
import { state, isFavoriteStore } from './state.js';

export function createStoreCard(store, { highlight = null, index = null, showDistance = false, distanceSuffix = '' } = {}) {
    const div = document.createElement('div');
    div.className = 'store-card';
    div.dataset.action = 'fly-to-store';
    // A focusable group (not role="button"): the card has its own nested buttons, which a
    // button role would hide from assistive tech. Enter/Space on the card itself = show on map.
    div.setAttribute('role', 'group');
    div.tabIndex = 0;
    div.setAttribute('aria-label', `${store.city}, ${store.state}`);
    div.dataset.state = store.state;
    div.dataset.city = store.city;

    let badgeHtml = '';
    if (showDistance && store.distance !== undefined) {
        badgeHtml = `<span class="distance-badge">${store.distance.toFixed(1)} mi${escapeHtml(distanceSuffix)}</span>`;
    } else if (index !== null) {
        badgeHtml = `<span class="medal">${getMedal(index)}</span>`;
    }

    const isFav = isFavoriteStore(store.state, store.city);
    const priceTagsHtml = getVisibleStoreGrades(store).map(g => {
        const cls = highlight === g ? 'highlight' : '';
        const trend = getTrendArrow(gradeVal(store, g), gradePrevVal(store, g), state.trendBaselineLabel);
        return `
            <div class="price-tag ${cls}">
                <span>${GRADE_INFO[g].label}</span><span class="val">${gradeStr(store, g) || 'N/A'} ${trend}</span>
            </div>`;
    }).join('');

    div.innerHTML = `
        <h3><span>${escapeHtml(store.city)}, ${escapeHtml(store.state)}</span> ${badgeHtml}</h3>
        <div class="address">${escapeHtml(store.address)}</div>
        ${gasStatusHtml(store)}
        <div class="prices">${priceTagsHtml}</div>
        <div class="card-actions">
            <button type="button" class="btn-action btn-outline-blue" data-action="history" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}">
                📈 History
            </button>
            <button type="button" class="btn-action favorite-btn ${isFav ? 'active' : ''}" data-action="toggle-favorite" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
                ${isFav ? '★' : '☆'}
            </button>
            <button type="button" class="btn-action share-btn" data-action="share" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}" title="Share this station">
                🔗
            </button>
        </div>
    `;

    return div;
}

export function renderSavedRoutesHtml({ fromFavorites = false } = {}) {
    if (state.favoriteRoutes.length === 0) return '';

    const headerLabel = fromFavorites ? `★ Saved Routes (${state.favoriteRoutes.length})` : '★ Saved Routes';

    return `
        <div class="leaderboard-header">${headerLabel}</div>
        ${state.favoriteRoutes.map(r => {
            const isEditing = !fromFavorites && r.id === state.editingRouteId;
            return `
                <div class="store-card ${isEditing ? 'route-editing' : ''}" role="group" tabindex="0" aria-label="${escapeHtml(r.origin.label)} to ${escapeHtml(r.destination.label)}" data-action="load-favorite-route" data-route-id="${r.id}">
                    <h3><span>${escapeHtml(r.origin.label)} → ${escapeHtml(r.destination.label)}</span></h3>
                    <div class="address">Within ${r.bufferMiles} mi of route${isEditing ? ' &middot; <strong>Editing…</strong>' : ''}</div>
                    <div class="card-actions">
                        <button type="button" class="btn-action btn-outline-blue" data-action="load-favorite-route" data-route-id="${r.id}">
                            🛣️ Load
                        </button>
                        <button type="button" class="btn-action share-btn" title="Edit saved route" data-action="edit-favorite-route" data-route-id="${r.id}">
                            ✎
                        </button>
                        <button type="button" class="btn-action share-btn" title="Remove saved route" data-action="delete-favorite-route" data-route-id="${r.id}">
                            🗑
                        </button>
                    </div>
                </div>
            `;
        }).join('')}
    `;
}

export function renderMobileStoreCardContent(store) {
    const contentEl = document.getElementById('mobileStoreSheetContent');
    if (!contentEl || !store) return;

    const isFav = isFavoriteStore(store.state, store.city);
    const priceTagsHtml = getVisibleStoreGrades(store).map(g => {
        const cls = state.gasPref === g ? 'highlight' : '';
        const trend = getTrendArrow(gradeVal(store, g), gradePrevVal(store, g), state.trendBaselineLabel);
        return `
            <div class="price-tag ${cls}">
                <span>${GRADE_INFO[g].label}</span>
                <span class="val">${gradeStr(store, g) || 'N/A'} ${trend}</span>
            </div>`;
    }).join('');

    const phoneHtml = store.phone
        ? `<div class="popup-phone"><a href="tel:${escapeHtml(store.phone.replace(/[^0-9+]/g, ''))}">📞 ${escapeHtml(store.phone)}</a></div>`
        : '';

    contentEl.innerHTML = `
        <div class="mobile-sheet-header">
            <h3 class="mobile-sheet-title">${escapeHtml(store.city)}, ${escapeHtml(store.state)}</h3>
            <button type="button" class="mobile-sheet-close" data-action="close-mobile-sheet" aria-label="Close store details">×</button>
        </div>
        <div class="mobile-sheet-address">${escapeHtml(store.address)}</div>
        <div class="mobile-sheet-meta">
            ${gasStatusHtml(store)}
            ${phoneHtml}
        </div>
        ${gasHoursDetailsHtml(store)}
        <div class="mobile-sheet-prices">${priceTagsHtml}</div>
        <div class="mobile-sheet-actions">
            <button type="button" class="btn-action btn-history" data-action="history" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}">
                📈 History
            </button>
            <a href="${escapeHtml(store.url)}" target="_blank" rel="noopener noreferrer" class="btn-action btn-outline-blue btn-store-link">
                Store Page ↗
            </a>
            <button type="button" class="btn-action favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
                data-action="toggle-favorite" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}">
                ${isFav ? '★' : '☆'}
            </button>
            <button type="button" class="btn-action share-btn" title="Share this station"
                data-action="share" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}">
                🔗
            </button>
        </div>
    `;
}
