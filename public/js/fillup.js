// --- Fill-up cost, and the best value along a route: your usual fill-up plus the detour to
//     reach each station and get back on the route. Pure: no page state. ---
// The iOS app mirrors these rules in ios/CostcoGasKit (FillUp.swift); change both together.

import { gradeVal, hasGradeData } from './prices.js';

// Roads wind: a drive is about this much longer than the straight line.
export const ROAD_FACTOR = 1.2;
export const DEFAULT_FILL_GALLONS = 12;
export const DEFAULT_MPG = 25;
export const GALLON_LIMITS = { min: 1, max: 60 };
export const MPG_LIMITS = { min: 1, max: 150 };
export const ROUTE_SORTS = ['value', 'price'];
// Totals closer than this to the best one also count as the best value.
const SAME_COST_DOLLARS = 0.05;

// A number from a settings field, or the fallback when it's empty, unreadable or out of range.
export function readCarSetting(value, { min, max }, fallback) {
    const n = parseFloat(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// What your usual fill-up costs at a price.
export function fillCost(price, gallons) {
    return price * gallons;
}

// The extra road miles a stop at each station adds to a trip, from an OSRM /table reply for
// the points [origin, station 1 … station n, destination] with sources 0…n and destinations
// 1…n+1 (distances in metres): origin → station + station → destination − the direct route.
// Null for a station the router couldn't reach.
export function roadDetourMiles(distances, stationCount, routeMiles) {
    const out = [];
    for (let i = 0; i < stationCount; i++) {
        const toStation = distances?.[0]?.[i];
        const toDestination = distances?.[i + 1]?.[stationCount];
        out.push(Number.isFinite(toStation) && Number.isFinite(toDestination)
            ? Math.max(0, (toStation + toDestination) / 1609.34 - routeMiles)
            : null);
    }
    return out;
}

// Each station along a route with a price for the grade, cheapest overall first: the fill-up
// plus the detour. The detour is `store.detourMiles` (road miles, from roadDetourMiles) when
// known, else an estimate: off the route to the station and back, `store.distance` miles each
// way, allowing for winding roads. `extraVsBest` is how much more it costs than the best one;
// `isBest` marks the best (and any within a few cents of it).
export function routeStopCosts(along, grade, { gallons, mpg }) {
    const stops = along
        .filter(s => hasGradeData(s, grade))
        .map(store => {
            const price = gradeVal(store, grade);
            const detourMiles = Number.isFinite(store.detourMiles) ? store.detourMiles : 2 * (store.distance || 0) * ROAD_FACTOR;
            const detourCost = (detourMiles / mpg) * price;
            const fill = fillCost(price, gallons);
            return { store, price, detourMiles, detourCost, fillCost: fill, total: fill + detourCost };
        })
        .sort((a, b) => a.total - b.total || a.price - b.price);
    const best = stops.length ? stops[0].total : 0;
    return stops.map(s => ({ ...s, extraVsBest: s.total - best, isBest: s.total - best < SAME_COST_DOLLARS }));
}
