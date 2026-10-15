// --- Autocomplete & Nominatim Geocoding ---

import {
    escapeHtml,
    debounce,
    getDistanceMiles,
    showToast
} from './utils.js';
import { state } from './state.js';

let autocompleteItems = [];
let activeAutocompleteIndex = -1;
let geocodeAbortController = null;
let activeInputId = 'searchInput';
let activeDropdownId = 'autocompleteDropdown';
let currentAutocompleteAction = 'search'; // 'search' | 'routeOrigin' | 'routeDest'

let searchContext = {
    getMap: () => null,
    onSelectStore: null,
    onSelectGeo: null,
    onSearchInput: null
};

export function initSearch(context) {
    searchContext = { ...searchContext, ...context };
}

export const GEO_META_MAP = {
    postcode: { icon: '📮', label: 'Zip Code' },
    city: { icon: '🏙️', label: 'City' },
    town: { icon: '🏙️', label: 'Town' },
    village: { icon: '🏙️', label: 'Village' },
    hamlet: { icon: '🏙️', label: 'Town' },
    county: { icon: '📍', label: 'County' },
    state: { icon: '📍', label: 'State' },
    suburb: { icon: '📍', label: 'Neighborhood' },
    neighbourhood: { icon: '📍', label: 'Neighborhood' },
    administrative: { icon: '📍', label: 'Area' },
    house: { icon: '🏠', label: 'Address' },
    building: { icon: '🏢', label: 'Building' },
    amenity: { icon: '🏢', label: 'Place' },
    road: { icon: '🛣️', label: 'Street' },
    yes: { icon: '🏠', label: 'Address' }
};

export function getGeoMeta(result) {
    const type = result.addresstype || result.type || 'place';
    return GEO_META_MAP[type] || { icon: '📍', label: 'Location' };
}

export function shortGeoName(result) {
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

export function buildNominatimUrl(query, limit = 5) {
    let url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=${limit}&countrycodes=us&q=${encodeURIComponent(query)}`;
    const map = searchContext.getMap();
    if (map) {
        const b = map.getBounds();
        url += `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
    }
    return url;
}

export function getStoreMatches(query) {
    if (!query) return [];
    const matches = state.stores.filter(s =>
        s.city.toLowerCase().includes(query) ||
        s.address.toLowerCase().includes(query) ||
        s.state.toLowerCase().includes(query)
    );

    const map = searchContext.getMap();
    if (map) {
        const center = map.getCenter();
        matches.sort((a, b) =>
            getDistanceMiles(center.lat, center.lng, a.lat, a.lng) -
            getDistanceMiles(center.lat, center.lng, b.lat, b.lng)
        );
    }
    return matches.slice(0, 5);
}

export async function getGeoMatches(query, { limit = 5, abortPrevious = true } = {}) {
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
        return { lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[2]), label: 'Your location' };
    }
    const matches = await getGeoMatches(query, { limit: 1, abortPrevious: false });
    if (!matches || matches.length === 0) return null;
    const best = matches[0];
    return { lat: parseFloat(best.lat), lng: parseFloat(best.lon), label: shortGeoName(best) };
}

export const debouncedAutocomplete = debounce(async (query) => {
    const storeMatches = getStoreMatches(query);
    renderAutocompleteDropdown(storeMatches, [], query, true);

    const geoMatches = query.length >= 2 ? await getGeoMatches(query) : [];
    const activeInput = document.getElementById(activeInputId);
    if (activeInput && activeInput.value.toLowerCase().trim() === query) {
        renderAutocompleteDropdown(storeMatches, geoMatches, query, false);
    }
}, 400);

export function renderAutocompleteDropdown(storeMatches, geoMatches, query, isLoadingGeo) {
    const dropdown = document.getElementById(activeDropdownId);
    if (!dropdown) return;

    autocompleteItems = [];
    activeAutocompleteIndex = -1;
    let html = '';

    if (storeMatches.length > 0) {
        html += `<div class="autocomplete-section-label">Costco Stores</div>`;
        storeMatches.forEach(store => {
            const idx = autocompleteItems.length;
            autocompleteItems.push({ type: 'store', data: store });
            html += `
                <div class="autocomplete-item" data-action="select-autocomplete" data-index="${idx}">
                    <span class="ac-icon">🛒</span>
                    <div class="ac-text">
                        <div class="ac-title">${escapeHtml(store.city)}, ${escapeHtml(store.state)}</div>
                        <div class="ac-subtitle">${escapeHtml(store.address)}</div>
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
                    <span class="ac-icon">${meta.icon}</span>
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

export function moveAutocompleteSelection(delta) {
    const items = document.querySelectorAll(`#${activeDropdownId} .autocomplete-item`);
    if (items.length === 0) return;
    activeAutocompleteIndex = (activeAutocompleteIndex + delta + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === activeAutocompleteIndex));
    items[activeAutocompleteIndex].scrollIntoView({ block: 'nearest' });
}

export function getAutocompleteLabel(item) {
    return item.type === 'store' ? `${item.data.city}, ${item.data.state}` : shortGeoName(item.data);
}

export function extractLocation(item) {
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
            searchContext.onSelectStore?.(item.data);
        } else {
            searchContext.onSelectGeo?.(item.data);
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

export async function resolveBestMatchAndAct(query) {
    if (!query) return;

    let best = null;
    const storeMatches = getStoreMatches(query);
    if (storeMatches.length > 0) {
        best = { type: 'store', data: storeMatches[0] };
    } else {
        const geoMatches = await getGeoMatches(query);
        if (geoMatches.length > 0) {
            best = { type: 'place', data: geoMatches[0] };
        }
    }

    if (!best) {
        showToast(`No matches found for "${query}"`);
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
            searchContext.onSearchInput?.(query);
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
        if (query.length > 0) debouncedAutocomplete(query);
    });
}
