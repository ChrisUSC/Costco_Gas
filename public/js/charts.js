// --- Lazy-Loaded Price History & Chart.js Modal ---

import { escapeHtml, prefersReducedMotion, trapFocus } from './dom.js';
import { icon } from './icons.js';
import { extractGradePrices, getValidPrice, GRADE_INFO, GRADE_KEYS } from './prices.js';
import { saveHistoryRangeDays, state } from './state.js';
import { parseScraperTimestamp } from './time.js';

let globalHistory = {};
let priceChartInstance = null;
let historyLoaded = false;
let historyLoadPromise = null;
let currentModalState = null;
let currentModalCity = null;
let lastFocusedBeforeModal = null;

// Show a dot on every day (including unchanged ones) when the range has this many points or fewer.
const SHOW_ALL_DOTS_MAX_POINTS = 45;

export const HISTORY_RANGE_OPTIONS = [
    { label: '7D', days: 7 },
    { label: '30D', days: 30 },
    { label: '90D', days: 90 },
    { label: '1Y', days: 365 },
    { label: 'All', days: 0 }
];

// Forget the parsed history so the next chart fetches it again (after fresh prices arrive).
export function resetHistoryCache() {
    globalHistory = {};
    historyLoaded = false;
    historyLoadPromise = null;
}

export function ensureHistoryLoaded() {
    if (historyLoaded) return Promise.resolve();
    if (historyLoadPromise) return historyLoadPromise;

    const cacheBuster = state.latestTimestamp ? encodeURIComponent(state.latestTimestamp) : Date.now();
    historyLoadPromise = (async () => {
        const res = await fetch(`us_history.json?v=${cacheBuster}`);
        if (!res.ok) throw new Error(`Failed to fetch price history (${res.status})`);
        const priceData = await res.json();

        Object.keys(priceData).sort().forEach(ts => {
            const d = parseScraperTimestamp(ts) || new Date(ts.replace(/-/g, '/'));
            const dayStr = d.toLocaleDateString();

            for (const stateCode in priceData[ts]) {
                for (const cityName in priceData[ts][stateCode]) {
                    const key = `${stateCode}_${cityName}`;
                    if (!globalHistory[key]) globalHistory[key] = [];

                    const [rRaw, pRaw, dRaw] = extractGradePrices(priceData[ts][stateCode][cityName]);
                    globalHistory[key].push({
                        rawDate: d,
                        dayStr,
                        reg: getValidPrice(rRaw),
                        prem: getValidPrice(pRaw),
                        diesel: getValidPrice(dRaw)
                    });
                }
            }
        });

        historyLoaded = true;
    })().catch(err => {
        historyLoadPromise = null;
        throw err;
    });

    return historyLoadPromise;
}

function showChartMessage(msg, isError = false) {
    const chartContainer = document.querySelector('.chart-container');
    if (!chartContainer) return;
    chartContainer.innerHTML = `<p class="empty-msg${isError ? ' is-error' : ''}">${escapeHtml(msg)}</p>`;
}

function showChartSkeleton() {
    const chartContainer = document.querySelector('.chart-container');
    if (!chartContainer) return;
    chartContainer.innerHTML = `<div class="skeleton chart-skeleton" role="status"><span class="sr-only">Loading price history…</span></div>`;
}

function showChartError(stateCode, city) {
    const chartContainer = document.querySelector('.chart-container');
    if (!chartContainer) return;
    chartContainer.innerHTML = `
        <div class="empty-state error-state" role="alert">
            <div class="empty-state-icon is-danger">${icon('alert', 26)}</div>
            <h3>Couldn't load price history</h3>
            <p>${navigator.onLine === false ? 'You appear to be offline.' : 'Something went wrong.'} Please try again.</p>
            <button type="button" class="btn btn-primary" data-action="history" data-state="${escapeHtml(stateCode)}" data-city="${escapeHtml(city)}">${icon('refresh', 16)} Try again</button>
        </div>`;
    chartContainer.querySelector('button')?.focus();
}

