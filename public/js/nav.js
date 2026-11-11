// --- URL State & Browser History ---
// Tab, grade and state live in the query string (replaceState: they never add history
// entries). Opening the station sheet or the price-history modal pushes an entry, so the
// browser / Android Back button closes it instead of leaving the site.

import { TAB_NAMES } from './state.js';
import { GRADE_KEYS } from './utils.js';

let handlers = {
    getView: () => ({}),        // -> { tab, grade, state, store }
    applyOverlay: () => {}      // (overlay | null) after a user Back / Forward
};
let pendingBacks = 0;   // history.back() calls we made ourselves (UI already updated)
let afterBack = null;   // a push that has to wait for our own back() to land

export function readUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    const grade = params.get('grade');
    const stateCode = (params.get('state') || '').toUpperCase();
    return {
        tab: TAB_NAMES.includes(tab) ? tab : null,
        grade: GRADE_KEYS.includes(grade) ? grade : null,
        state: /^[A-Z]{2}$/.test(stateCode) ? stateCode : null
    };
}

function buildUrl() {
    const view = handlers.getView();
    const url = new URL(window.location.href);
    url.search = '';
    if (view.tab) url.searchParams.set('tab', view.tab);
    if (view.grade) url.searchParams.set('grade', view.grade);
    if (view.state) url.searchParams.set('state', view.state);
    if (view.store) url.searchParams.set('store', view.store);
    return url;
}

function safely(fn) {
    try { fn(); } catch (e) { /* e.g. Safari's replaceState rate limit, sandboxed frames */ }
}

// Rewrite the current entry's URL from the app's state (no new history entry).
export function syncUrl() {
    const url = buildUrl();
    if (url.href === window.location.href) return;
    safely(() => history.replaceState(history.state, '', url));
}

export function currentOverlay() {
    return history.state?.overlay || null;
}

// overlay: { type: 'sheet' | 'modal', state, city, sheet? }
export function pushOverlay(overlay) {
    const run = () => safely(() => history.pushState({ overlay }, '', buildUrl()));
    if (pendingBacks > 0) afterBack = run; else run();
}

export function replaceOverlay(overlay) {
    safely(() => history.replaceState({ overlay }, '', buildUrl()));
}

// The UI closed an overlay itself: drop its history entry so Back doesn't "close" it twice.
export function popOverlay(type) {
    if (currentOverlay()?.type !== type) return false;
    pendingBacks++;
    history.back();
    return true;
}

export function initNav(h) {
    handlers = { ...handlers, ...h };
    window.addEventListener('popstate', (e) => {
        if (pendingBacks > 0) {
            pendingBacks--;
            if (pendingBacks === 0 && afterBack) {
                const run = afterBack;
                afterBack = null;
                run();
            }
        } else {
            handlers.applyOverlay(e.state?.overlay || null);
        }
        syncUrl();
    });
}
