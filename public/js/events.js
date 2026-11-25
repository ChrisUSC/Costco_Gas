// --- Page-wide click and keyboard handling (one delegated listener each) ---

import { isChartModalOpen, setHistoryRange, trapModalFocus } from './charts.js';
import { loadData } from './data.js';
import { isPhoneViewport } from './layout.js';
import { renderLowestPrices, setNearbyRadius, setNearbySort } from './lists.js';
import { triggerFindMe } from './location.js';
import { searchThisArea } from './map-interactions.js';
import { flyToStore } from './map.js';
import { closeHistory, openHistory } from './overlays.js';
import { setGasPref, toggleTheme } from './preferences.js';
import {
    cancelEditRoute,
    findGasAlongRoute,
    loadFavoriteRoute,
    removeFavoriteRouteHandler,
    saveCurrentRouteAsFavorite,
    setRouteSort,
    startEditRoute,
    useMyLocationForRoute
} from './routes.js';
import { closeAutocompleteDropdown, selectAutocompleteItem } from './search.js';
import { closeSettings, isSettingsOpen, openSettings, trapSettingsFocus } from './settings.js';
import {
    closeMobileStoreCard,
    setSheetState,
    setSidebarCollapsed
} from './sheet.js';
import { findStore, state } from './state.js';
import { shareStore, toggleFavoriteStoreAndRefresh } from './station-actions.js';
import { refreshCurrentDisplay, switchTab } from './tabs.js';

export function setupEventListeners() {
    document.addEventListener('click', (e) => {
        // Autocomplete close on outside click
        if (!e.target.closest('.route-input') && !e.target.closest('#searchInput') && !e.target.closest('.autocomplete-dropdown')) {
            closeAutocompleteDropdown();
        }

        // Close modal when clicking backdrop
        if (e.target.id === 'settingsModal') {
            closeSettings();
            return;
        }
        if (e.target.id === 'chartModal') {
            closeHistory();
            return;
        }

        // Tab switching
        const tabEl = e.target.closest('[data-tab]');
        if (tabEl) {
            const tabName = tabEl.dataset.tab;
            if (tabName) {
                switchTab(tabName);
                if (isPhoneViewport() && state.mobileViewMode === 'peek') setSheetState('half');
            }
            return;
        }

        // Gas preference toggle
        const gasEl = e.target.closest('[data-gas-pref]');
        if (gasEl) {
            const grade = gasEl.dataset.gasPref;
            if (grade) setGasPref(grade);
            return;
        }

        // Delegated action buttons
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;

        ACTIONS[actionEl.dataset.action]?.(actionEl, actionEl.dataset.state, actionEl.dataset.city);
    });

    const sidebar = document.getElementById('sidebarContent');
    if (sidebar) {
        sidebar.addEventListener('change', (e) => {
            if (e.target.id === 'stateLeaderboardSelect') {
                renderLowestPrices(e.target.value);
            } else if (e.target.id === 'nearbyRadiusSelect') {
                setNearbyRadius(e.target.value);
            } else if (e.target.id === 'nearbySortSelect') {
                setNearbySort(e.target.value);
            } else if (e.target.id === 'routeSortSelect') {
                setRouteSort(e.target.value);
            }
        });
    }
}

// What each [data-action] button does: (element, data-state, data-city) => void.
const ACTIONS = {
    'find-me': () => triggerFindMe(),
    'open-settings': () => openSettings(),
    'close-settings': () => closeSettings(),
    'toggle-theme': () => toggleTheme(),
    'close-modal': () => closeHistory(),
    'retry-load': () => loadData(),
    'directions': () => {}, // a plain link; listed so the click doesn't also select the card
    'close-mobile-sheet': () => closeMobileStoreCard(),
    'toggle-sidebar': () => setSidebarCollapsed(!document.getElementById('appContainer').classList.contains('sidebar-collapsed')),
    'search-this-area': () => searchThisArea(),
    'history': (el, stateCode, city) => { if (stateCode && city) openHistory(stateCode, city); },
    'toggle-favorite': (el, stateCode, city) => { if (stateCode && city) toggleFavoriteStoreAndRefresh(stateCode, city); },
    'share': (el, stateCode, city) => { if (stateCode && city) shareStore(stateCode, city, `${city}, ${stateCode}`); },
    'fly-to-store': (el, stateCode, city) => {
        const store = stateCode && city && findStore(stateCode, city);
        if (store) flyToStore(store);
    },
    'set-history-range': (el) => { if (el.dataset.days !== undefined) setHistoryRange(el.dataset.days); },
    'select-autocomplete': (el) => {
        if (el.dataset.index !== undefined) selectAutocompleteItem(parseInt(el.dataset.index, 10));
    },
    'route-locate': () => useMyLocationForRoute(),
    'route-find': () => findGasAlongRoute(),
    'route-save': () => saveCurrentRouteAsFavorite(),
    'route-cancel-edit': () => cancelEditRoute(),
    'load-favorite-route': (el) => withRouteId(el, (id) => {
        if (state.currentTab !== 'route') switchTab('route');
        loadFavoriteRoute(id);
    }),
    'edit-favorite-route': (el) => withRouteId(el, (id) => {
        if (state.currentTab !== 'route') switchTab('route');
        startEditRoute(id);
    }),
    'delete-favorite-route': (el) => withRouteId(el, (id) => {
        removeFavoriteRouteHandler(id);
        refreshCurrentDisplay();
    }),
    'view-route-map': () => setSheetState('peek')
};

function withRouteId(el, fn) {
    const id = parseInt(el.dataset.routeId, 10);
    if (id) fn(id);
}

export function setupKeyboardSupport() {
    // Tabs: arrow keys / Home / End move between tabs (automatic activation)
    document.getElementById('sidebarTabs')?.addEventListener('keydown', (e) => {
        const tabNames = [...document.querySelectorAll('#sidebarTabs [data-tab]')]
            .filter(el => el.offsetParent !== null) // the Route tab is hidden offline
            .map(el => el.dataset.tab);
        const current = tabNames.indexOf(state.currentTab);
        let next = null;
        if (e.key === 'ArrowRight') next = (current + 1) % tabNames.length;
        else if (e.key === 'ArrowLeft') next = (current - 1 + tabNames.length) % tabNames.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabNames.length - 1;
        if (next === null) return;
        e.preventDefault();
        switchTab(tabNames[next]);
        document.getElementById(`tab-${tabNames[next]}`)?.focus();
    });

    document.addEventListener('keydown', (e) => {
        if (trapSettingsFocus(e) || trapModalFocus(e)) return;

        if (e.key === 'Escape') {
            if (isSettingsOpen()) {
                e.preventDefault();
                closeSettings();
            } else if (isChartModalOpen()) {
                e.preventDefault();
                closeHistory();
            } else if (state.activeMobileStore && !e.target.closest?.('input, select')) {
                closeMobileStoreCard();
            } else if (isPhoneViewport() && state.mobileViewMode !== 'peek' && !e.target.closest?.('input, select')) {
                setSheetState('peek');
                document.getElementById('sheetGrabber')?.focus();
            }
            return;
        }

        // Cards and the sheet handle behave like buttons for Enter / Space.
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.store-card, .mobile-sheet-handle')) {
            e.preventDefault();
            e.target.click();
        }
    });
}
