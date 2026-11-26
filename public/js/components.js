// --- Reusable HTML Components & View Builders ---

import { escapeHtml } from './dom.js';
import { fillCost, routeStopCosts } from './fillup.js';
import { gasHoursDetailsHtml, gasStatusHtml } from './hours.js';
import { icon } from './icons.js';
import { isPhoneViewport } from './layout.js';
import {
    getTrendArrow,
    getVisibleStoreGrades,
    GRADE_INFO,
    gradePrevVal,
    gradeStr,
    gradeVal,
    hasGradeData
} from './prices.js';
import { isFavoriteStore, state } from './state.js';
import { DIRECTIONS_APP_LABELS, directionsUrl, formatAddress } from './stores.js';

export const DIRECTIONS_ICON = icon('directions', 16);

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
    moreBtn.className = 'btn btn-secondary show-more-btn';

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
            <div class="skeleton-row">
                <div class="skeleton-col">
                    <div class="skeleton skeleton-line skeleton-title"></div>
                    <div class="skeleton skeleton-line"></div>
                    <div class="skeleton skeleton-line skeleton-short"></div>
                </div>
                <div class="skeleton skeleton-box"></div>
            </div>
            <div class="skeleton-row"><div class="skeleton skeleton-btn"></div><div class="skeleton skeleton-btn"></div></div>
        </div>`;
    return `<div class="skeleton-list" role="status" aria-live="polite"><span class="sr-only">Loading…</span>${card.repeat(count)}</div>`;
}

export function errorStateHtml({ title, message, action, label = 'Try again', attrs = '' }) {
    return `
        <div class="empty-state error-state" role="alert">
            <div class="empty-state-icon is-danger">${icon('alert', 26)}</div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(message)}</p>
            <button type="button" class="btn btn-primary" data-action="${action}" ${attrs}>${icon('refresh', 16)} ${escapeHtml(label)}</button>
        </div>`;
}

export function emptyStateHtml({ iconName, title, message, actionHtml = '' }) {
    return `
        <div class="empty-state">
            <div class="empty-state-icon">${icon(iconName, 26)}</div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(message)}</p>
            ${actionHtml}
        </div>`;
}

// One tile per grade, used where every grade gets equal billing (details sheet, map popup).
export function priceTilesHtml(store, featured) {
    return getVisibleStoreGrades(store).map(g => {
        const trend = getTrendArrow(gradeVal(store, g), gradePrevVal(store, g), state.trendBaselineLabel);
        return `
            <div class="price-tag ${featured === g ? 'highlight' : ''}">
                <span class="price-tag-label">${GRADE_INFO[g].label}</span>
                <span class="val">${escapeHtml(gradeStr(store, g)) || 'N/A'} ${trend}</span>
            </div>`;
    }).join('');
}

// --- Fill-up cost (rules in fillup.js) ---
const money = (n) => `$${n.toFixed(2)}`;
const trimNumber = (n) => String(+n.toFixed(1));

// Your usual fill-up at this station, on the station details and map popup.
export function fillUpHtml(store) {
    if (!hasGradeData(store, state.gasPref)) return '';
    const cost = fillCost(gradeVal(store, state.gasPref), state.fillGallons);
    const stop = routeStopFor(store);
    const detourHtml = stop
        ? `<div class="fillup-row"><span>Detour off your route · ${stop.detourMiles < 0.1 ? 'under 0.1' : stop.detourMiles.toFixed(1)} mi</span><span class="fillup-val">${money(stop.detourCost)}</span></div>`
        : '';
    return `
        <div class="fillup" role="group" aria-label="Fill-up cost">
            <div class="fillup-row"><span>Fill-up · ${trimNumber(state.fillGallons)} gal ${GRADE_INFO[state.gasPref].label}</span><span class="fillup-val">${money(cost)}</span></div>
            ${detourHtml}
            <button type="button" class="btn btn-ghost fillup-edit" data-action="open-settings">${trimNumber(state.fillGallons)} gal · ${trimNumber(state.mpg)} mpg · Change</button>
        </div>`;
}

// This station's stop on the route being shown, if it's on it (Route tab only).
function routeStopFor(store) {
    const routeState = state.lastRouteState;
    if (state.currentTab !== 'route' || !routeState?.along) return null;
    return routeStopCosts(routeState.along, state.gasPref, { gallons: state.fillGallons, mpg: state.mpg })
        .find(s => s.store.state === store.state && s.store.city === store.city) || null;
}

// On a Route result: "Fill-up $59.88 + detour $0.40" and how it compares with the best value.
export function routeCostHtml(stop) {
    const verdict = stop.isBest
        ? `<span class="route-cost-best">Best value</span>`
        : `<span class="route-cost-extra">+${money(stop.extraVsBest)} vs best</span>`;
    const detour = stop.detourCost >= 0.005 ? ` + detour ${money(stop.detourCost)}` : ' · no detour';
    return `<div class="route-cost">Fill-up ${money(stop.fillCost)}${detour} · ${verdict}</div>`;
}

// Tap-to-call link, shared by the map popup and the station details card.
export function phoneLinkHtml(store, iconSize = 14) {
    if (!store.phone) return '';
    return `<div class="popup-phone"><a href="tel:${escapeHtml(store.phone.replace(/[^0-9+]/g, ''))}">${icon('phone', iconSize)} ${escapeHtml(store.phone)}</a></div>`;
}

export function favoriteButtonHtml(store, isFav, cls = '') {
    const label = isFav ? 'Remove from favorites' : 'Add to favorites';
    return `
        <button type="button" class="btn btn-icon favorite-btn ${cls} ${isFav ? 'active' : ''}" data-action="toggle-favorite" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}" title="${label}" aria-label="${label}" aria-pressed="${isFav}">
            ${icon('star', 18)}
        </button>`;
}

export function shareButtonHtml(store, cls = '') {
    return `
        <button type="button" class="btn btn-icon share-btn ${cls}" data-action="share" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}" title="Share this station" aria-label="Share this station">
            ${icon('share', 18)}
        </button>`;
}

// List card: the selected grade's price is the hero; the other grades sit quietly beneath.
export function createStoreCard(store, { highlight = null, index = null, showDistance = false, distanceSuffix = '', extraHtml = '' } = {}) {
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

    const featured = highlight || state.gasPref;
    const hasDistance = showDistance && store.distance !== undefined;
    const rankHtml = index !== null ? getMedal(index) : '';
    const distanceHtml = hasDistance
        ? `<span class="distance-badge">${store.distance.toFixed(1)} mi${escapeHtml(distanceSuffix)}</span>`
        : '';

    const featuredHasPrice = hasGradeData(store, featured);
    const featuredTrend = getTrendArrow(gradeVal(store, featured), gradePrevVal(store, featured), state.trendBaselineLabel);
    const otherGradesHtml = getVisibleStoreGrades(store).filter(g => g !== featured).map(g => `
            <span class="grade-chip">
                <span class="grade-chip-label">${GRADE_INFO[g].label}</span>
                <span class="grade-chip-val">${escapeHtml(gradeStr(store, g)) || 'N/A'}</span>
                ${getTrendArrow(gradeVal(store, g), gradePrevVal(store, g), state.trendBaselineLabel)}
            </span>`).join('');

    const isFav = isFavoriteStore(store.state, store.city);
    const where = `data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}"`;

    div.innerHTML = `
        <div class="card-top">
            ${rankHtml}
            <div class="card-id">
                <h3>${escapeHtml(store.city)}, ${escapeHtml(store.state)}</h3>
                <div class="address">${escapeHtml(formatAddress(store.address))}</div>
                <div class="card-meta">${gasStatusHtml(store)}${distanceHtml}</div>
                ${extraHtml}
            </div>
            <div class="card-price ${featuredHasPrice ? '' : 'is-missing'}">
                <span class="card-price-label">${GRADE_INFO[featured].label}</span>
                <span class="card-price-val">${featuredHasPrice ? escapeHtml(gradeStr(store, featured)) : '—'}</span>
                ${featuredTrend}
            </div>
        </div>
        ${otherGradesHtml ? `<div class="card-grades">${otherGradesHtml}</div>` : ''}
        <div class="card-actions">
            <a class="btn btn-tonal btn-directions" data-action="directions" href="${escapeHtml(directionsUrl(store, state.directionsApp))}" title="Open in ${DIRECTIONS_APP_LABELS[state.directionsApp]}" target="_blank" rel="noopener noreferrer" aria-label="Directions to ${escapeHtml(store.city)}, ${escapeHtml(store.state)}">
                ${DIRECTIONS_ICON} Directions
            </a>
            <button type="button" class="btn btn-secondary btn-card-history" data-action="history" ${where} title="Price history" aria-label="Price history">
                ${icon('chart', 16)} <span class="btn-label">History</span>
            </button>
            <span class="card-actions-spacer"></span>
            ${favoriteButtonHtml(store, isFav)}
            ${shareButtonHtml(store)}
        </div>
    `;

    return div;
}

