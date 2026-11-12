// --- Map gestures and controls: page-zoom lock on phones, double-tap zoom, "Search this area", list/pin hover link ---

import { showToast } from './dom.js';
import { isPhoneViewport } from './layout.js';
import { updateClosestStoreState } from './location.js';
import { map, placeSearchMarker } from './map.js';
import { findStore, state } from './state.js';
import { switchTab } from './tabs.js';

export function initMapInteractions() {
    setupMapAreaSearch();
    setupDoubleTapZoom();
}

// styles.css stops pinch / double-tap page zoom with touch-action (same media query). iOS
// Safari doesn't always honour that for pinch, so also cancel its page-zoom gestures when
// they start outside the map. The map's own pinch zoom is Leaflet's, from touch events.
const ZOOM_LOCK_QUERY = '(max-width: 599px), (pointer: coarse) and (max-height: 500px)';

export function lockPageZoomOnPhones() {
    const phone = window.matchMedia?.(ZOOM_LOCK_QUERY);
    if (!phone) return;
    const cancel = (e) => {
        if (phone.matches && !(e.target instanceof Element && e.target.closest('#map'))) e.preventDefault();
    };
    ['gesturestart', 'gesturechange'].forEach(type => document.addEventListener(type, cancel, { passive: false }));
}

// Leaflet relies on the browser's dblclick. Browsers that don't send one for touch (iOS
// Safari) fall back to Leaflet's own detection, which only counts two taps within 200ms, so
// a relaxed double-tap does nothing. Touch is detected here instead, with a wider window.
const DOUBLE_TAP_MS = 350;      // max gap between the two taps
const DOUBLE_TAP_SLOP_PX = 40;  // max distance between the two taps
const TAP_MOVE_PX = 12;         // more movement than this is a drag, not a tap
const TAP_HOLD_MS = 350;        // a longer press is not a tap

export function setupDoubleTapZoom() {
    const mapEl = map.getContainer();
    const isMapSurface = (e) => !e.target.closest?.('.leaflet-marker-icon, .leaflet-control, .leaflet-popup');
    const zoomAt = (e, delta) => {
        lastUserZoomInput = Date.now(); // counts as a user zoom for "Search this area"
        map.setZoomAround(map.mouseEventToContainerPoint(e), map.getZoom() + delta);
    };

    let lastPointerType = 'mouse';
    let press = null;       // the touch currently down
    let lastTap = null;     // { x, y, t } of the previous tap
    let pointersDown = 0;

    mapEl.addEventListener('pointerdown', (e) => {
        lastPointerType = e.pointerType;
        if (e.pointerType === 'mouse') return;
        pointersDown++;
        if (pointersDown > 1) { press = null; lastTap = null; return; } // pinch, not a tap
        press = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false };
    });
    mapEl.addEventListener('pointermove', (e) => {
        if (!press || e.pointerType === 'mouse') return;
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_MOVE_PX) press.moved = true;
    });
    const endPress = (e) => {
        if (e.pointerType === 'mouse') return;
        pointersDown = Math.max(0, pointersDown - 1);
        const p = press;
        press = null;
        if (!p || e.type === 'pointercancel' || p.moved || e.timeStamp - p.t > TAP_HOLD_MS || !isMapSurface(e)) {
            lastTap = null;
            return;
        }
        if (lastTap && e.timeStamp - lastTap.t <= DOUBLE_TAP_MS
            && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= DOUBLE_TAP_SLOP_PX) {
            lastTap = null;
            zoomAt(e, map.options.zoomDelta);
        } else {
            lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
        }
    };
    mapEl.addEventListener('pointerup', endPress);
    mapEl.addEventListener('pointercancel', endPress);

    // Mouse double-click (Shift zooms out). The dblclick some browsers fire after a touch
    // double-tap is ignored: the handler above has already zoomed.
    mapEl.addEventListener('dblclick', (e) => {
        if (lastPointerType !== 'mouse' || !isMapSurface(e)) return;
        e.preventDefault();
        zoomAt(e, e.shiftKey ? -map.options.zoomDelta : map.options.zoomDelta);
    });
}

// Only a drag or a zoom the user performed reveals the button; our own flyTo/fitBounds
// calls also fire zoomend, so zoom counts only right after a wheel, pinch, key or +/- tap.
let lastUserZoomInput = 0;

export function setSearchAreaVisible(visible) {
    const btn = document.getElementById('searchAreaBtn');
    if (btn) btn.hidden = !visible || isPhoneViewport();
}

export function searchThisArea() {
    if (!map) return;
    const c = map.getCenter();
    state.userLocation = { lat: c.lat, lng: c.lng };
    placeSearchMarker([c.lat, c.lng], '<b>Search centre</b>');
    updateClosestStoreState(state.userLocation);
    setSearchAreaVisible(false);
    switchTab('nearby');
    showToast('Showing stations near the centre of the map');
}

function setupMapAreaSearch() {
    // Only a drag or a user zoom reveals the button, not our own flyTo/fitBounds calls.
    const mapEl = map.getContainer();
    const noteZoomInput = () => { lastUserZoomInput = Date.now(); };
    ['wheel', 'dblclick'].forEach(t => mapEl.addEventListener(t, noteZoomInput, { passive: true }));
    mapEl.addEventListener('touchstart', (e) => { if (e.touches.length > 1) noteZoomInput(); }, { passive: true });
    mapEl.addEventListener('keydown', (e) => { if (/^[-+=]$/.test(e.key)) noteZoomInput(); });
    mapEl.addEventListener('click', (e) => { if (e.target.closest('.leaflet-control-zoom')) noteZoomInput(); });
    map.on('dragend', () => setSearchAreaVisible(true));
    map.on('zoomend', () => { if (Date.now() - lastUserZoomInput < 1500) setSearchAreaVisible(true); });

    // Hovering a card highlights its pin (mouse only; touch has no hover).
    const content = document.getElementById('sidebarContent');
    if (!content || !window.matchMedia?.('(hover: hover)').matches) return;
    const setPinLinked = (card, on) => {
        const store = card && card.dataset.state && findStore(card.dataset.state, card.dataset.city);
        const marker = store && store.leafletMarker;
        if (!marker) return;
        marker.setZIndexOffset(on ? 2000 : 0);
        marker.getElement()?.classList.toggle('pin-linked', on);
    };
    content.addEventListener('mouseover', (e) => {
        const card = e.target.closest('.store-card[data-city]');
        if (card && !card.contains(e.relatedTarget)) setPinLinked(card, true);
    });
    content.addEventListener('mouseout', (e) => {
        const card = e.target.closest('.store-card[data-city]');
        if (card && !card.contains(e.relatedTarget)) setPinLinked(card, false);
    });
}
