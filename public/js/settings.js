// --- The settings panel: every setting applies as soon as it changes ---

import { isChartModalOpen } from './charts.js';
import { renderMobileStoreCardContent } from './components.js';
import { loadStatus } from './data.js';
import { trapFocus } from './dom.js';
import { popupStore, rebuildMarkersLayer, storePopupHtml, updatePinTiers } from './markers.js';
import { popOverlay, pushOverlay } from './nav.js';
import { closeHistory } from './overlays.js';
import { applyTheme, refreshThemedViews, setGasPref } from './preferences.js';
import {
    DEFAULT_GRADES,
    DIRECTIONS_APPS,
    getThemePref,
    setSetting,
    setThemePref,
    state,
    TAB_NAMES
} from './state.js';
import { renderCurrentTab } from './tabs.js';

let lastFocusedBeforeSettings = null;

export function isSettingsOpen() {
    return document.getElementById('settingsModal')?.classList.contains('active') || false;
}

// Fill the form from the current state (the 🌙 button can change the theme meanwhile).
function syncSettingsForm() {
    const form = document.getElementById('settingsForm');
    if (!form) return;
    form.elements.clusterMarkers.checked = state.clusterMarkers;
    form.elements.colorPins.checked = state.colorPins;
    form.elements.autoLocate.checked = state.autoLocate;
    form.elements.defaultTab.value = state.defaultTab;
    form.elements.defaultGrade.value = state.defaultGrade;
    form.querySelector(`input[name="directionsApp"][value="${state.directionsApp}"]`).checked = true;
    form.querySelector(`input[name="theme"][value="${getThemePref()}"]`).checked = true;
}

export function openSettings({ fromHistory = false } = {}) {
    const modal = document.getElementById('settingsModal');
    if (!modal || isSettingsOpen()) return;
    if (isChartModalOpen()) closeHistory();
    lastFocusedBeforeSettings = document.activeElement;
    syncSettingsForm();
    modal.classList.add('active');
    modal.querySelector('.modal-close')?.focus();
    if (!fromHistory) pushOverlay({ type: 'settings' });
}

export function closeSettings({ fromHistory = false } = {}) {
    const modal = document.getElementById('settingsModal');
    if (!modal || !isSettingsOpen()) return;
    modal.classList.remove('active');
    if (lastFocusedBeforeSettings && document.contains(lastFocusedBeforeSettings)) {
        lastFocusedBeforeSettings.focus();
    }
    lastFocusedBeforeSettings = null;
    if (!fromHistory) popOverlay('settings');
}

// Keeps Tab / Shift+Tab inside the open settings panel. Returns true if handled.
export function trapSettingsFocus(e) {
    return isSettingsOpen() && trapFocus(e, document.getElementById('settingsModal'));
}

// Every setting applies as soon as it changes.
function applySettingChange(name, input) {
    switch (name) {
        case 'clusterMarkers':
            setSetting('clusterMarkers', input.checked);
            rebuildMarkersLayer();
            break;
        case 'colorPins':
            setSetting('colorPins', input.checked);
            updatePinTiers();
            break;
        case 'directionsApp':
            if (!DIRECTIONS_APPS.includes(input.value)) return;
            setSetting('directionsApp', input.value);
            refreshDirectionsLinks();
            break;
        case 'theme':
            setThemePref(input.value);
            applyTheme(state.isDarkMode);
            refreshThemedViews();
            break;
        case 'defaultTab':
            if (TAB_NAMES.includes(input.value)) setSetting('defaultTab', input.value);
            break;
        case 'defaultGrade':
            if (!DEFAULT_GRADES.includes(input.value)) return;
            setSetting('defaultGrade', input.value);
            // Picking a grade also switches to it now, so the change is visible straight away.
            if (input.value !== 'last' && input.value !== state.gasPref) setGasPref(input.value);
            break;
        case 'autoLocate':
            setSetting('autoLocate', input.checked);
            break;
    }
}

// Re-render everything that shows a Directions link so it uses the new app.
function refreshDirectionsLinks() {
    if (loadStatus === 'ready') renderCurrentTab();
    if (state.activeMobileStore) renderMobileStoreCardContent(state.activeMobileStore);
    if (popupStore && popupStore.leafletMarker?.isPopupOpen()) {
        popupStore.leafletMarker.getPopup().setContent(storePopupHtml(popupStore));
    }
}

export function setupSettings() {
    const form = document.getElementById('settingsForm');
    form?.addEventListener('change', (e) => {
        if (e.target.name) applySettingChange(e.target.name, e.target);
    });
}
