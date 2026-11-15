// --- Phone bottom sheet, tablet sidebar toggle, and the station details card on phones and tablets ---

import { renderMobileStoreCardContent } from './components.js';
import { debounce } from './dom.js';
import { isMobileViewport, isPhoneViewport, isTabletPortrait } from './layout.js';
import { map } from './map.js';
import { currentOverlay, popOverlay, pushOverlay, replaceOverlay, syncUrl } from './nav.js';
import { state } from './state.js';

export function initSheet() {
    setupMobileSheetGestures();
    setupSheetDrag();
    setSheetState('peek');
    // Re-fit the sheet when the card's height changes (gas hours expanded, re-render, fonts).
    const detailContent = document.getElementById('sheetDetailContent');
    if (detailContent && typeof ResizeObserver === 'function') {
        new ResizeObserver(() => { if (isPhoneViewport() && state.activeMobileStore) syncSheetA11y(); })
            .observe(detailContent);
    }
    window.addEventListener('resize', debounce(handleResize, 150));
}

const SHEET_STATES = ['peek', 'half', 'full'];
const SHEET_HALF_FRACTION = 0.5; // how much of the sheet is pushed down at "half"
const DETAIL_MAX_FRACTION = 0.88; // a station card never covers more of the sheet than this
let sheetStateBeforeDetail = null; // list position to return to when the station card closes

// Resting translateY (px) of the "half" state. For the list it's half the sheet; a station
// card instead sizes the sheet to its content, so it is never cut off and covers no more
// map than it needs.
function sheetHalfY() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return 0;
    const h = sidebar.offsetHeight;
    const detail = document.getElementById('sheetDetail');
    const content = document.getElementById('sheetDetailContent');
    if (!sidebar.classList.contains('has-detail') || !detail || detail.hidden || !content) {
        return Math.round(h * SHEET_HALF_FRACTION);
    }
    const cs = getComputedStyle(detail);
    const needed = (document.getElementById('sheetGrabber')?.offsetHeight || 0)
        + content.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return Math.round(Math.max(h * (1 - DETAIL_MAX_FRACTION), h - needed));
}

export function setSheetState(next, { keepDetail = false } = {}) {
    if (!SHEET_STATES.includes(next)) next = 'peek';
    state.mobileViewMode = next;
    const container = document.getElementById('appContainer');
    const sidebar = document.getElementById('sidebar');
    if (container) {
        SHEET_STATES.forEach(s => container.classList.toggle(`sheet-${s}`, s === next));
        container.classList.toggle('mobile-view-list', next !== 'peek');
    }
    if (sidebar) sidebar.style.transform = ''; // drop any drag offset
    syncSheetA11y();
    // Dragging down to peek dismisses the details; opening further keeps them.
    if (!keepDetail && state.activeMobileStore && next === 'peek') closeMobileStoreCard({ restoreSheet: false });
    if (map) setTimeout(() => map.invalidateSize(), 60);
}

// At "peek" only the tab strip is visible, so the list behind it must not be focusable.
function syncSheetA11y() {
    const content = document.getElementById('sidebarContent');
    const grabber = document.getElementById('sheetGrabber');
    const collapsed = isPhoneViewport() && state.mobileViewMode === 'peek';
    if (content) content.toggleAttribute('inert', collapsed);
    if (grabber) grabber.setAttribute('aria-expanded', String(!collapsed));
    // At "half" the lower part of the sheet is off-screen; the list must stop above it.
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        const halfY = `${sheetHalfY()}px`;
        sidebar.style.setProperty('--half-y', halfY);
        sidebar.style.setProperty('--sheet-hidden', halfY);
    }
}