// Turn change-only entries into one point per day (last known price carried forward).
// `points` must be sorted ascending by rawDate. Days before the first known price are skipped.
function expandToDaily(points, start, end) {
    const out = [];
    let idx = 0;
    let last = null;
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());

    // Advance through points that occurred before `start` to establish the baseline price
    // as of the start date without flagging those earlier changes on day 0.
    while (idx < points.length && points[idx].rawDate < d) {
        last = points[idx++];
    }

    for (; d <= endDay; d.setDate(d.getDate() + 1)) {
        const nextDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        const changed = { reg: false, prem: false, diesel: false };

        while (idx < points.length && points[idx].rawDate < nextDay) {
            const current = points[idx++];
            if (last) {
                if (current.reg !== last.reg) changed.reg = true;
                if (current.prem !== last.prem) changed.prem = true;
                if (current.diesel !== last.diesel) changed.diesel = true;
            } else {
                // First appearance in dataset
                if (current.reg != null) changed.reg = true;
                if (current.prem != null) changed.prem = true;
                if (current.diesel != null) changed.diesel = true;
            }
            last = current;
        }

        if (last) {
            out.push({
                rawDate: new Date(d),
                reg: last.reg,
                prem: last.prem,
                diesel: last.diesel,
                changed
            });
        }
    }
    return out;
}

export function renderRangeControls() {
    let controls = document.getElementById('historyRangeControls');
    const chartContainer = document.querySelector('.chart-container');
    if (!chartContainer) return;

    if (!controls) {
        controls = document.createElement('div');
        controls.id = 'historyRangeControls';
        controls.className = 'history-range-controls';
        chartContainer.parentNode.insertBefore(controls, chartContainer);
    }

    controls.innerHTML = HISTORY_RANGE_OPTIONS.map(opt => {
        const activeClass = state.historyRangeDays === opt.days ? 'active' : '';
        return `<button type="button" class="history-range-btn ${activeClass}" data-action="set-history-range" data-days="${opt.days}">${opt.label}</button>`;
    }).join('');
}

export function setHistoryRange(days) {
    const numDays = parseInt(days, 10);
    saveHistoryRangeDays(isNaN(numDays) ? 30 : numDays);
    renderRangeControls();
    if (currentModalState && currentModalCity) {
        renderPriceChart(currentModalState, currentModalCity);
    }
}

export async function openHistoryModal(stateCode, city) {
    currentModalState = stateCode;
    currentModalCity = city;

    const modal = document.getElementById('chartModal');
    const title = document.getElementById('chartTitle');
    if (modal && !modal.classList.contains('active')) {
        lastFocusedBeforeModal = document.activeElement;
    }
    if (modal) modal.classList.add('active');
    if (title) title.innerText = `Price history: ${city}, ${stateCode}`;

    renderRangeControls();
    document.querySelector('#chartModal .modal-close')?.focus();

    if (!historyLoaded) {
        showChartSkeleton();
        try {
            await ensureHistoryLoaded();
        } catch (e) {
            console.error('Error loading price history:', e);
            showChartError(stateCode, city);
            return;
        }
    }

    renderPriceChart(stateCode, city);
}