export function renderSavedRoutesHtml({ fromFavorites = false } = {}) {
    if (state.favoriteRoutes.length === 0) return '';

    const headerLabel = fromFavorites ? `Saved routes (${state.favoriteRoutes.length})` : 'Saved routes';

    return `
        <div class="leaderboard-header">${headerLabel}</div>
        ${state.favoriteRoutes.map(r => {
            const isEditing = !fromFavorites && r.id === state.editingRouteId;
            return `
                <div class="store-card route-card ${isEditing ? 'route-editing' : ''}" role="group" tabindex="0" aria-label="${escapeHtml(r.origin.label)} to ${escapeHtml(r.destination.label)}" data-action="load-favorite-route" data-route-id="${r.id}">
                    <h3><span>${escapeHtml(r.origin.label)}</span><span class="route-arrow" aria-hidden="true">→</span><span class="sr-only">to</span><span>${escapeHtml(r.destination.label)}</span></h3>
                    <div class="address">Within ${r.bufferMiles} mi of route${isEditing ? ' &middot; <strong>Editing…</strong>' : ''}</div>
                    <div class="card-actions">
                        <button type="button" class="btn btn-secondary" data-action="load-favorite-route" data-route-id="${r.id}">
                            ${icon('route', 16)} Load
                        </button>
                        <span class="card-actions-spacer"></span>
                        <button type="button" class="btn btn-icon" title="Edit saved route" aria-label="Edit saved route" data-action="edit-favorite-route" data-route-id="${r.id}">
                            ${icon('edit', 18)}
                        </button>
                        <button type="button" class="btn btn-icon btn-danger" title="Remove saved route" aria-label="Remove saved route" data-action="delete-favorite-route" data-route-id="${r.id}">
                            ${icon('trash', 18)}
                        </button>
                    </div>
                </div>
            `;
        }).join('')}
    `;
}

