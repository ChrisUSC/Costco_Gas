// --- Entry point: starts the app ---
// Each module in js/ owns one part of the page (the README lists them). Modules import each
// other freely, including in cycles, so a module's top level only declares things; nothing
// runs until the calls below, after every module has loaded.

import { loadData, refreshLastUpdatedLabel } from './js/data.js';
import { setupEventListeners, setupKeyboardSupport } from './js/events.js';
import { initMapInteractions, lockPageZoomOnPhones } from './js/map-interactions.js';
import { initMap } from './js/map.js';
import { popupStore } from './js/markers.js';
import { initialUrl, initNav } from './js/nav.js';
import { registerServiceWorker, setupOfflineHandling } from './js/offline.js';
import { applyOverlayFromHistory } from './js/overlays.js';
import { initPreferences } from './js/preferences.js';
import { initSearchPlaceholder, setupInputAutocomplete } from './js/search.js';
import { setupSettings } from './js/settings.js';
import { initSheet } from './js/sheet.js';
import { state } from './js/state.js';
import { sharedStoreKey } from './js/station-actions.js';
import { storeKey } from './js/stores.js';
import { switchTab } from './js/tabs.js';

// A shared link's tab and grade win over the defaults (without overwriting the saved grade).
if (initialUrl.grade) state.gasPref = initialUrl.grade;
state.currentTab = initialUrl.tab || state.defaultTab;

initNav({
    getView: () => {
        const openStore = state.activeMobileStore || popupStore;
        return {
            tab: state.currentTab,
            grade: state.gasPref,
            state: state.currentTab === 'lowest' ? state.currentStateContext : null,
            // Keep ?store= from a shared link until the data has loaded and it can be opened.
            store: openStore ? storeKey(openStore) : sharedStoreKey
        };
    },
    applyOverlay: applyOverlayFromHistory
});

initPreferences();
initSearchPlaceholder();
lockPageZoomOnPhones();
registerServiceWorker();
setupOfflineHandling();
initMap();
initSheet();
initMapInteractions();
setupInputAutocomplete('searchInput', 'autocompleteDropdown', 'search');
setupEventListeners();
setupKeyboardSupport();
setupSettings();
switchTab(state.currentTab); // highlight the tab from the URL while the data loads
loadData();
setInterval(refreshLastUpdatedLabel, 60000);
