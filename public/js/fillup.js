// --- "Is it worth the drive?": what a fill-up costs at a station, counting the gas burned
//     driving there and back, compared with the nearest station. Pure: no page state. ---
// The iOS app mirrors these rules in ios/CostcoGasKit (FillUp.swift); change both together.

import { getDistanceMiles } from './geo.js';
import { gradeVal, hasGradeData } from './prices.js';

// Roads wind: a drive is about this much longer than the straight line to the station.
export const ROAD_FACTOR = 1.2;
export const DEFAULT_TANK_GALLONS = 15;
export const DEFAULT_MPG = 25;
export const TANK_LIMITS = { min: 1, max: 60 };
export const MPG_LIMITS = { min: 1, max: 150 };
// Savings smaller than this read as "about the same".
const SAME_COST_DOLLARS = 0.05;

// A number from a settings field, or the fallback when it's empty, unreadable or out of range.
export function readCarSetting(value, { min, max }, fallback) {
    const n = parseFloat(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// The cost of filling up at `store`, and of getting there and back from `from`.
// Returns null when the station has no price for the grade. Without `from`, only the
// fill-up cost is known. `stores` is every station, for finding the nearest one.
export function fillUpEstimate(store, grade, { stores = [], from = null, tankGallons, mpg }) {
    if (!hasGradeData(store, grade)) return null;
    const price = gradeVal(store, grade);
    const fillCost = tankGallons * price;
    const result = { price, fillCost, driveMiles: null, driveCost: null, total: null, nearest: null, savings: null };
    if (!from || !store.lat || !store.lng) return result;

    const tripCost = (s) => {
        const p = gradeVal(s, grade);
        const miles = 2 * getDistanceMiles(from.lat, from.lng, s.lat, s.lng) * ROAD_FACTOR;
        return { miles, drive: (miles / mpg) * p, total: tankGallons * p + (miles / mpg) * p };
    };

    const here = tripCost(store);
    result.driveMiles = here.miles;
    result.driveCost = here.drive;
    result.total = here.total;

    let nearest = null;
    let nearestDistance = Infinity;
    for (const s of stores) {
        if (!s.lat || !s.lng || !hasGradeData(s, grade)) continue;
        const d = getDistanceMiles(from.lat, from.lng, s.lat, s.lng);
        if (d < nearestDistance) { nearest = s; nearestDistance = d; }
    }
    if (nearest) {
        result.nearest = {
            state: nearest.state, city: nearest.city, distance: nearestDistance,
            isThis: nearest.state === store.state && nearest.city === store.city
        };
        result.savings = result.nearest.isThis ? 0 : tripCost(nearest).total - here.total;
    }
    return result;
}

// One line comparing a station with the nearest one, e.g. "Saves $2.10 vs Tracy, the nearest
// station". `tone` is 'good', 'bad' or 'neutral'. Null when there's nothing to compare with.
export function fillUpVerdict(estimate) {
    if (!estimate || !estimate.nearest || estimate.savings === null) return null;
    const { nearest, savings } = estimate;
    if (nearest.isThis) return { text: 'The nearest station', short: 'Nearest', tone: 'neutral' };
    const amount = `$${Math.abs(savings).toFixed(2)}`;
    if (Math.abs(savings) < SAME_COST_DOLLARS) {
        return { text: `About the same as ${nearest.city}, the nearest station`, short: 'Same as nearest', tone: 'neutral' };
    }
    return savings > 0
        ? { text: `Saves ${amount} vs ${nearest.city}, the nearest station`, short: `Saves ${amount}`, tone: 'good' }
        : { text: `Costs ${amount} more than ${nearest.city}, the nearest station`, short: `${amount} more`, tone: 'bad' };
}
