// --- Autocomplete & Nominatim Geocoding ---

import { debounce, escapeHtml, showToast } from './dom.js';
import { getDistanceMiles } from './geo.js';
import { icon } from './icons.js';
import { flyToGeoResult, flyToStore, map } from './map.js';
import { state } from './state.js';
import { formatAddress, storeMatchesQuery } from './stores.js';
import { switchTab } from './tabs.js';

let autocompleteItems = [];
let activeAutocompleteIndex = -1;
let geocodeAbortController = null;
let activeInputId = 'searchInput';
let activeDropdownId = 'autocompleteDropdown';
let currentAutocompleteAction = 'search'; // 'search' | 'routeOrigin' | 'routeDest'


const GEO_META_MAP = {
    postcode: { label: 'Zip Code' },
    city: { label: 'City' },
    town: { label: 'Town' },
    village: { label: 'Village' },
    hamlet: { label: 'Town' },
    county: { label: 'County' },
    state: { label: 'State' },
    suburb: { label: 'Neighborhood' },
    neighbourhood: { label: 'Neighborhood' },
    administrative: { label: 'Area' },
    house: { label: 'Address' },
    building: { label: 'Building' },
    amenity: { label: 'Place' },
    road: { label: 'Street' },
    yes: { label: 'Address' }
};

function getGeoMeta(result) {
    const type = result.addresstype || result.type || 'place';
    return GEO_META_MAP[type] || { label: 'Location' };
}

function shortGeoName(result) {
    const addr = result.address || {};
    let street = '';
    if (addr.house_number && addr.road) {
        street = `${addr.house_number} ${addr.road}`;
    } else if (addr.road) {
        street = addr.road;
    } else if (addr.amenity || addr.shop || addr.building) {
        street = addr.amenity || addr.shop || addr.building;
    }

    const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || '';
    const stateVal = addr['ISO3166-2-lvl4'] ? addr['ISO3166-2-lvl4'].split('-')[1] : (addr.state || '');

    if (street) {
        return [street, city, stateVal].filter(Boolean).join(', ');
    }

    const main = city || result.display_name.split(',')[0];
    if (addr.postcode && result.addresstype === 'postcode') {
        return stateVal ? `${addr.postcode} \u2014 ${main}, ${stateVal}` : `${addr.postcode} \u2014 ${main}`;
    }
    return stateVal ? `${main}, ${stateVal}` : main;
}

function buildNominatimUrl(query, limit = 5) {
    let url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=${limit}&countrycodes=us&q=${encodeURIComponent(query)}`;
    if (map) {
        const b = map.getBounds();
        url += `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
    }
    return url;
}

function getStoreMatches(query) {
    if (!query) return [];
    const matches = state.stores.filter(s => storeMatchesQuery(s, query));

    if (map) {
        const center = map.getCenter();
        matches.sort((a, b) =>
            getDistanceMiles(center.lat, center.lng, a.lat, a.lng) -
            getDistanceMiles(center.lat, center.lng, b.lat, b.lng)
        );
    }
    return matches.slice(0, 5);
}

async function getGeoMatches(query, { limit = 5, abortPrevious = true } = {}) {
    try {
        let signal;
        if (abortPrevious) {
            if (geocodeAbortController) geocodeAbortController.abort();
            geocodeAbortController = new AbortController();
            signal = geocodeAbortController.signal;
        }
        const res = await fetch(buildNominatimUrl(query, limit), {
            signal,
            headers: { 'Accept-Language': 'en-US' }
        });
        return res.ok ? await res.json() : [];
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('Geocode lookup failed:', e);
        return [];
    }
}

export async function geocodeAddress(query) {
    const coordMatch = query.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
        // Labelled with the coordinates themselves: "Your location" means the device's
        // current position (saved routes re-resolve it), which typed coordinates are not.
        const lat = parseFloat(coordMatch[1]), lng = parseFloat(coordMatch[2]);
        return { lat, lng, label: `${lat}, ${lng}` };
    }
    const matches = await getGeoMatches(query, { limit: 1, abortPrevious: false });
    if (!matches || matches.length === 0) return null;
    const best = matches[0];
    return { lat: parseFloat(best.lat), lng: parseFloat(best.lon), label: shortGeoName(best) };
}