export function renderMobileStoreCardContent(store) {
    // Phones show details inside the list sheet; tablets use the floating card.
    const contentEl = document.getElementById(isPhoneViewport() ? 'sheetDetailContent' : 'mobileStoreSheetContent');
    if (!contentEl || !store) return;

    const isFav = isFavoriteStore(store.state, store.city);

    contentEl.innerHTML = `
        <div class="mobile-sheet-header">
            <h3 class="mobile-sheet-title">${escapeHtml(store.city)}, ${escapeHtml(store.state)}</h3>
            <button type="button" class="btn btn-icon mobile-sheet-close" data-action="close-mobile-sheet" aria-label="Close store details">${icon('x', 18)}</button>
        </div>
        <div class="mobile-sheet-address">${escapeHtml(formatAddress(store.address))}</div>
        <div class="mobile-sheet-meta">
            ${gasStatusHtml(store)}
            ${phoneLinkHtml(store, 14)}
        </div>
        ${gasHoursDetailsHtml(store)}
        <div class="mobile-sheet-prices">${priceTilesHtml(store, state.gasPref)}</div>
        ${fillUpHtml(store)}
        <div class="mobile-sheet-actions">
            <a class="btn btn-primary btn-directions" data-action="directions" href="${escapeHtml(directionsUrl(store, state.directionsApp))}" title="Open in ${DIRECTIONS_APP_LABELS[state.directionsApp]}" target="_blank" rel="noopener noreferrer">
                ${DIRECTIONS_ICON} Directions
            </a>
            <button type="button" class="btn btn-secondary btn-history" data-action="history" data-state="${escapeHtml(store.state)}" data-city="${escapeHtml(store.city)}">
                ${icon('chart', 16)} History
            </button>
            <a href="${escapeHtml(store.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-store-link">
                Store page ${icon('external', 14)}
            </a>
            ${favoriteButtonHtml(store, isFav)}
            ${shareButtonHtml(store)}
        </div>
    `;
}

// Rank badge for leaderboards; the top three get the accent treatment.
function getMedal(index) {
    return `<span class="rank${index < 3 ? ' rank-top' : ''}" aria-label="Rank ${index + 1}">${index + 1}</span>`;
}
