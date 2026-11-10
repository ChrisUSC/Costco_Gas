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
    directionsUrl,
    GRADE_INFO
} from './utils.js';
import { state, isFavoriteStore } from './state.js';

export const DIRECTIONS_ICON = '<svg class="icon-directions" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/></svg>';

// --- "Show more" paging ---
// The number of cards shown survives re-renders of the same list (e.g. after starring a
// station) and resets when the list itself changes (different tab, grade, radius, ...).
const listPaging = { key: null, shown: 0 };

export function appendPagedCards(container, items, makeCard, { key, pageSize = 10 } = {}) {
    if (listPaging.key !== key) {
        listPaging.key = key;
        listPaging.shown = pageSize;
    }
    let shown = 0;
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'btn-action btn-outline-blue show-more-btn';

    const addUpTo = (limit) => {
        const frag = document.createDocumentFragment();
        let firstNew = null;
        for (; shown < Math.min(limit, items.length); shown++) {
            const card = makeCard(items[shown], shown);
            firstNew = firstNew || card;
            frag.appendChild(card);
        }
        container.insertBefore(frag, moreBtn.isConnected ? moreBtn : null);
        const remaining = items.length - shown;
        if (remaining > 0) {
            moreBtn.textContent = `Show ${Math.min(pageSize, remaining)} more (${remaining} left)`;
            if (!moreBtn.isConnected) container.appendChild(moreBtn);
        } else {
            moreBtn.remove();
        }
        return firstNew;
    };

    moreBtn.addEventListener('click', () => {
        listPaging.shown = shown + pageSize;
        const firstNew = addUpTo(listPaging.shown);
        firstNew?.focus({ preventScroll: true }); // keep keyboard / screen-reader position
    });
    addUpTo(listPaging.shown);
}

// --- Loading & error states ---
export function skeletonCardsHtml(count = 4) {
    const card = `
        <div class="store-card skeleton-card" aria-hidden="true">
            <div class="skeleton skeleton-line" style="width:55%; height:16px;"></div>
            <div class="skeleton skeleton-line" style="width:85%;"></div>
            <div class="skeleton-row"><div class="skeleton skeleton-box"></div><div class="skeleton skeleton-box"></div></div>
            <div class="skeleton-row"><div class="skeleton skeleton-btn"></div><div class="skeleton skeleton-btn"></div></div>
        </div>`;
    return `<div class="skeleton-list" role="status" aria-live="polite"><span class="sr-only">Loading…</span>${card.repeat(count)}</div>`;
}

export function errorStateHtml({ title, message, action, label = 'Try again', attrs = '' }) {
    return `
        <div class="empty-state error-state" role="alert">
            <div class="error-state-icon" aria-hidden="true">⚠️</div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(message)}</p>
            <button type="button" class="btn-action" data-action="${action}" ${attrs}>↻ ${escapeHtml(label)}</button>
        </div>`;
}

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
            <a class="btn-action btn-directions" data-action="directions" href="${escapeHtml(directionsUrl(store))}" target="_blank" rel="noopener noreferrer" aria-label="Directions to ${escapeHtml(store.city)}, ${escapeHtml(store.state)}">
                ${DIRECTIONS_ICON} Directions
            </a>
            <button type="button" class="btn-action btn-outline-blue btn-card-history" data-action="history" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}" title="Price history">
                📈 <span class="btn-label">History</span>
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
    // Phones show details inside the list sheet; tablets use the floating card.
    const contentEl = document.getElementById(window.innerWidth <= 599 ? 'sheetDetailContent' : 'mobileStoreSheetContent');
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
            <a class="btn-action btn-directions" data-action="directions" href="${escapeHtml(directionsUrl(store))}" target="_blank" rel="noopener noreferrer">
                ${DIRECTIONS_ICON} Directions
            </a>
            <button type="button" class="btn-action btn-outline-blue btn-history" data-action="history" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}">
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