const debouncedAutocomplete = debounce(async (query) => {
    const storeMatches = getStoreMatches(query);
    renderAutocompleteDropdown(storeMatches, [], query, !state.offline);

    // Place lookup needs a connection; offline only stations are searched.
    const geoMatches = query.length >= 2 && !state.offline ? await getGeoMatches(query) : [];
    const activeInput = document.getElementById(activeInputId);
    if (activeInput && activeInput.value.toLowerCase().trim() === query) {
        renderAutocompleteDropdown(storeMatches, geoMatches, query, false);
    }
}, 400);

function renderAutocompleteDropdown(storeMatches, geoMatches, query, isLoadingGeo) {
    const dropdown = document.getElementById(activeDropdownId);
    if (!dropdown) return;

    autocompleteItems = [];
    activeAutocompleteIndex = -1;
    let html = '';

    if (storeMatches.length > 0) {
        html += `<div class="autocomplete-section-label">Costco stations</div>`;
        storeMatches.forEach(store => {
            const idx = autocompleteItems.length;
            autocompleteItems.push({ type: 'store', data: store });
            html += `
                <div class="autocomplete-item" data-action="select-autocomplete" data-index="${idx}">
                    <span class="ac-icon ac-icon-store">${icon('fuel', 16)}</span>
                    <div class="ac-text">
                        <div class="ac-title">${escapeHtml(store.city)}, ${escapeHtml(store.state)}</div>
                        <div class="ac-subtitle">${escapeHtml(formatAddress(store.address))}</div>
                    </div>
                </div>`;
        });
    }

    if (geoMatches.length > 0) {
        html += `<div class="autocomplete-section-label">Locations</div>`;
        geoMatches.forEach(result => {
            const idx = autocompleteItems.length;
            autocompleteItems.push({ type: 'place', data: result });
            const meta = getGeoMeta(result);
            html += `
                <div class="autocomplete-item" data-action="select-autocomplete" data-index="${idx}">
                    <span class="ac-icon">${icon('pin', 16)}</span>
                    <div class="ac-text">
                        <div class="ac-title">${escapeHtml(shortGeoName(result))}</div>
                        <div class="ac-subtitle">${escapeHtml(meta.label)}</div>
                    </div>
                </div>`;
        });
    } else if (isLoadingGeo && query.length >= 2) {
        html += `<div class="autocomplete-loading">Searching locations…</div>`;
    }

    if (html === '') {
        if (query.length >= 1) {
            html = `<div class="autocomplete-empty">No matches found</div>`;
        } else {
            dropdown.classList.remove('active');
            dropdown.innerHTML = '';
            return;
        }
    }

    dropdown.innerHTML = html;
    dropdown.classList.add('active');
}

function moveAutocompleteSelection(delta) {
    const items = document.querySelectorAll(`#${activeDropdownId} .autocomplete-item`);
    if (items.length === 0) return;
    activeAutocompleteIndex = (activeAutocompleteIndex + delta + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === activeAutocompleteIndex));
    items[activeAutocompleteIndex].scrollIntoView({ block: 'nearest' });
}

function getAutocompleteLabel(item) {
    return item.type === 'store' ? `${item.data.city}, ${item.data.state}` : shortGeoName(item.data);
}

function extractLocation(item) {
    return {
        lat: item.type === 'store' ? item.data.lat : parseFloat(item.data.lat),
        lng: item.type === 'store' ? item.data.lng : parseFloat(item.data.lon),
        label: getAutocompleteLabel(item)
    };
}

export function selectAutocompleteItem(idx) {
    const item = autocompleteItems[idx];
    if (!item) return;

    if (currentAutocompleteAction === 'search') {
        if (item.type === 'store') {
            flyToStore(item.data);
        } else {
            flyToGeoResult(item.data);
        }
        document.getElementById('searchInput')?.blur();
    } else if (currentAutocompleteAction === 'routeOrigin') {
        const input = document.getElementById('routeOrigin');
        if (input) input.value = getAutocompleteLabel(item);
        state.routeOriginLocation = extractLocation(item);
    } else if (currentAutocompleteAction === 'routeDest') {
        const input = document.getElementById('routeDestination');
        if (input) input.value = getAutocompleteLabel(item);
        state.routeDestLocation = extractLocation(item);
    }

    closeAutocompleteDropdown();
}

