// --- The settings panel: every setting applies as soon as it changes ---

import { isChartModalOpen } from './charts.js';
import { renderMobileStoreCardContent } from './components.js';
import { loadStatus } from './data.js';
import { trapFocus } from './dom.js';
import { MPG_LIMITS, readCarSetting, TANK_LIMITS } from './fillup.js';
import { popupStore, rebuildMarkersLayer, storePopupHtml, updatePinTiers } from './markers.js';
import { popOverlay, pushOverlay } from './nav.js';
import { closeHistory } from './overlays.js';
import { applyTheme, refreshThemedViews, setGasPref } from './preferences.js';
import {
    DEFAULT_GRADES,
    DIRECTIONS_APPS,
    getThemePref,
    setSetting,
    setTabVisible,
    setThemePref,
    state,
    TAB_NAMES,
    visibleTabs
} from './state.js';
import { renderCurrentTab, switchTab } from './tabs.js';

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
    form.elements.tankGallons.value = state.tankGallons;
    form.elements.mpg.value = state.mpg;
    syncTabSettings(form);
    form.elements.defaultGrade.value = state.defaultGrade;
    form.querySelector(`input[name="directionsApp"][value="${state.directionsApp}"]`).checked = true;
    form.querySelector(`input[name="theme"][value="${getThemePref()}"]`).checked = true;
}

// The tab switches, and the "Start on tab" choices limited to the tabs that are shown.
function syncTabSettings(form) {
    const shown = visibleTabs();
    form.querySelectorAll('input[name="showTab"]').forEach(input => {
        input.checked = shown.includes(input.value);
        input.disabled = input.checked && shown.length === 1; // keep at least one tab
    });
    [...form.elements.defaultTab.options].forEach(opt => {
        opt.disabled = !shown.includes(opt.value);
    });
    form.elements.defaultTab.value = state.defaultTab;
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
            refreshStationViews();
            break;
        case 'theme':
            setThemePref(input.value);
            applyTheme(state.isDarkMode);
            refreshThemedViews();
            break;
        case 'defaultTab':
            if (state.hiddenTabs.includes(input.value)) return;
            if (TAB_NAMES.includes(input.value)) setSetting('defaultTab', input.value);
            break;
        case 'showTab':
            setTabVisible(input.value, input.checked);
            // Leave a tab that was just switched off (switchTab also updates the strip).
            switchTab(state.hiddenTabs.includes(state.currentTab) ? visibleTabs()[0] : state.currentTab);
            syncTabSettings(input.form);
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
        case 'tankGallons':
        case 'mpg': {
            const limits = name === 'mpg' ? MPG_LIMITS : TANK_LIMITS;
            const value = readCarSetting(input.value, limits, null);
            if (value === null) { // out of range or empty: put back the saved value
                input.value = state[name];
                return;
            }
            setSetting(name, value);
            refreshStationViews();
            break;
        }
    }
}

// Re-render the station cards, details and popup (Directions links and fill-up costs).
function refreshStationViews() {
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
