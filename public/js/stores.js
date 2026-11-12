// --- Station records: building them from a price snapshot, search matching, addresses, directions links ---

import { extractGradePrices, formatPriceDisplay, getValidPrice } from './prices.js';

// Builds the station list from the store directory and a price snapshot.
export function buildStores(latestData, storeData) {
    const timestampedPrices = latestData.prices || {};
    const previousPrices = latestData.previous || {};
    const loadedStores = [];
    for (const stateCode in storeData) {
        if (!timestampedPrices[stateCode]) continue;
        for (const [cityName, info] of Object.entries(storeData[stateCode])) {
            const pData = timestampedPrices[stateCode][cityName];
            if (!pData) continue;

            const [regVal, premVal, dieselVal] = extractGradePrices(pData).map(getValidPrice);
            const prevData = previousPrices[stateCode]?.[cityName];
            const [prevRegVal, prevPremVal, prevDieselVal] = prevData
                ? extractGradePrices(prevData).map(getValidPrice)
                : [undefined, undefined, undefined];

            loadedStores.push({
                state: stateCode, city: cityName, address: info.address,
                lat: info.lat, lng: info.lng, url: info.url,
                gasHours: info.gas_hours || null, tz: info.tz || null, phone: info.phone || null,
                regularStr: formatPriceDisplay(regVal),
                premiumStr: formatPriceDisplay(premVal),
                dieselStr: formatPriceDisplay(dieselVal),
                regVal, premVal, dieselVal,
                prevRegVal, prevPremVal, prevDieselVal
            });
        }
    }
    return loadedStores;
}

// "CA_Turlock": how stations are named in ?store= links and saved favorites.
export const storeKey = (store) => `${store.state}_${store.city}`;

// Case-insensitive match of a store's city, address or state against a lowercased query.
export function storeMatchesQuery(store, query) {
    return store.city.toLowerCase().includes(query)
        || (store.address || '').toLowerCase().includes(query)
        || store.state.toLowerCase().includes(query);
}

// Store addresses arrive in capitals ("2207 W COMMONWEALTH AVE, ALHAMBRA, CA 91803-1302").
// Title-case them for reading, keeping state codes, compass points and highway prefixes.
const ADDRESS_KEEP_UPPER = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'US', 'PO', 'SR', 'CR', 'FM']);

export function formatAddress(address) {
    if (!address) return '';
    if (/[a-z]/.test(address)) return address; // already mixed case
    const titleWord = w => {
        if (ADDRESS_KEEP_UPPER.has(w)) return w;
        if (/^\d/.test(w)) return w.toLowerCase(); // 4TH -> 4th
        return w.charAt(0) + w.slice(1).toLowerCase();
    };
    const parts = address.split(',');
    return parts.map((part, i) => {
        const isLast = i === parts.length - 1;
        return part.split(' ').map(word => {
            if (isLast && /^[A-Z]{2}$/.test(word)) return word; // state code before the zip
            return word.split('-').map(titleWord).join('-');
        }).join(' ');
    }).join(',');
}

export const DIRECTIONS_APP_LABELS = { google: 'Google Maps', apple: 'Apple Maps', waze: 'Waze' };

// Turn-by-turn directions to the station in the user's chosen app
// (each link opens the app itself on phones that have it installed).
export function directionsUrl(store, app = 'google') {
    const hasCoords = store.lat && store.lng;
    const coords = `${store.lat},${store.lng}`;
    const address = `Costco Gas, ${store.address || `${store.city}, ${store.state}`}`;
    if (app === 'apple') {
        return `https://maps.apple.com/?daddr=${encodeURIComponent(hasCoords ? coords : address)}&dirflg=d`;
    }
    if (app === 'waze') {
        return hasCoords
            ? `https://waze.com/ul?ll=${encodeURIComponent(coords)}&navigate=yes`
            : `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes`;
    }
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(hasCoords ? coords : address)}`;
}
