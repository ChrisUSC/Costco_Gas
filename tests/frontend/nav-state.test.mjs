// URL parameters (nav.js) and saved preferences (state.js). These modules read `window`
// and localStorage, so give them a minimal stand-in before importing.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { location: new URL('https://example.test/'), matchMedia: () => ({ matches: false }) };
// Settings a returning visitor saved, including two invalid ones that must fall back.
const saved = new Map(Object.entries({
    gasPref: 'diesel', clusterMarkers: 'false', nearbyRadius: '25', favoriteStores: '["CA_Turlock"]',
    defaultTab: 'admin', directionsApp: 'mapquest', favoriteRoutes: '{not json',
}));
globalThis.localStorage = {
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, String(v)),
    removeItem: (k) => saved.delete(k),
};
const { readUrlParams } = await import('../../public/js/nav.js');
const { state, favoriteKey, findStore, isFavoriteStore, setTabVisible, toggleFavoriteStore, TAB_NAMES, visibleTabs } = await import('../../public/js/state.js');

const withSearch = (search) => {
    window.location = new URL(`https://example.test/${search}`);
    return readUrlParams();
};

describe('readUrlParams', () => {
    test('reads a valid tab, grade and state', () => {
        assert.deepEqual(withSearch('?tab=lowest&grade=diesel&state=tx'), { tab: 'lowest', grade: 'diesel', state: 'TX', store: null });
    });

    test('ignores unknown or malformed values', () => {
        assert.deepEqual(withSearch('?tab=admin&grade=e85&state=Texas'), { tab: null, grade: null, state: null, store: null });
        assert.deepEqual(withSearch(''), { tab: null, grade: null, state: null, store: null });
    });

    test('keeps a shared ?store= link for later', () => {
        assert.equal(withSearch('?store=CA_Turlock').store, 'CA_Turlock');
    });

    test('every tab name round-trips', () => {
        for (const tab of TAB_NAMES) assert.equal(withSearch(`?tab=${tab}`).tab, tab);
    });
});

describe('state', () => {
    before(() => {
        state.stores = [
            { state: 'CA', city: 'Turlock' },
            { state: 'TX', city: 'Austin' },
        ];
    });

    test('saved settings are restored', () => {
        assert.equal(state.gasPref, 'diesel');
        assert.equal(state.clusterMarkers, false);
        assert.equal(state.nearbyRadiusMiles, 25);
        assert.equal(isFavoriteStore('CA', 'Turlock'), true);
    });

    test('invalid or unreadable saved settings fall back to the defaults', () => {
        assert.equal(state.defaultTab, 'nearby');
        assert.equal(state.directionsApp, 'google');
        assert.deepEqual(state.favoriteRoutes, []);
        assert.equal(state.colorPins, false);   // never saved: default off
        assert.equal(state.autoLocate, true);   // never saved: default on
        assert.equal(state.isDarkMode, false);  // follows the (light) system setting
    });

    test('All stations starts hidden; the other tabs are shown', () => {
        assert.deepEqual(state.hiddenTabs, ['search']);
        assert.deepEqual(visibleTabs(), ['nearby', 'lowest', 'route', 'favorites']);
    });

    test('hiding tabs saves the change, moves the start tab and keeps at least one tab', () => {
        setTabVisible('nearby', false);
        assert.deepEqual(JSON.parse(saved.get('hiddenTabs')), ['nearby', 'search']);
        assert.equal(state.defaultTab, 'lowest');
        for (const t of ['lowest', 'route', 'favorites']) setTabVisible(t, false);
        assert.deepEqual(visibleTabs(), ['favorites']); // the last one can't be hidden
        for (const t of TAB_NAMES) setTabVisible(t, true);
        assert.deepEqual(state.hiddenTabs, []);
    });

    test('toggling a favorite saves the change', () => {
        assert.equal(toggleFavoriteStore('TX', 'Austin'), true);
        assert.deepEqual(JSON.parse(saved.get('favoriteStores')), ['CA_Turlock', 'TX_Austin']);
        assert.equal(toggleFavoriteStore('TX', 'Austin'), false);
        assert.deepEqual(JSON.parse(saved.get('favoriteStores')), ['CA_Turlock']);
    });

    test('favoriteKey and findStore identify a station by state and city', () => {
        assert.equal(favoriteKey('CA', 'Turlock'), 'CA_Turlock');
        assert.deepEqual(findStore('TX', 'Austin'), { state: 'TX', city: 'Austin' });
        assert.equal(findStore('TX', 'Turlock'), undefined);
    });
});