function setupSheetDrag() {
    const sidebar = document.getElementById('sidebar');
    const grabber = document.getElementById('sheetGrabber');
    const container = document.getElementById('appContainer');
    if (!sidebar || !grabber || !container) return;

    const peekHeight = () => grabber.offsetHeight + document.getElementById('sidebarTabs').offsetHeight;
    // Resting translateY (px) of each state, measured against the sheet's own height.
    const restingY = () => {
        const h = sidebar.offsetHeight;
        return { full: 0, half: sheetHalfY(), peek: Math.max(0, h - peekHeight()) };
    };
    const nearest = (y) => {
        const r = restingY();
        return SHEET_STATES.reduce((best, st) => Math.abs(r[st] - y) < Math.abs(r[best] - y) ? st : best, 'peek');
    };

    // The grab bar and the tab strip both drag the sheet. On the strip a short
    // movement is still a tap, so the pointer is captured only once a drag starts.
    const tabs = document.getElementById('sidebarTabs');
    let drag = null;
    const startDrag = (handle) => (e) => {
        if (!isPhoneViewport() || (e.pointerType === 'mouse' && e.button !== 0)) return;
        const r = restingY();
        drag = { handle, pointerId: e.pointerId, startY: e.clientY, startPos: r[state.mobileViewMode], lastY: e.clientY, lastT: e.timeStamp, velocity: 0, moved: false };
        if (handle === grabber) grabber.setPointerCapture(e.pointerId);
    };
    const moveDrag = (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const dy = e.clientY - drag.startY;
        if (!drag.moved && Math.abs(dy) < 6) return;
        if (!drag.moved) {
            drag.moved = true;
            sidebar.classList.add('dragging');
            if (!drag.handle.hasPointerCapture(e.pointerId)) drag.handle.setPointerCapture(e.pointerId);
        }
        const dt = e.timeStamp - drag.lastT;
        if (dt > 0) drag.velocity = (e.clientY - drag.lastY) / dt; // px/ms, + is downward
        drag.lastY = e.clientY; drag.lastT = e.timeStamp;
        const r = restingY();
        const y = Math.min(r.peek, Math.max(0, drag.startPos + dy));
        sidebar.style.transform = `translateY(${y}px)`;
    };
    const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const d = drag; drag = null;
        sidebar.classList.remove('dragging');
        if (!d.moved) return; // a plain tap is handled by the click listener
        d.handle.dataset.justDragged = '1';
        setTimeout(() => delete d.handle.dataset.justDragged, 0);
        const y = d.startPos + (e.clientY - d.startY);
        let target = nearest(y);
        if (Math.abs(d.velocity) > 0.5) { // a flick moves one step in its direction
            const i = SHEET_STATES.indexOf(state.mobileViewMode);
            const step = d.velocity < 0 ? 1 : -1; // up = more open
            target = SHEET_STATES[Math.min(2, Math.max(0, i + step))];
        }
        setSheetState(target);
    };
    for (const handle of [grabber, tabs].filter(Boolean)) {
        handle.addEventListener('pointerdown', startDrag(handle));
        handle.addEventListener('pointermove', moveDrag);
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);
    }
    // A drag that started on a tab must not also switch to that tab.
    tabs?.addEventListener('click', (e) => {
        if (tabs.dataset.justDragged) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    // Tap / Enter / Space cycles peek -> half -> full -> peek; arrows move one step.
    grabber.addEventListener('click', () => {
        if (grabber.dataset.justDragged) return;
        const i = SHEET_STATES.indexOf(state.mobileViewMode);
        setSheetState(SHEET_STATES[(i + 1) % SHEET_STATES.length]);
    });
    grabber.addEventListener('keydown', (e) => {
        const i = SHEET_STATES.indexOf(state.mobileViewMode);
        if (e.key === 'ArrowUp') setSheetState(SHEET_STATES[Math.min(2, i + 1)]);
        else if (e.key === 'ArrowDown') setSheetState(SHEET_STATES[Math.max(0, i - 1)]);
        else return;
        e.preventDefault();
    });
}

export function setSidebarCollapsed(collapsed) {
    const container = document.getElementById('appContainer');
    const toggle = document.getElementById('sidebarToggle');
    if (!container) return;
    container.classList.toggle('sidebar-collapsed', collapsed);
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.toggleAttribute('inert', collapsed && isTabletPortrait());
    if (toggle) {
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.querySelector('span').textContent = collapsed ? 'List' : 'Hide';
    }
    if (map) setTimeout(() => map.invalidateSize(), 260);
}

// The collapsed state only applies in tablet portrait; elsewhere the sidebar is always usable.
function syncSidebarToggle() {
    const container = document.getElementById('appContainer');
    const sidebar = document.getElementById('sidebar');
    if (!container || !sidebar) return;
    const collapsed = container.classList.contains('sidebar-collapsed');
    sidebar.toggleAttribute('inert', collapsed && isTabletPortrait());
}

export const sheetOverlay = (store) => ({ type: 'sheet', state: store.state, city: store.city });

// Record the open sheet in history so Back closes it (swapping stations reuses the entry).
function recordSheetOpen(store) {
    if (currentOverlay()?.type === 'sheet') replaceOverlay(sheetOverlay(store));
    else pushOverlay(sheetOverlay(store));
}

export function openMobileStoreCard(store, { fromHistory = false } = {}) {
    if (!store) return;
    state.activeMobileStore = store;
    renderMobileStoreCardContent(store);
    const container = document.getElementById('appContainer');

    if (isPhoneViewport()) {
        // One sheet: the list gives way to the station's details, same drag heights.
        const sidebar = document.getElementById('sidebar');
        const detail = document.getElementById('sheetDetail');
        if (sidebar && !sidebar.classList.contains('has-detail')) sheetStateBeforeDetail = state.mobileViewMode;
        if (detail) { detail.hidden = false; detail.scrollTop = 0; }
        if (sidebar) sidebar.classList.add('has-detail');
        setSheetState('half', { keepDetail: true }); // sized to the card (see sheetHalfY)
        detail?.querySelector('.mobile-sheet-close')?.focus({ preventScroll: true });
        if (!fromHistory) recordSheetOpen(store);
        return;
    }

    const sheet = document.getElementById('mobileStoreSheet');
    if (sheet) {
        sheet.classList.add('active');
        sheet.setAttribute('aria-hidden', 'false');
        sheet.removeAttribute('inert');
    }
    if (container) container.classList.add('mobile-sheet-open');
    if (!fromHistory) recordSheetOpen(store);
}

export function closeMobileStoreCard({ fromHistory = false, restoreSheet = true } = {}) {
    const hadStore = Boolean(state.activeMobileStore);
    state.activeMobileStore = null;
    const sheet = document.getElementById('mobileStoreSheet');
    const container = document.getElementById('appContainer');
    const sidebar = document.getElementById('sidebar');
    const detail = document.getElementById('sheetDetail');
    if (sheet) {
        sheet.classList.remove('active');
        sheet.setAttribute('aria-hidden', 'true');
        sheet.setAttribute('inert', '');
    }
    if (container) container.classList.remove('mobile-sheet-open');
    if (sidebar) sidebar.classList.remove('has-detail');
    if (detail) detail.hidden = true;
    // Put the list back where it was before the card opened (e.g. tucked away at "peek").
    const before = sheetStateBeforeDetail;
    sheetStateBeforeDetail = null;
    if (hadStore && isPhoneViewport()) {
        if (restoreSheet && before && before !== state.mobileViewMode) setSheetState(before, { keepDetail: true });
        else syncSheetA11y();
    }
    if (hadStore && isPhoneViewport()) document.getElementById('sheetGrabber')?.focus({ preventScroll: true });
    if (hadStore && !fromHistory && !popOverlay('sheet')) syncUrl();
}

// On phones the sheet covers the lower half, so aim the map at the visible upper part.
// Call after the card has opened, so its height is known.
export function sheetAwareCenter(latlng, zoom) {
    if (!isPhoneViewport() || !map) return latlng;
    const sidebar = document.getElementById('sidebar');
    const covered = sidebar ? sidebar.offsetHeight - sheetHalfY() : map.getSize().y * 0.44;
    return map.unproject(map.project(latlng, zoom).add([0, covered / 2]), zoom);
}

function setupMobileSheetGestures() {
    const sheet = document.getElementById('mobileStoreSheet');
    if (!sheet) return;

    let touchStartY = null;
    sheet.addEventListener('touchstart', (e) => {
        if (sheet.scrollTop <= 0) {
            touchStartY = e.touches[0].clientY;
        } else {
            touchStartY = null;
        }
    }, { passive: true });

    sheet.addEventListener('touchend', (e) => {
        if (touchStartY === null) return;
        const deltaY = e.changedTouches[0].clientY - touchStartY;
        if (deltaY > 45) {
            closeMobileStoreCard();
        }
        touchStartY = null;
    }, { passive: true });
}

// Crossing a layout tier moves the station details to a different container (popup, tablet
// card or phone sheet), so close whatever no longer fits.
function handleResize() {
    if (!isMobileViewport() && state.activeMobileStore) {
        closeMobileStoreCard();
    } else if (isMobileViewport()) {
        map.closePopup();
    }
    if (state.activeMobileStore && isPhoneViewport() !== (document.getElementById('sheetDetail')?.hidden === false)) {
        closeMobileStoreCard(); // details live in a different container on this tier
    }
    syncSheetA11y();
    syncSidebarToggle();
    map.invalidateSize();
}
