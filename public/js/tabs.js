// --- Sidebar tabs: switching, rendering the active tab ---

import { loadStatus, renderLoadState } from './data.js';
import {
    renderFavoriteStores,
    renderLowestPrices,
    renderNearbyPrices,
    renderStoresList
} from './lists.js';
import { renderMap } from './markers.js';
import { syncUrl } from './nav.js';
import { clearRouteVisuals, renderRoutePanel } from './routes.js';
import { state } from './state.js';

const TAB_RENDERERS = {
    search: () => renderStoresList(document.getElementById('searchInput')?.value.toLowerCase().trim() || ''),
    lowest: () => renderLowestPrices(),
    nearby: () => renderNearbyPrices(),
    route: () => renderRoutePanel(),
    favorites: () => renderFavoriteStores()
};

export function renderCurrentTab() {
    if (loadStatus !== 'ready') {
        renderLoadState();
        return;
    }
    TAB_RENDERERS[state.currentTab]?.();
}

export function refreshCurrentDisplay() {
    switchTab(state.currentTab);
}

// The tab strip scrolls horizontally on narrow phones; keep the active tab in view.
// (Adjusts the strip's own scrollLeft: scrollIntoView() would also scroll the
// overflow:hidden app container when the sidebar is parked off-screen.)
function keepActiveTabVisible(tabName) {
    const strip = document.getElementById('sidebarTabs');
    const tab = document.getElementById(`tab-${tabName}`);
    if (!strip || !tab || strip.scrollWidth <= strip.clientWidth) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) {
        strip.scrollLeft = left;
    } else if (right > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = right - strip.clientWidth;
    }
}

export function switchTab(tabName) {
    const previousTab = state.currentTab;
    state.currentTab = tabName;

    Object.keys(TAB_RENDERERS).forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        if (!el) return;
        const isActive = t === tabName;
        el.classList.toggle('active', isActive);
        el.setAttribute('aria-selected', String(isActive));
        el.tabIndex = isActive ? 0 : -1; // roving tabindex: arrow keys move between tabs
    });
    keepActiveTabVisible(tabName);

    if (tabName !== 'route') {
        // Only the Route tab changes which stations the map shows, so the markers need
        // rebuilding only when leaving it (not on every tab render or search keystroke).
        if (previousTab === 'route') {
            clearRouteVisuals();
            if (state.stores.length > 0) renderMap(state.stores);
        }
        state.editingRouteId = null;
        state.editSnapshot = null;
    }

    renderCurrentTab();
    syncUrl();
}