export function renderPriceChart(stateCode, city) {
    const key = `${stateCode}_${city}`;
    const chartContainer = document.querySelector('.chart-container');
    const history = globalHistory[key];

    if (!history || history.length === 0) {
        showChartMessage(`No price history available for ${city}, ${stateCode}.`);
        return;
    }

    if (!document.getElementById('priceChart')) {
        chartContainer.innerHTML = `<canvas id="priceChart"></canvas>`;
    }

    // Keep only the last entry per calendar day
    let dedupedHistory = [];
    const seenDates = new Set();
    for (let i = history.length - 1; i >= 0; i--) {
        if (!seenDates.has(history[i].dayStr)) {
            seenDates.add(history[i].dayStr);
            dedupedHistory.unshift(history[i]);
        }
    }

    const now = state.latestTimestamp ? (parseScraperTimestamp(state.latestTimestamp) || new Date()) : new Date();

    // Expand change-only entries into one point per day. Prices from before the
    // range start are carried forward automatically, and the series always
    // extends through today.
    const start = state.historyRangeDays > 0
        ? new Date(now.getTime() - state.historyRangeDays * 86400 * 1000)
        : dedupedHistory[0].rawDate;

    dedupedHistory = expandToDaily(dedupedHistory, start, now);

    if (dedupedHistory.length === 0) {
        showChartMessage(`No price history available for ${city}, ${stateCode} in this range.`);
        return;
    }

    const showAllDots = dedupedHistory.length <= SHOW_ALL_DOTS_MAX_POINTS;
    // Chart.js draws on a canvas, so it reads the design tokens instead of inheriting CSS.
    const css = getComputedStyle(document.body);
    const token = name => css.getPropertyValue(name).trim();
    const surfaceColor = token('--surface');

    const labels = dedupedHistory.map(h => h.rawDate);
    const datasets = GRADE_KEYS
        .map(g => {
            const info = GRADE_INFO[g];
            const data = dedupedHistory.map(h => h[info.histKey] === Infinity ? null : h[info.histKey]);
            // Solid dot where this grade's price actually changed on that day.
            // Hollow ring (matching background surface) where price held steady.
            const changed = dedupedHistory.map(h => Boolean(h.changed?.[info.histKey]));
            return {
                grade: g,
                label: info.label,
                data,
                changed,
                borderColor: info.color,
                backgroundColor: info.color,
                // 'before' in Chart.js holds the previous value horizontally across the day,
                // then steps vertically upon reaching the date coordinate.
                stepped: 'before',
                pointBackgroundColor: changed.map(c => (c ? info.color : surfaceColor)),
                pointBorderColor: info.color,
                pointRadius: changed.map(c => (c ? 4 : showAllDots ? 2.5 : 0)),
                pointHoverRadius: 6,
                spanGaps: true
            };
        })
        .filter(ds => ds.grade !== 'diesel' || ds.data.some(v => v !== null));

    const textColor = token('--text-muted');
    const gridColor = token('--border');

    const ctx = document.getElementById('priceChart').getContext('2d');
    if (priceChartInstance) priceChartInstance.destroy();

    priceChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: prefersReducedMotion() ? false : undefined,
            // Hover anywhere along the x-axis to see every grade's price for that day
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: textColor, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 5, padding: 16 } },
                tooltip: {
                    callbacks: {
                        label: context => {
                            if (context.raw === null || context.raw === undefined) return `${context.dataset.label}: n/a`;
                            return `${context.dataset.label}: $${context.raw.toFixed(2)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        tooltipFormat: 'MMM d, yyyy',
                        displayFormats: { month: 'MMM yyyy' }
                    },
                    ticks: { color: textColor },
                    grid: { color: gridColor }
                },
                y: {
                    grace: '5%', // keeps flat lines from hugging the chart edges
                    ticks: { color: textColor, callback: value => `$${value.toFixed(2)}` },
                    grid: { color: gridColor }
                }
            }
        }
    });
}

export function isChartModalOpen() {
    return document.getElementById('chartModal')?.classList.contains('active') || false;
}

export function refreshChartTheme() {
    if (isChartModalOpen() && currentModalState && currentModalCity) {
        renderPriceChart(currentModalState, currentModalCity);
    }
}

export function closeHistoryModal() {
    const modal = document.getElementById('chartModal');
    const wasOpen = modal?.classList.contains('active');
    modal?.classList.remove('active');
    if (wasOpen && lastFocusedBeforeModal && document.contains(lastFocusedBeforeModal)) {
        lastFocusedBeforeModal.focus();
    }
    lastFocusedBeforeModal = null;
}

// Keeps Tab / Shift+Tab inside the price-history modal while it is open.
export function trapModalFocus(e) {
    return isChartModalOpen() && trapFocus(e, document.getElementById('chartModal'));
}