export function closeAutocompleteDropdown() {
    document.querySelectorAll('.autocomplete-dropdown').forEach(dropdown => {
        dropdown.classList.remove('active');
        dropdown.innerHTML = '';
    });
    autocompleteItems = [];
    activeAutocompleteIndex = -1;
}

async function resolveBestMatchAndAct(query) {
    if (!query) return;

    let best = null;
    const storeMatches = getStoreMatches(query);
    if (storeMatches.length > 0) {
        best = { type: 'store', data: storeMatches[0] };
    } else if (!state.offline) {
        const geoMatches = await getGeoMatches(query);
        if (geoMatches.length > 0) {
            best = { type: 'place', data: geoMatches[0] };
        }
    }

    if (!best) {
        showToast(state.offline ? `No stations match "${query}"` : `No matches found for "${query}"`);
        document.getElementById(activeInputId)?.blur();
        return;
    }

    autocompleteItems = [best];
    selectAutocompleteItem(0);
}

export function setupInputAutocomplete(inputId, dropdownId, actionType) {
    const inputEl = document.getElementById(inputId);
    if (!inputEl) return;

    inputEl.addEventListener('input', (e) => {
        activeInputId = inputId;
        activeDropdownId = dropdownId;
        currentAutocompleteAction = actionType;

        if (actionType === 'routeOrigin') state.routeOriginLocation = null;
        if (actionType === 'routeDest') state.routeDestLocation = null;

        const query = e.target.value.toLowerCase().trim();
        if (actionType === 'search') {
            switchTab('search');
        }

        if (query.length === 0) {
            closeAutocompleteDropdown();
            return;
        }
        debouncedAutocomplete(query);
    });

    inputEl.addEventListener('keydown', (e) => {
        const dropdownEl = document.getElementById(dropdownId);
        const dropdownActive = !!dropdownEl && dropdownEl.classList.contains('active');

        if (e.key === 'ArrowDown' && dropdownActive) {
            e.preventDefault();
            moveAutocompleteSelection(1);
        } else if (e.key === 'ArrowUp' && dropdownActive) {
            e.preventDefault();
            moveAutocompleteSelection(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (dropdownActive && activeAutocompleteIndex >= 0) {
                selectAutocompleteItem(activeAutocompleteIndex);
            } else if (dropdownActive && autocompleteItems.length > 0) {
                selectAutocompleteItem(0);
            } else {
                const query = e.target.value.toLowerCase().trim();
                if (query) resolveBestMatchAndAct(query);
            }
        } else if (e.key === 'Escape' && dropdownActive) {
            closeAutocompleteDropdown();
        }
    });

    inputEl.addEventListener('focus', () => {
        if (activeInputId !== inputId) closeAutocompleteDropdown();
        activeInputId = inputId;
        activeDropdownId = dropdownId;
        currentAutocompleteAction = actionType;

        const query = inputEl.value.toLowerCase().trim();
        // A route field that already holds the chosen place (e.g. "Your location") has
        // nothing to look up; searching for its label would only show "No matches".
        const chosen = actionType === 'routeOrigin' ? state.routeOriginLocation
            : actionType === 'routeDest' ? state.routeDestLocation : null;
        if (chosen && chosen.label.toLowerCase() === query) return;
        if (query.length > 0) debouncedAutocomplete(query);
    });
}

// On narrow phones the search box shares its row with the grade toggle, so the
// full placeholder is cut off ("Search city or z…"). Use a short one there.
const SEARCH_PLACEHOLDER_FULL = 'Search city or zip';
const SEARCH_PLACEHOLDER_SHORT = 'City or zip';
const SEARCH_PLACEHOLDER_OFFLINE = 'Search stations'; // places need a connection

export function applySearchPlaceholder() {
    const input = document.getElementById('searchInput');
    if (!input) return;
    const narrow = window.matchMedia?.('(max-width: 480px)').matches;
    input.placeholder = state.offline ? SEARCH_PLACEHOLDER_OFFLINE
        : narrow ? SEARCH_PLACEHOLDER_SHORT : SEARCH_PLACEHOLDER_FULL;
}

export function initSearchPlaceholder() {
    applySearchPlaceholder();
    window.matchMedia?.('(max-width: 480px)').addEventListener?.('change', applySearchPlaceholder);
}
