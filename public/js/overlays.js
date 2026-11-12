// --- Price-history modal entries in browser history, and matching the page to Back / Forward ---

import { closeHistoryModal, isChartModalOpen, openHistoryModal } from './charts.js';
import { isMobileViewport } from './layout.js';
import { currentOverlay, popOverlay, pushOverlay, replaceOverlay } from './nav.js';
import { closeSettings, isSettingsOpen, openSettings } from './settings.js';
import { closeMobileStoreCard, openMobileStoreCard, sheetOverlay } from './sheet.js';
import { findStore, state } from './state.js';

export function openHistory(stateCode, city) {
    openHistoryModal(stateCode, city);
    const active = state.activeMobileStore;
    const overlay = { type: 'modal', state: stateCode, city, sheet: active ? sheetOverlay(active) : null };
    if (currentOverlay()?.type === 'modal') replaceOverlay(overlay);
    else pushOverlay(overlay);
}

export function closeHistory() {
    if (!isChartModalOpen()) return;
    closeHistoryModal();
    popOverlay('modal');
}

// Browser Back / Forward landed on an entry: make the sheet and modal match it.
export function applyOverlayFromHistory(overlay) {
    const wantSettings = overlay?.type === 'settings';
    if (isSettingsOpen() && !wantSettings) closeSettings({ fromHistory: true });
    else if (wantSettings && !isSettingsOpen()) openSettings({ fromHistory: true });

    const wantModal = overlay?.type === 'modal';
    if (isChartModalOpen() && !wantModal) closeHistoryModal();
    else if (wantModal && !isChartModalOpen()) openHistoryModal(overlay.state, overlay.city);

    const want = overlay?.type === 'sheet' ? overlay : overlay?.sheet || null;
    const cur = state.activeMobileStore;
    if (cur && !want) {
        closeMobileStoreCard({ fromHistory: true });
    } else if (want && isMobileViewport() && !(cur && cur.state === want.state && cur.city === want.city)) {
        const store = findStore(want.state, want.city);
        if (store) openMobileStoreCard(store, { fromHistory: true });
    }
}
