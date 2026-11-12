// --- Fuel grades, price parsing and formatting, trend arrows ---

import { escapeHtml } from './dom.js';

export const GRADE_INFO = {
    regular: { label: 'Regular', color: '#0f9d6b', valKey: 'regVal', prevKey: 'prevRegVal', strKey: 'regularStr', histKey: 'reg' },
    premium: { label: 'Premium', color: '#3b82f6', valKey: 'premVal', prevKey: 'prevPremVal', strKey: 'premiumStr', histKey: 'prem' },
    diesel:  { label: 'Diesel',  color: '#d97706', valKey: 'dieselVal', prevKey: 'prevDieselVal', strKey: 'dieselStr', histKey: 'diesel' }
};

export const GRADE_KEYS = Object.keys(GRADE_INFO);

export function gradeVal(store, grade) {
    return store[GRADE_INFO[grade].valKey];
}

export function gradePrevVal(store, grade) {
    return store[GRADE_INFO[grade].prevKey];
}

export function gradeStr(store, grade) {
    return store[GRADE_INFO[grade].strKey];
}

export function hasGradeData(store, grade) {
    const v = gradeVal(store, grade);
    return v !== undefined && v !== Infinity && !isNaN(v);
}

// Only filter out stores missing the active grade when viewing Diesel
// (since only a minority of Costco warehouses sell diesel).
export function shouldFilterStoresByGrade(grade) {
    return grade === 'diesel';
}

export function filterStoresForCurrentGrade(dataArray, gasPref) {
    if (!shouldFilterStoresByGrade(gasPref)) return dataArray;
    return dataArray.filter(store => hasGradeData(store, gasPref));
}

export function getVisibleStoreGrades(store) {
    return GRADE_KEYS.filter(g => g !== 'diesel' || hasGradeData(store, 'diesel'));
}

export const getValidPrice = (val) => {
    if (val === null || val === undefined || val === "N/A") return Infinity;
    if (typeof val === 'string') return parseFloat(val.replace('$', '').trim());
    return parseFloat(val);
};

export const formatPriceDisplay = (val) => {
    if (val === null || val === undefined || val === Infinity || isNaN(val)) return "N/A";
    return `$${val.toFixed(2)}`;
};

export function extractGradePrices(pData) {
    if (!pData) return [undefined, undefined, undefined];
    if (Array.isArray(pData)) {
        return [pData[0], pData[1], pData[2]];
    }
    return [
        pData.Regular ?? pData.regular,
        pData.Premium ?? pData.premium,
        pData.Diesel ?? pData.diesel
    ];
}

export function getTrendArrow(current, previous, baselineLabel = 'the last update') {
    if (current === undefined || current === Infinity || isNaN(current)) return '';
    if (previous === undefined || previous === null || previous === Infinity || isNaN(previous)) return '';

    const diff = current - previous;
    if (isNaN(diff)) return '';

    // Arrow plus the size of the move in cents. Never colour alone: the arrow and a
    // screen-reader phrase carry the direction too.
    const labelEscaped = escapeHtml(baselineLabel);
    if (Math.abs(diff) < 0.005) {
        return `<span class="trend trend-flat" title="No change since ${labelEscaped}"><span aria-hidden="true">–</span><span class="sr-only">no change</span></span>`;
    }
    const up = diff > 0;
    const cents = Math.round(Math.abs(diff) * 100);
    return `<span class="trend ${up ? 'trend-up' : 'trend-down'}" title="${up ? 'Up' : 'Down'} $${Math.abs(diff).toFixed(2)} since ${labelEscaped}">`
        + `<span class="trend-arrow" aria-hidden="true">${up ? '▲' : '▼'}</span>`
        + `<span class="trend-amt" aria-hidden="true">${cents}¢</span>`
        + `<span class="sr-only">${up ? 'up' : 'down'} ${cents} cents</span></span>`;
}
