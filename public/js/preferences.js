// --- Theme (light / dark / system) and the fuel grade toggle ---

import { refreshChartTheme } from './charts.js';
import { renderMobileStoreCardContent } from './components.js';
import { setMapTiles } from './map.js';
import { refreshMapAndList } from './markers.js';
import { GRADE_KEYS, hasGradeData, shouldFilterStoresByGrade } from './prices.js';
import { closeMobileStoreCard } from './sheet.js';
import { hasExplicitThemePref, saveDarkMode, saveGasPref, state } from './state.js';

export function applyTheme(isDark) {
    state.isDarkMode = isDark;
    document.body.classList.toggle('dark-mode', isDark);
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) themeBtn.setAttribute('aria-pressed', String(isDark)); // sun / moon swap is CSS
    // Browser chrome (address bar, status bar) follows the header surface.
    const surface = getComputedStyle(document.body).getPropertyValue('--surface').trim();
    if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface);
}

// Map tiles and the chart are drawn with theme colours, so redraw them after a theme change.
export function refreshThemedViews() {
    setMapTiles();
    refreshChartTheme();
}

export function initPreferences() {
    applyTheme(state.isDarkMode);
    // Follow the OS light/dark setting until the user picks a theme explicitly.
    const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    systemTheme?.addEventListener?.('change', (e) => {
        if (hasExplicitThemePref()) return;
        applyTheme(e.matches);
        refreshThemedViews();
    });
    syncGradeButtons();
}

export function toggleTheme() {
    const newTheme = !state.isDarkMode;
    saveDarkMode(newTheme);
    applyTheme(newTheme);
    refreshThemedViews();
}

function syncGradeButtons() {
    GRADE_KEYS.forEach(g => {
        const btn = document.getElementById(`btn-${g}`);
        if (!btn) return;
        btn.classList.toggle('active', g === state.gasPref);
        btn.setAttribute('aria-pressed', String(g === state.gasPref));
    });
}

export function setGasPref(pref) {
    saveGasPref(pref);

    syncGradeButtons();

    refreshMapAndList();

    if (state.activeMobileStore) {
        if (shouldFilterStoresByGrade(state.gasPref) && !hasGradeData(state.activeMobileStore, state.gasPref)) {
            closeMobileStoreCard();
        } else {
            renderMobileStoreCardContent(state.activeMobileStore);
        }
    }
}
